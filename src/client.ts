/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApiType, KaiModelConfig, KaiProviderGroup } from './types';

/**
 * 模型网关客户端：URL 解析、请求构造与 SSE 流式解析。
 *
 * 支持三种协议（与 VS Code Copilot 的 customendpoint 一致）：
 * - `chat-completions`：OpenAI Chat Completions API
 * - `responses`：OpenAI Responses API
 * - `messages`：Anthropic Messages API
 *
 * URL 解析逻辑参考 VS Code Copilot 扩展的 `customEndpointProvider.ts`：
 * - 显式 API 路径（`/chat/completions`、`/responses`、`/messages`）直接使用
 * - 已含 `/vN` 版本号的 URL 直接追加 API 路径
 * - 其余情况拼接 `/v1` + API 路径
 */

//#region URL 解析

export function hasExplicitApiPath(url: string): boolean {
	return url.includes('/responses') || url.includes('/chat/completions') || url.includes('/messages');
}

function apiTypeToPath(apiType: ApiType | undefined): string {
	switch (apiType) {
		case 'responses':
			return '/responses';
		case 'messages':
			return '/messages';
		case 'chat-completions':
		default:
			return '/chat/completions';
	}
}

export function inferApiTypeFromUrl(url: string): ApiType {
	if (url.includes('/messages')) {
		return 'messages';
	}
	if (url.includes('/responses')) {
		return 'responses';
	}
	return 'chat-completions';
}

/**
 * 解析出最终的完整端点 URL。
 * @param url 用户配置的 Base URL（可能已含显式 API 路径）
 * @param apiType 期望的 API 类型
 */
export function resolveCustomEndpointUrl(url: string, apiType?: ApiType): string {
	// 已传完整的 URL（含显式 API 路径）则直接使用
	if (hasExplicitApiPath(url)) {
		return url;
	}

	// 去掉末尾斜杠
	if (url.endsWith('/')) {
		url = url.slice(0, -1);
	}

	const defaultApiPath = apiTypeToPath(apiType);

	// 检查 URL 是否已含版本模式（/v1、/v2 等）
	const versionPattern = /\/v\d+$/;
	if (versionPattern.test(url)) {
		return `${url}${defaultApiPath}`;
	}

	// 标准 OpenAI 兼容端点：追加 /v1 + API 路径
	return `${url}/v1${defaultApiPath}`;
}

/** 解析模型的请求 URL 与 API 类型（模型级覆盖分组级，再回退 URL 推断） */
export function resolveModelEndpoint(model: KaiModelConfig, group: KaiProviderGroup): { url: string; apiType: ApiType } {
	const baseUrl = model.url ?? group.url;
	if (!baseUrl) {
		throw new Error(`Model ${model.id} and group ${group.name} have no url configured`);
	}
	const apiType = model.apiType ?? group.apiType ?? inferApiTypeFromUrl(baseUrl);
	return { url: resolveCustomEndpointUrl(baseUrl, apiType), apiType };
}

//#endregion

//#region 通用 SSE 解析（同时支持纯 data 与 event + data 两种格式）

export interface SSEEvent {
	/** SSE `event:` 字段（Responses/Messages API 使用）；纯 data 流中为 undefined */
	event?: string;
	/** 解析后的 JSON 数据 */
	data: unknown;
}

/**
 * 通用 SSE 解析器。同时处理：
 * - chat-completions：纯 `data: {...}`，以 `data: [DONE]` 结束
 * - responses / messages：`event: xxx` + `data: {...}`
 */
