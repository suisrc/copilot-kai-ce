/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	AnthropicContentBlock,
	AnthropicMessage,
	AnthropicTool,
	buildChatCompletionRequest,
	buildMessagesRequest,
	buildResponsesRequest,
	inferApiTypeFromUrl,
	OpenAIMessage,
	OpenAITool,
	ResponsesInputItem,
	ResponsesTool,
	resolveCustomEndpointUrl,
	streamChatCompletions,
	streamSSE,
} from './client';
import { countMessageTokens, countTextTokens } from './tokenizer';
import { getProviderGroups, resolveSecret } from './config';
import { ApiType, KaiModelConfig, PROVIDER_VENDOR } from './types';

/**
 * 模型信息（在 VS Code 契约之上附加请求阶段所需的内部字段）。
 * 附加字段仅在本扩展内部使用，不会被 VS Code 透传给其他扩展。
 */
export interface KaiModelInformation extends vscode.LanguageModelChatInformation {
	/** 内部：该模型所属分组名（用于错误提示） */
	readonly groupName: string;
	/** 内部：完整端点 URL（含 API 路径） */
	readonly endpointUrl: string;
	/** 内部：API 类型 */
	readonly apiType: ApiType;
	/** 内部：API Key（明文，来自分组配置） */
	readonly apiKey?: string;
	/** 内部：附加请求头 */
	readonly requestHeaders?: Record<string, string>;
	/** 内部：透传模型参数 */
	readonly modelOptions?: Record<string, unknown>;
	/** 内部：支持的推理努力级别 */
	readonly supportsReasoningEffort?: string[];
	/** 内部：默认推理努力级别 */
	readonly defaultReasoningEffort?: string;
	/** 内部：推理努力级别写入请求体的格式 */
	readonly reasoningEffortFormat?: 'chat-completions' | 'responses' | 'messages';
	/** 内部：编辑工具偏好（proposed API chatProvider） */
	readonly editTools?: string[];
	/** 内部：是否启用零数据保留 ZDR（proposed API chatProvider） */
	readonly zeroDataRetentionEnabled?: boolean;
}

/** 解析模型 token 限制（与 customendpoint 的 resolveModelTokenLimits 逻辑一致） */
function resolveTokenLimits(model: KaiModelConfig): { maxInputTokens: number; maxOutputTokens: number } {
	const contextWindow = model.contextWindow ?? ((model.maxInputTokens ?? 0) + (model.maxOutputTokens ?? 8192));
	const maxOutputTokens = Math.min(model.maxOutputTokens ?? 8192, contextWindow);
	const remainingInputBudget = Math.max(0, contextWindow - maxOutputTokens);
	const maxInputTokens = Math.min(model.maxInputTokens ?? remainingInputBudget, remainingInputBudget);
	return { maxInputTokens, maxOutputTokens };
}

//#region 消息 / 工具转换

function serializeToolResult(content: ReadonlyArray<unknown>): string {
	const texts: string[] = [];
	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			texts.push(part.value);
		} else if (part instanceof vscode.LanguageModelDataPart) {
			texts.push(new TextDecoder().decode(part.data));
		} else if (part && typeof part === 'object' && 'value' in part) {
			const value = (part as { value: unknown }).value;
			texts.push(typeof value === 'string' ? value : JSON.stringify(value));
		}
	}
	return texts.join('\n');
}

function bytesToBase64(data: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < data.length; i += chunkSize) {
		binary += String.fromCharCode(...data.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/** 将 VS Code 的请求消息转换为 OpenAI chat/completions 消息格式 */
function toOpenAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];

	for (const message of messages) {
		// System = 3 属于 proposed API (languageModelSystem)，stable API 中仅有 User(1)/Assistant(2)
		// 用数值比较避免声明 proposed API
		if ((message.role as number) === 3) {
			// System 消息转为 OpenAI 的 role: 'system'
			const textParts: string[] = [];
			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				}
			}
			if (textParts.length > 0) {
				result.push({
					role: 'system',
					content: textParts.join(''),
				});
			}
		} else if (message.role === vscode.LanguageModelChatMessageRole.User) {
			const textParts: string[] = [];
			const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];

			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelToolResultPart) {
					// 工具结果拆分为独立的 role: 'tool' 消息
					result.push({
						role: 'tool',
						tool_call_id: part.callId,
						content: serializeToolResult(part.content),
					});
				} else if (part instanceof vscode.LanguageModelDataPart) {
					imageParts.push({
						type: 'image_url',
						image_url: { url: `data:${part.mimeType};base64,${bytesToBase64(part.data)}` },
					});
				}
			}

			if (textParts.length > 0 || imageParts.length > 0) {
				result.push({
					role: 'user',
					name: message.name || undefined,
					content: imageParts.length > 0
						? [...imageParts, ...textParts.map(t => ({ type: 'text', text: t }))]
						: textParts.join(''),
				});
			}
		} else if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const textParts: string[] = [];
			const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = [];

			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push({
						id: part.callId,
						type: 'function',
						function: { name: part.name, arguments: JSON.stringify(part.input) },
					});
				}
			}

			result.push({
				role: 'assistant',
				content: textParts.join(''),
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		}
	}

	return result;
}

