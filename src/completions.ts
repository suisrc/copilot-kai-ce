/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildKaiCompletionRequest, streamKaiCompletions } from './client';
import { resolveSecret } from './config';
import { countTextTokens } from './tokenizer';
import { KaiInlineCompletionConfig, KaiInlineCompletionModelConfig } from './types';

/**
 * 内联补全（inline completion / ghost text）Provider。
 *
 * 整体参考 VS Code Copilot 的补全实现：
 * - `extensions/copilot/src/extension/completions-core/vscode-node/lib/src/openai/fetch.ts`（FIM prompt+suffix 请求）
 * - `extensions/copilot/src/extension/completions-core/vscode-node/lib/src/prompt/prompt.ts`（prefix/suffix 与 isFimEnabled）
 *
 * 与 Copilot 的差异：Copilot 依赖其私有 CAPI 端点与 token 源，本实现直接 `fetch`
 * 用户配置的全地址 FIM 端点（如 DeepSeek `https://api.deepseek.com/beta/completions`），
 * 与 GitHub 认证/订阅完全解耦。
 *
 * 注意：`vscode.InlineCompletionItemProvider.provideInlineCompletionItems` 的 stable API
 * 只支持一次性返回 `InlineCompletionItem[]`，不支持 AsyncIterable 渐进式渲染（那是 Copilot
 * 内部私有通道），因此这里先流式累积完整补全文本，再一次性返回。
 */

/** 光标前缀默认 token 预算（参考 Copilot 的 maxPromptLength 保守取值） */
const DEFAULT_PREFIX_TOKENS = 2048;

/** 光标后缀默认 token 预算 */
const DEFAULT_SUFFIX_TOKENS = 512;

/** 补全默认最大输出 token 数 */
const DEFAULT_MAX_OUTPUT_TOKENS = 256;

/** 前缀最短有效字符数（过短时不触发，参考 Copilot 的 MIN_PROMPT_CHARS） */
const MIN_PROMPT_CHARS = 1;

/** 取文本末尾不超过 maxTokens 的完整行（保持代码结构完整） */
function trimPrefixByTokens(text: string, maxTokens: number): string {
	if (!text) {
		return '';
	}
	const lines = text.split('\n');
	const result: string[] = [];
	let tokens = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const lineTokens = countTextTokens(lines[i]) + 1; // +1 换行符
		if (tokens + lineTokens > maxTokens && result.length > 0) {
			break;
		}
		result.unshift(lines[i]);
		tokens += lineTokens;
	}
	return result.join('\n');
}

/** 取文本开头不超过 maxTokens 的完整行 */
function trimSuffixByTokens(text: string, maxTokens: number): string {
	if (!text) {
		return '';
	}
	const lines = text.split('\n');
	const result: string[] = [];
	let tokens = 0;
	for (const line of lines) {
		const lineTokens = countTextTokens(line) + 1;
		if (tokens + lineTokens > maxTokens) {
			break;
		}
		result.push(line);
		tokens += lineTokens;
	}
	return result.join('\n');
}

/** 渲染提示词模板，支持 `{prefix}` / `{suffix}` / `{languageId}` 占位符 */
function renderTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

export class KaiInlineCompletionProvider implements vscode.InlineCompletionItemProvider {

	private readonly _config: KaiInlineCompletionConfig;

	constructor(config: KaiInlineCompletionConfig) {
		this._config = config;
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[]> {
		try {
			const { prefix, suffix } = this.extractContext(document, position);
			if (prefix.trim().length < MIN_PROMPT_CHARS) {
				return [];
			}

			const completion = await this.fetchCompletion(document, prefix, suffix, token);
			if (!completion) {
				return [];
			}

			// 插入式 range：在光标处插入补全文本，不覆盖用户已输入内容。
			// 光标后已有内容（suffix）时，插入后与 suffix 自然衔接。
			const range = new vscode.Range(position, position);
			return [new vscode.InlineCompletionItem(completion, range)];
		} catch (e) {
			// 补全请求失败应静默，不打扰用户（参考 Copilot 对 provider 异常的处理）
			console.debug('[Kai CE] inline completion failed:', e);
			return [];
		}
	}

	/** 提取光标前后的上下文（按 token 预算裁剪） */
	private extractContext(document: vscode.TextDocument, position: vscode.Position): { prefix: string; suffix: string } {
		const prefixText = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
		const suffixText = document.getText(new vscode.Range(position, document.lineAt(document.lineCount - 1).range.end));
		return {
			prefix: trimPrefixByTokens(prefixText, DEFAULT_PREFIX_TOKENS),
			suffix: trimSuffixByTokens(suffixText, DEFAULT_SUFFIX_TOKENS),
		};
	}

	/** 请求 FIM 端点并流式累积完整补全文本 */
	private async fetchCompletion(
		document: vscode.TextDocument,
		prefix: string,
		suffix: string,
		token: vscode.CancellationToken,
	): Promise<string | undefined> {
		const model = this._config.model;
		if (!model?.id) {
			return undefined;
		}
		const url = model.url;
		if (!url) {
			console.debug('[Kai CE] inline completion: model url not configured');
			return undefined;
		}

		// prompt 模板：缺省时用标准 FIM（prompt=前缀，suffix=后缀）；
		// 用户自定义模板时，将 prefix/suffix/languageId 渲染进 prompt 字段，suffix 字段置空。
		const languageId = document.languageId;
		const renderedPrompt = this._config.prompt
			? renderTemplate(this._config.prompt, { prefix, suffix, languageId })
			: prefix;
		const requestSuffix = this._config.prompt ? '' : suffix;

		// 透传默认推理努力级别（若配置了非空值）
		const modelOptions: Record<string, unknown> = { ...model.modelOptions };
		if (model.defaultReasoningEffort) {
			modelOptions['reasoning_effort'] = model.defaultReasoningEffort;
		}

		const body = buildKaiCompletionRequest(model.id, renderedPrompt, requestSuffix, {
			maxOutputTokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
			modelOptions,
		});

		const headers = this.buildHeaders(model);

		const abortController = new AbortController();
		const listener = token.onCancellationRequested(() => abortController.abort());
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: abortController.signal,
			});
			return await this.accumulateStream(response);
		} finally {
			listener.dispose();
		}
	}

	/** 构造请求头：默认 Bearer 鉴权 + 用户自定义头覆盖（支持 `${apiKey}` 插值） */
	private buildHeaders(model: KaiInlineCompletionModelConfig): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		const apiKey = resolveSecret(model.apiKey);
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}

		for (const [key, value] of Object.entries(model.requestHeaders ?? {})) {
			// 用户自定义头覆盖默认头（大小写不敏感）
			const lowerKey = key.toLowerCase();
			for (const existing of Object.keys(headers)) {
				if (existing.toLowerCase() === lowerKey) {
					delete headers[existing];
				}
			}
			headers[key] = apiKey ? value.split('${apiKey}').join(apiKey) : value;
		}

		return headers;
	}

	/** 流式累积补全文本 */
	private async accumulateStream(response: Response): Promise<string | undefined> {
		if (!response.ok) {
			const errorText = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status} ${response.statusText}${errorText ? `: ${errorText.slice(0, 200)}` : ''}`);
		}

		let text = '';
		for await (const chunk of streamKaiCompletions(response)) {
			if (chunk.error?.message) {
				throw new Error(`模型请求失败：${chunk.error.message}`);
			}
			const delta = chunk.choices?.[0]?.text;
			if (delta) {
				text += delta;
			}
		}
		return text;
	}
}