export async function* streamSSE(response: Response): AsyncGenerator<SSEEvent> {
	if (!response.ok) {
		const errorText = await response.text().catch(() => '');
		throw new Error(`HTTP ${response.status} ${response.statusText}${errorText ? `: ${errorText.slice(0, 500)}` : ''}`);
	}
	if (!response.body) {
		throw new Error('Response body is empty');
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let currentEvent: string | undefined;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed === '') {
					continue;
				}
				if (trimmed.startsWith('event:')) {
					currentEvent = trimmed.slice(6).trim();
					continue;
				}
				if (!trimmed.startsWith('data:')) {
					continue;
				}
				const data = trimmed.slice(5).trim();
				if (data === '[DONE]') {
					return;
				}
				try {
					yield { event: currentEvent, data: JSON.parse(data) };
				} catch {
					// 忽略无法解析的行（如心跳、注释）
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

//#endregion

//#region OpenAI Chat Completions

export interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: unknown;
	name?: string;
	tool_call_id?: string;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
}

export interface OpenAITool {
	type: 'function';
	function: { name: string; description?: string; parameters?: object };
}

export interface ChatCompletionRequest {
	model: string;
	messages: OpenAIMessage[];
	stream: boolean;
	tools?: OpenAITool[];
	tool_choice?: string | object;
	[key: string]: unknown;
}

/** 构造 chat/completions 请求体 */
export function buildChatCompletionRequest(modelId: string, messages: OpenAIMessage[], opts: { tools?: OpenAITool[]; toolChoice?: string | object; modelOptions?: Record<string, unknown> }): ChatCompletionRequest {
	const body: ChatCompletionRequest = {
		model: modelId,
		messages,
		stream: true,
		...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
		...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
		...opts.modelOptions,
	};
	return body;
}

export interface ChatCompletionChunk {
	id?: string;
	choices?: Array<{
		delta?: {
			content?: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	error?: { message?: string; type?: string };
}

/** 仅解析 chat/completions 数据块（对通用解析器的封装，忽略 event 字段） */
export async function* streamChatCompletions(response: Response): AsyncGenerator<ChatCompletionChunk> {
	for await (const sseEvent of streamSSE(response)) {
		yield sseEvent.data as ChatCompletionChunk;
	}
}

//#endregion

//#region OpenAI Responses API

/** Responses API 的 input 项 */
export type ResponsesInputItem =
	| { type: 'message'; role: 'system' | 'user' | 'assistant'; content: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail?: string }> }
	| { type: 'function_call'; call_id: string; name: string; arguments: string }
	| { type: 'function_call_output'; call_id: string; output: string };

export interface ResponsesTool {
	type: 'function';
	name: string;
	description?: string;
	parameters?: object;
	strict?: boolean;
}

export interface ResponsesRequest {
	model: string;
	input: ResponsesInputItem[];
	stream: boolean;
	tools?: ResponsesTool[];
	tool_choice?: string | object;
	[key: string]: unknown;
}

/** 构造 /responses 请求体 */
export function buildResponsesRequest(modelId: string, input: ResponsesInputItem[], opts: { tools?: ResponsesTool[]; toolChoice?: string | object; modelOptions?: Record<string, unknown> }): ResponsesRequest {
	const body: ResponsesRequest = {
		model: modelId,
		input,
		stream: true,
		...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
		...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
		...opts.modelOptions,
	};
	return body;
}

//#endregion

//#region Anthropic Messages API

export interface AnthropicTextBlock { type: 'text'; text: string }
export interface AnthropicImageBlock { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }
export interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: object }
export interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string | AnthropicTextBlock[] }
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export interface AnthropicMessage { role: 'user' | 'assistant'; content: AnthropicContentBlock[] }
export interface AnthropicTool { name: string; description?: string; input_schema?: object }

export interface MessagesRequest {
	model: string;
	messages: AnthropicMessage[];
	system?: string | AnthropicTextBlock[];
	max_tokens: number;
	stream: boolean;
	tools?: AnthropicTool[];
	tool_choice?: string | object;
	[key: string]: unknown;
}

/** 构造 /messages（Anthropic）请求体 */
export function buildMessagesRequest(modelId: string, messages: AnthropicMessage[], systemText: string | undefined, opts: { tools?: AnthropicTool[]; toolChoice?: string | object; modelOptions?: Record<string, unknown>; maxOutputTokens?: number }): MessagesRequest {
	const body: MessagesRequest = {
		model: modelId,
		messages,
		max_tokens: opts.maxOutputTokens ?? 8192,
		stream: true,
		...(systemText ? { system: systemText } : {}),
		...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
		...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
		...opts.modelOptions,
	};
	return body;
}

//#endregion

//#region FIM（Fill-in-the-Middle）补全请求

/**
 * FIM 补全请求体（参考 Copilot 的 `CompletionRequest` 与 OpenAI `/completions`）。
 *
 * 与 chat-completions 不同，FIM 用 `prompt`（光标前文本）+ `suffix`（光标后文本）
 * 两个字段，模型填充中间缺失部分。DeepSeek `https://api.deepseek.com/beta/completions`
 * 即为该端点。
 */
export interface KaiCompletionRequest {
	model: string;
	/** 光标前的文本（前缀） */
	prompt: string;
	/** 光标后的文本（后缀） */
	suffix: string;
	stream: boolean;
	max_tokens?: number;
	[key: string]: unknown;
}

/** 构造 FIM /completions 请求体 */
export function buildKaiCompletionRequest(modelId: string, prompt: string, suffix: string, opts: { maxOutputTokens?: number; modelOptions?: Record<string, unknown> }): KaiCompletionRequest {
	const body: KaiCompletionRequest = {
		model: modelId,
		prompt,
		suffix,
		stream: true,
		...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {}),
		...opts.modelOptions,
	};
	return body;
}

/** FIM /completions 流式数据块（OpenAI completions 兼容格式） */
export interface KaiCompletionChunk {
	id?: string;
	choices?: Array<{
		/** 增量文本 */
		text?: string;
		index?: number;
		finish_reason?: string | null;
	}>;
	error?: { message?: string; type?: string };
}

/** 仅解析 FIM /completions 数据块（复用通用 SSE 解析器） */
export async function* streamKaiCompletions(response: Response): AsyncGenerator<KaiCompletionChunk> {
	for await (const sseEvent of streamSSE(response)) {
		yield sseEvent.data as KaiCompletionChunk;
	}
}

//#endregion