/**
 * 递归清理 JSON Schema 中的 null 值，确保 schema 符合 API 要求。
 * 参考 copilot 的 toolSchemaNormalizer.ts 和 oai-compatible-copilot 的 jsonSchemaToGeminiSchema。
 *
 * 处理规则：
 * - additionalProperties: null → true（OpenAI/DeepSeek 要求 boolean 或 object）
 * - 其他 null 值属性 → 删除（API 不接受 null）
 * - 递归处理 properties、items、anyOf、allOf、oneOf 等嵌套结构
 * - 确保顶层有 type: 'object' 和 properties（参考 copilot 的 fnRules）
 */
function sanitizeSchema(schema: unknown): Record<string, unknown> {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
		return { type: 'object', properties: {} };
	}

	const result = sanitizeSchemaNode(schema);
	// 确保顶层是 object 类型且有 properties（参考 copilot 的 fnRules）
	if (!result.type) {
		result.type = 'object';
	}
	if (result.type === 'object' && !result.properties) {
		result.properties = {};
	}
	return result;
}

function sanitizeSchemaNode(schema: unknown): Record<string, unknown> {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
		return {};
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
		if (value === null) {
			// additionalProperties: null → true（API 要求 boolean 或 object）
			if (key === 'additionalProperties') {
				result[key] = true;
			}
			// 其他 null 值属性直接跳过
			continue;
		}
		if (typeof value === 'object' && !Array.isArray(value)) {
			result[key] = sanitizeSchemaNode(value);
		} else if (Array.isArray(value)) {
			// 递归处理数组中的对象元素（如 anyOf、allOf、oneOf、items 数组）
			result[key] = value.map(item =>
				item && typeof item === 'object' && !Array.isArray(item) ? sanitizeSchemaNode(item) : item
			);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function toOpenAITools(tools: readonly vscode.LanguageModelChatTool[]): OpenAITool[] {
	return tools.map(t => ({
		type: 'function' as const,
		function: {
			name: t.name,
			...(t.description ? { description: t.description } : {}),
			parameters: sanitizeSchema(t.inputSchema),
		},
	}));
}

/** 将 VS Code 的请求消息转换为 Responses API 的 input 项 */
function toResponsesInput(messages: readonly vscode.LanguageModelChatRequestMessage[]): ResponsesInputItem[] {
	const result: ResponsesInputItem[] = [];

	for (const message of messages) {
		// System = 3 属于 proposed API (languageModelSystem)，stable API 中仅有 User(1)/Assistant(2)
		// 用数值比较避免声明 proposed API
		if ((message.role as number) === 3) {
			// System 消息转为 Responses API 的 role: 'system'
			const textParts: string[] = [];
			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				}
			}
			if (textParts.length > 0) {
				result.push({
					type: 'message',
					role: 'system',
					content: textParts.map(t => ({ type: 'input_text' as const, text: t })),
				});
			}
		} else if (message.role === vscode.LanguageModelChatMessageRole.User) {
			const textParts: string[] = [];
			const imageParts: Array<{ type: 'input_image'; image_url: string; detail?: string }> = [];

			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelToolResultPart) {
					result.push({
						type: 'function_call_output',
						call_id: part.callId,
						output: serializeToolResult(part.content),
					});
				} else if (part instanceof vscode.LanguageModelDataPart) {
					imageParts.push({
						type: 'input_image',
						image_url: `data:${part.mimeType};base64,${bytesToBase64(part.data)}`,
					});
				}
			}

			if (textParts.length > 0 || imageParts.length > 0) {
				const content: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail?: string }> = [
					...imageParts,
					...textParts.map(t => ({ type: 'input_text' as const, text: t })),
				];
				result.push({ type: 'message', role: 'user', content });
			}
		} else if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const textParts: string[] = [];

			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					result.push({
						type: 'function_call',
						call_id: part.callId,
						name: part.name,
						arguments: JSON.stringify(part.input),
					});
				}
			}

			if (textParts.length > 0) {
				result.push({
					type: 'message',
					role: 'assistant',
					content: textParts.map(t => ({ type: 'input_text' as const, text: t })),
				});
			}
		}
	}

	return result;
}

function toResponsesTools(tools: readonly vscode.LanguageModelChatTool[]): ResponsesTool[] {
	return tools.map(t => ({
		type: 'function' as const,
		name: t.name,
		...(t.description ? { description: t.description } : {}),
		parameters: sanitizeSchema(t.inputSchema),
		strict: false,
	}));
}

/** 将 VS Code 的请求消息转换为 Anthropic Messages API 的消息 */
function toAnthropicMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): { messages: AnthropicMessage[]; systemText: string | undefined } {
	const result: AnthropicMessage[] = [];
	const systemParts: string[] = [];

	for (const message of messages) {
		if (message.role === vscode.LanguageModelChatMessageRole.User) {
			const content: AnthropicContentBlock[] = [];

			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					content.push({ type: 'text', text: part.value });
				} else if (part instanceof vscode.LanguageModelToolResultPart) {
					content.push({
						type: 'tool_result',
						tool_use_id: part.callId,
						content: serializeToolResult(part.content),
					});
				} else if (part instanceof vscode.LanguageModelDataPart) {
					content.push({
						type: 'image',
						source: {
							type: 'base64',
							data: bytesToBase64(part.data),
							media_type: part.mimeType,
						},
					});
				}
			}

			if (content.length > 0) {
				// 若上一条已是 user，合并 content（Anthropic 要求相邻同角色消息合并）
				const last = result.at(-1);
				if (last && last.role === 'user') {
					last.content.push(...content);
				} else {
					result.push({ role: 'user', content });
				}
			}
		} else if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const content: AnthropicContentBlock[] = [];

			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					content.push({ type: 'text', text: part.value });
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					content.push({
						type: 'tool_use',
						id: part.callId,
						name: part.name,
						input: part.input,
					});
				}
			}

			if (content.length > 0) {
				const last = result.at(-1);
				if (last && last.role === 'assistant') {
					last.content.push(...content);
				} else {
					result.push({ role: 'assistant', content });
				}
			}
		} else {
			// role === System：Anthropic 无 system 角色，提取为顶层 system 字段
			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					systemParts.push(part.value);
				}
			}
		}
	}

	return { messages: result, systemText: systemParts.length > 0 ? systemParts.join('\n') : undefined };
}

function toAnthropicTools(tools: readonly vscode.LanguageModelChatTool[]): AnthropicTool[] {
	return tools.map(t => ({
		name: t.name,
		...(t.description ? { description: t.description } : {}),
		input_schema: sanitizeSchema(t.inputSchema),
	}));
}

//#endregion

//#region 请求头安全过滤（参考 copilot 的 OpenAIEndpoint._sanitizeCustomHeaders）

/**
 * 禁止用户覆盖的请求头（安全 + 功能性原因）。
 * 参考 copilot 的 OpenAIEndpoint._reservedHeaders。
 * 注意：鉴权头（api-key、authorization）在 CustomEndpointOAIEndpoint 中被特意允许覆盖，
 * 此处同样允许——它们在 buildRequestHeaders 中单独处理。
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
	// Forbidden Request Headers (RFC)
	'accept-charset', 'accept-encoding', 'access-control-request-headers',
	'access-control-request-method', 'connection', 'content-length', 'cookie',
	'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'permissions-policy',
	'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'user-agent', 'via',
	// Forwarding & Routing
	'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
	// Others
	'content-type', 'openai-intent', 'x-github-api-version', 'x-initiator',
	'x-interaction-id', 'x-interaction-type', 'x-onbehalf-extension-id',
	'x-request-id', 'x-vscode-user-agent-library-version',
]);

/** RFC 7230 compliant header name pattern */
const VALID_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;

const MAX_HEADER_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 8192;
const MAX_CUSTOM_HEADER_COUNT = 20;

/**
 * 对用户自定义请求头做安全过滤。
 * 参考 copilot 的 OpenAIEndpoint._sanitizeCustomHeaders。
 * 鉴权头（api-key、authorization、x-api-key、x-goog-api-key、apikey）允许通过。
 */
function sanitizeCustomHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
	if (!headers) {
		return {};
	}

	const entries = Object.entries(headers);
	const sanitized: Record<string, string> = {};
	let processedCount = 0;

	for (const [rawKey, rawValue] of entries) {
		if (processedCount >= MAX_CUSTOM_HEADER_COUNT) {
			break;
		}

		const key = rawKey.trim();
		if (!key || key.length > MAX_HEADER_NAME_LENGTH) {
			continue;
		}
		if (!VALID_HEADER_NAME_PATTERN.test(key)) {
			continue;
		}

		const lowerKey = key.toLowerCase();

		// 鉴权头允许通过（在 buildRequestHeaders 中单独处理覆盖逻辑）
		const isAuthHeader = lowerKey === 'authorization' || lowerKey === 'api-key'
			|| lowerKey === 'x-api-key' || lowerKey === 'x-goog-api-key' || lowerKey === 'apikey';
		if (!isAuthHeader && RESERVED_HEADERS.has(lowerKey)) {
			continue;
		}

		// 禁止 proxy-* / sec-* 模式
		if (lowerKey.startsWith('proxy-') || lowerKey.startsWith('sec-')) {
			continue;
		}

		// 禁止 X-HTTP-Method* 中的危险方法
		if (lowerKey === 'x-http-method' || lowerKey === 'x-http-method-override' || lowerKey === 'x-method-override') {
			const forbiddenMethods = ['connect', 'trace', 'track'];
			if (typeof rawValue === 'string' && forbiddenMethods.includes(rawValue.toLowerCase().trim())) {
				continue;
			}
		}

		if (typeof rawValue !== 'string') {
			continue;
		}
		const trimmedValue = rawValue.trim();
		if (trimmedValue.length > MAX_HEADER_VALUE_LENGTH) {
			continue;
		}
		// 禁止控制字符（防止 HTTP header injection）
		if (/[\x00-\x1F\x7F]/.test(trimmedValue)) {
			continue;
		}
		// 禁止 Unicode 双向覆盖 / 零宽字符
		if (/[\u200B-\u200D\u202A-\u202E\uFEFF]/.test(trimmedValue)) {
			continue;
		}

		sanitized[key] = trimmedValue;
		processedCount++;
	}

	return sanitized;
}

//#endregion

export class KaiCustomEndpointProvider implements vscode.LanguageModelChatProvider<KaiModelInformation> {

	private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

	/** 配置变更时通知 VS Code 刷新模型列表 */
	notifyConfigurationChanged(): void {
		this._onDidChangeLanguageModelChatInformation.fire();
	}

	provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): vscode.ProviderResult<KaiModelInformation[]> {
		// 仅从 settings.json（kaicustomendpoint.models）读取模型配置。
		// 不使用 languageModelChatProviders contribution，避免 chatLanguageModels.json 重复。
		const groups = getProviderGroups();

		const infos: KaiModelInformation[] = [];

		for (const group of groups) {
			for (const model of group.models ?? []) {
				const limits = resolveTokenLimits(model);
				const apiType = model.apiType ?? group.apiType ?? inferApiTypeFromUrl(model.url ?? group.url ?? '');
				const endpointUrl = (model.url ?? group.url)
					? resolveCustomEndpointUrl(model.url ?? group.url ?? '', apiType)
					: '';

				infos.push({
					// VS Code 契约字段
					id: model.id,
					name: model.name ?? model.id,
					family: model.id,
					version: '1.0.0',
					maxInputTokens: limits.maxInputTokens,
					maxOutputTokens: limits.maxOutputTokens,
					capabilities: {
						toolCalling: !!model.toolCalling,
						imageInput: !!model.vision,
						// proposed API chatProvider：editTools 作为 hint 传给编辑器
						...(model.editTools ? { editTools: model.editTools } : {}),
					} as vscode.LanguageModelChatCapabilities,
					// proposed API chatProvider：configurationSchema 声明 Thinking Effort picker
					...(model.supportsReasoningEffort?.length ? {
						configurationSchema: {
							properties: {
								reasoningEffort: {
									type: 'string',
									title: 'Thinking Effort',
									enum: model.supportsReasoningEffort,
									...(model.defaultReasoningEffort && model.supportsReasoningEffort.includes(model.defaultReasoningEffort)
										? { default: model.defaultReasoningEffort }
										: {}),
									group: 'navigation',
								},
							},
						},
					} : {}),
					// detail 显示分组名，便于区分同供应商的多个分组
					detail: group.name,
					tooltip: `${model.name ?? model.id} 由 Kai CE（分组：${group.name}）提供。`,
					// 内部字段
					groupName: group.name,
					endpointUrl,
					apiType,
					apiKey: resolveSecret(group.apiKey),
					requestHeaders: model.requestHeaders,
					modelOptions: model.modelOptions,
					supportsReasoningEffort: model.supportsReasoningEffort,
					defaultReasoningEffort: model.defaultReasoningEffort,
					reasoningEffortFormat: model.reasoningEffortFormat,
					editTools: model.editTools,
					zeroDataRetentionEnabled: model.zeroDataRetentionEnabled,
				});
			}
		}

		return infos;
	}

	async provideLanguageModelChatResponse(
		model: KaiModelInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		if (!model.endpointUrl) {
			throw new Error(`模型 ${model.id}（分组 ${model.groupName}）未配置 url`);
		}

		// 构造请求头（按协议差异处理鉴权方式）
		const headers = this.buildRequestHeaders(model);

		// 合并请求级 modelOptions 与配置级 modelOptions，请求级优先
		// 参考 copilot 的 OpenAIEndpoint._applyConfiguredModelOptions
		const mergedModelOptions: Record<string, unknown> = { ...model.modelOptions };
		if (options.modelOptions) {
			for (const [key, value] of Object.entries(options.modelOptions)) {
				if (value !== undefined) {
					mergedModelOptions[key] = value;
				}
			}
		}

		// 构造请求体（按协议差异处理）
		const toolChoice: string | object | undefined = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : undefined;

		let body: object;
		switch (model.apiType) {
			case 'chat-completions': {
				const tools: OpenAITool[] | undefined = options.tools && options.tools.length > 0 ? toOpenAITools(options.tools) : undefined;
				body = buildChatCompletionRequest(model.id, toOpenAIMessages(messages), { tools, toolChoice, modelOptions: mergedModelOptions });
				break;
			}
			case 'responses': {
				const tools: ResponsesTool[] | undefined = options.tools && options.tools.length > 0 ? toResponsesTools(options.tools) : undefined;
				body = buildResponsesRequest(model.id, toResponsesInput(messages), { tools, toolChoice, modelOptions: mergedModelOptions });
				// ZDR：启用零数据保留时显式设 store: false（参考 copilot 的 createRequestBody）
				if (model.zeroDataRetentionEnabled) {
					(body as Record<string, unknown>).store = false;
				}
				break;
			}
			case 'messages': {
				const tools: AnthropicTool[] | undefined = options.tools && options.tools.length > 0 ? toAnthropicTools(options.tools) : undefined;
				const { messages: anthropicMessages, systemText } = toAnthropicMessages(messages);
				body = buildMessagesRequest(model.id, anthropicMessages, systemText, {
					tools,
					toolChoice,
					modelOptions: mergedModelOptions,
					maxOutputTokens: model.maxOutputTokens,
				});
				break;
			}
			default:
				throw new Error(`不支持的 API 类型：${model.apiType}`);
		}

		// 应用推理努力级别（参考 copilot 的 OpenAIEndpoint._applyReasoningEffort）
		// 优先使用 proposed API 的 modelConfiguration.reasoningEffort（picker 选择），
		// 回退到配置中的 defaultReasoningEffort
		this.applyReasoningEffort(body, model, options);

		// AbortSignal 桥接
		const abortController = new AbortController();
		const listener = token.onCancellationRequested(() => abortController.abort());

		try {
			const response = await fetch(model.endpointUrl, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: abortController.signal,
			});

			// 按协议分发流式解析
			switch (model.apiType) {
				case 'chat-completions':
					await this.processChatCompletionsStream(response, progress);
					break;
				case 'responses':
					await this.processResponsesStream(response, progress);
					break;
				case 'messages':
					await this.processMessagesStream(response, progress);
					break;
			}
		} finally {
			listener.dispose();
		}
	}

	/**
	 * 将推理努力级别写入请求体（参考 copilot 的 OpenAIEndpoint._applyReasoningEffort）。
	 * 优先使用 proposed API 的 modelConfiguration.reasoningEffort（picker 选择），
	 * 回退到配置中的 defaultReasoningEffort。
	 * - format 为 'chat-completions'：顶层 `reasoning_effort` 字符串
	 * - format 为 'responses'：嵌套 `reasoning.effort`
	 * - format 为 'messages'：`output_config.effort`
	 * - format 未设置时根据 model.apiType 推断
	 */
	private applyReasoningEffort(body: object, model: KaiModelInformation, options: vscode.ProvideLanguageModelChatResponseOptions): void {
		const supports = model.supportsReasoningEffort;
		if (!supports?.length) {
			return;
		}

		// proposed API chatProvider：从 modelConfiguration 读取 picker 选择值
		const modelConfig = (options as { modelConfiguration?: { reasoningEffort?: string } }).modelConfiguration;
		const pickerEffort = typeof modelConfig?.reasoningEffort === 'string' ? modelConfig.reasoningEffort : undefined;

		const effort = (pickerEffort && supports.includes(pickerEffort))
			? pickerEffort
			: (model.defaultReasoningEffort && supports.includes(model.defaultReasoningEffort)
				? model.defaultReasoningEffort
				: undefined);
		if (!effort) {
			return;
		}

		const format = model.reasoningEffortFormat ?? model.apiType;
		const bodyObj = body as Record<string, unknown>;

		// 先清理可能已存在的 effort 字段，避免冲突
		if (bodyObj.reasoning) {
			const { effort: _drop, ...rest } = bodyObj.reasoning as Record<string, unknown>;
			bodyObj.reasoning = Object.keys(rest).length > 0 ? rest : undefined;
		}
		bodyObj.reasoning_effort = undefined;
		if (bodyObj.output_config) {
			const { effort: _drop, ...rest } = bodyObj.output_config as Record<string, unknown>;
			bodyObj.output_config = Object.keys(rest).length > 0 ? rest : undefined;
		}

		if (format === 'responses') {
			bodyObj.reasoning = { ...bodyObj.reasoning as object | undefined, effort };
		} else if (format === 'messages') {
			bodyObj.output_config = { ...bodyObj.output_config as object | undefined, effort };
		} else {
			bodyObj.reasoning_effort = effort;
		}
	}

	/** 按协议构造请求头：默认 Bearer 鉴权 + 协议特殊头 + 用户自定义头覆盖 */
	private buildRequestHeaders(model: KaiModelInformation): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		// 用户自定义头（先安全过滤，再判断是否已提供鉴权头）
		// 参考 customendpoint 的 _userAuthHeaderSuppressionSet：
		// ['api-key', 'authorization', 'x-api-key', 'x-goog-api-key', 'apikey']
		const userHeaders = sanitizeCustomHeaders(model.requestHeaders);
		const hasUserAuthHeader = Object.keys(userHeaders).some(k => {
			const lower = k.toLowerCase();
			return lower === 'authorization' || lower === 'api-key' || lower === 'x-api-key' || lower === 'x-goog-api-key' || lower === 'apikey';
		});

		// 默认鉴权头（参考 customendpoint 的 getExtraHeaders）
		if (model.apiKey && !hasUserAuthHeader) {
			if (model.apiType === 'messages') {
				// Anthropic Messages API：x-api-key + anthropic-version
				headers['x-api-key'] = model.apiKey;
				headers['anthropic-version'] = '2023-06-01';
			} else if (model.endpointUrl.includes('openai.azure')) {
				// Azure OpenAI：api-key
				headers['api-key'] = model.apiKey;
			} else {
				// OpenAI 兼容：Authorization: Bearer
				headers['Authorization'] = `Bearer ${model.apiKey}`;
			}
		}

		// 用户自定义头覆盖默认头（大小写不敏感合并，支持 `${apiKey}` 插值）
		for (const [key, value] of Object.entries(userHeaders)) {
			const lowerKey = key.toLowerCase();
			if (lowerKey === 'authorization' || lowerKey === 'api-key' || lowerKey === 'x-api-key' || lowerKey === 'x-goog-api-key' || lowerKey === 'content-type') {
				// 覆盖默认鉴权头：删除已设置的默认值，再写入用户值
				for (const existing of Object.keys(headers)) {
					if (existing.toLowerCase() === lowerKey) {
						delete headers[existing];
					}
				}
			}
			headers[key] = model.apiKey ? value.split('${apiKey}').join(model.apiKey) : value;
		}

		return headers;
	}

	/** 处理 chat/completions 流：文本 + 工具调用增量组装 */
	private async processChatCompletionsStream(
		response: Response,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	): Promise<void> {
		// 累积工具调用增量（按 index 分组）
		const toolCallAccumulators = new Map<number, { id?: string; name?: string; args: string }>();

		for await (const chunk of streamChatCompletions(response)) {
			if (chunk.error?.message) {
				throw new Error(`模型请求失败：${chunk.error.message}`);
			}
			const delta = chunk.choices?.[0]?.delta;
			if (!delta) {
				continue;
			}
			if (delta.content) {
				progress.report(new vscode.LanguageModelTextPart(delta.content));
			}
			// 推理内容（如 DeepSeek-R1 的 reasoning_content）作为文本输出
			if (delta.reasoning_content) {
				progress.report(new vscode.LanguageModelTextPart(delta.reasoning_content));
			}
			if (delta.tool_calls) {
				for (const toolCall of delta.tool_calls) {
					let accumulator = toolCallAccumulators.get(toolCall.index);
					if (!accumulator) {
						accumulator = { id: toolCall.id, name: toolCall.function?.name, args: '' };
						toolCallAccumulators.set(toolCall.index, accumulator);
					}
					if (toolCall.id) {
						accumulator.id = toolCall.id;
					}
					if (toolCall.function?.name) {
						accumulator.name = toolCall.function.name;
					}
					if (toolCall.function?.arguments) {
						accumulator.args += toolCall.function.arguments;
					}
				}
			}
		}

		// 流结束后，上报组装完成的工具调用
		for (const accumulator of toolCallAccumulators.values()) {
			if (!accumulator.id || !accumulator.name) {
				continue;
			}
			let input: object;
			try {
				input = JSON.parse(accumulator.args || '{}');
			} catch {
				input = {};
			}
			progress.report(new vscode.LanguageModelToolCallPart(accumulator.id, accumulator.name, input));
		}
	}

	/** 处理 /responses 流：output_text / function_call 增量组装 */
	private async processResponsesStream(
		response: Response,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	): Promise<void> {
		// Responses API 的 function_call 增量按 item_id 组装（而非 index）
		// 监听 response.output_item.added 初始化累积器，response.function_call_arguments.delta 累积参数
		const toolCallAccumulators = new Map<string, { id: string; name?: string; args: string }>();
		let pendingText = '';

		const flushText = () => {
			if (pendingText) {
				progress.report(new vscode.LanguageModelTextPart(pendingText));
				pendingText = '';
			}
		};

		for await (const sseEvent of streamSSE(response)) {
			const data = sseEvent.data as Record<string, unknown> | undefined;
			if (!data || typeof data !== 'object') {
				continue;
			}

			// 错误
			if (data.type === 'error' && data.error && typeof data.error === 'object') {
				const err = data.error as { message?: string };
				throw new Error(`模型请求失败：${err.message ?? JSON.stringify(data.error)}`);
			}

			switch (data.type) {
				case 'response.output_item.added': {
					// 新的 output item 加入时初始化累积器（function_call 类型）
					const item = data.item as { type?: string; id?: string; name?: string; call_id?: string } | undefined;
					if (item?.type === 'function_call' && typeof item.call_id === 'string') {
						toolCallAccumulators.set(item.call_id, {
							id: item.call_id,
							name: item.name,
							args: '',
						});
					}
					flushText();
					break;
				}
				case 'response.output_text.delta': {
					const delta = data.delta;
					if (typeof delta === 'string') {
						pendingText += delta;
					}
					break;
				}
				case 'response.function_call_arguments.delta': {
					const itemId = data.item_id;
					const delta = data.delta;
					if (typeof delta === 'string' && typeof itemId === 'string') {
						let accumulator = toolCallAccumulators.get(itemId);
						if (!accumulator) {
							// delta 先于 output_item.added 到达时的容错：按 itemId 创建
							accumulator = { id: itemId, name: undefined, args: '' };
							toolCallAccumulators.set(itemId, accumulator);
						}
						accumulator.args += delta;
					}
					flushText();
					break;
				}
				case 'response.function_call_arguments.done': {
					const itemId = data.item_id;
					const name = data.name;
					const argumentsJson = data.arguments;
					if (typeof itemId === 'string') {
						const accumulator = toolCallAccumulators.get(itemId);
						if (accumulator) {
							if (typeof name === 'string') {
								accumulator.name = name;
							}
							if (typeof argumentsJson === 'string') {
								accumulator.args = argumentsJson;
							}
						}
					}
					flushText();
					break;
				}
				default:
					flushText();
					break;
			}
		}

		flushText();

		// 上报组装完成的工具调用
		for (const accumulator of toolCallAccumulators.values()) {
			if (!accumulator.id || !accumulator.name) {
				continue;
			}
			let input: object;
			try {
				input = JSON.parse(accumulator.args || '{}');
			} catch {
				input = {};
			}
			progress.report(new vscode.LanguageModelToolCallPart(accumulator.id, accumulator.name, input));
		}
	}

	/** 处理 /messages（Anthropic）流：content_block_delta / content_block_stop 增量组装 */
	private async processMessagesStream(
		response: Response,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	): Promise<void> {
		// 工具调用按 block index 组装
		const toolUseBlocks = new Map<number, { id?: string; name?: string; inputJson: string }>();
		let currentToolUseIndex: number | undefined;

		for await (const sseEvent of streamSSE(response)) {
			const data = sseEvent.data as Record<string, unknown> | undefined;
			if (!data || typeof data !== 'object') {
				continue;
			}

			// 错误
			if (data.type === 'error' && data.error && typeof data.error === 'object') {
				const err = data.error as { message?: string };
				throw new Error(`模型请求失败：${err.message ?? JSON.stringify(data.error)}`);
			}

			switch (data.type) {
				case 'content_block_start': {
					const block = data.content_block as { type?: string; id?: string; name?: string } | undefined;
					if (block?.type === 'tool_use') {
						const index = data.index as number;
						toolUseBlocks.set(index, { id: block.id, name: block.name, inputJson: '' });
						currentToolUseIndex = index;
					}
					break;
				}
				case 'content_block_delta': {
					const delta = data.delta as { type?: string; text?: string; partial_json?: string } | undefined;
					if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
						progress.report(new vscode.LanguageModelTextPart(delta.text));
					} else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
						if (currentToolUseIndex !== undefined) {
							const block = toolUseBlocks.get(currentToolUseIndex);
							if (block) {
								block.inputJson += delta.partial_json;
							}
						}
					}
					break;
				}
				case 'content_block_stop': {
					const index = data.index as number;
					if (currentToolUseIndex === index) {
						currentToolUseIndex = undefined;
					}
					// 完整工具调用在此上报
					const block = toolUseBlocks.get(index);
					if (block?.id && block.name) {
						let input: object;
						try {
							input = JSON.parse(block.inputJson || '{}');
						} catch {
							input = {};
						}
						progress.report(new vscode.LanguageModelToolCallPart(block.id, block.name, input));
					}
					break;
				}
			}
		}
	}

	async provideTokenCount(
		_model: KaiModelInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		// 参考 customendpoint 的 CopilotLanguageModelWrapper.provideTokenCount：
		// - 纯字符串：直接真实 BPE 编码计数
		// - 消息：转换为 OpenAI 风格消息对象后 countMessageTokens(含 BaseTokensPerMessage)
		if (typeof text === 'string') {
			return countTextTokens(text);
		}

		// 将 VS Code 消息的 parts 转换为可计数的 OpenAI 内容 part
		type CountablePart =
			| { type: 'text'; text: string }
			| { type: 'image_url'; image_url: { url: string; detail?: string } }
			| { type: 'document'; documentData: { data: string; mediaType: string } };

		const content: CountablePart[] = [];
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				content.push({ type: 'text', text: part.value });
			} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
				content.push({
					type: 'image_url',
					image_url: { url: `data:${part.mimeType};base64,${bytesToBase64(part.data)}` },
				});
			} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType === 'application/pdf') {
				content.push({
					type: 'document',
					documentData: { data: bytesToBase64(part.data), mediaType: part.mimeType },
				});
			}
		}

		const message: { role: string; content: unknown; name?: string; tool_calls?: unknown[] } = {
			role: text.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant'
				: (text.role as number) === 3 ? 'system'
					: 'user',
			content: content.length > 0 ? content : '',
			name: text.name,
		};

		// assistant 消息的工具调用也计入(与 customendpoint 一致)
		if (text.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const toolCalls = text.content
				.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart)
				.map(part => ({ function: { name: part.name, arguments: JSON.stringify(part.input) }, id: part.callId, type: 'function' }));
			if (toolCalls.length > 0) {
				message.tool_calls = toolCalls;
			}
		}

		return countMessageTokens(message as Record<string, unknown>);
	}
}

/** 导出 vendor 常量，便于其他模块引用 */
export { PROVIDER_VENDOR };

/** 重新导出类型，保持类型入口一致 */
export type { KaiModelConfig, KaiProviderGroup } from './types';
