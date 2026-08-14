/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 模型供应商类型定义。
 *
 * 这些类型与 VS Code 的 `chatLanguageModels.json` 中 provider groups 的结构保持一致
 * （参见 `ILanguageModelsProviderGroup`），因此用户可以将 `chatLanguageModels.json`
 * 中的内容几乎原样复制到 `kaicustomendpoint.models` 配置项中，仅需将 `vendor` 改为
 * `kaicustomendpoint`。
 */

export type ApiType = 'chat-completions' | 'responses' | 'messages';

/**
 * 工具注册 ID（`registerLanguageModelChatProvider` 与 `onLanguageModelChatProvider`
 * 激活事件使用的全局唯一 ID，避免与官方 Copilot 扩展冲突）。
 */
export const PROVIDER_VENDOR = 'kaicustomendpoint';

/**
 * 配置中的 `vendor` 字段值（致敬官方命名，与 `chatLanguageModels.json` 保持一致，
 * 便于用户从官方配置零修改迁移）。
 */
export const CONFIG_VENDOR = 'customendpoint';

/** 配置项前缀与键 */
export const CONFIG_SECTION = 'kaicustomendpoint';
export const CONFIG_MODELS_KEY = 'kaicustomendpoint.models';

/** 单个模型配置，与 customendpoint 的模型配置字段保持一致 */
export interface KaiModelConfig {
	/** 模型 ID，请求时作为 OpenAI `model` 字段发送 */
	readonly id: string;
	/** 显示名称，缺省时使用 id */
	readonly name?: string;
	/** 该模型专用端点 URL，缺省时使用分组级 url */
	readonly url?: string;
	/** 模型级 API 类型覆盖 */
	readonly apiType?: ApiType;
	/** 最大输入 token 数（可选，设置 contextWindow 时可推导） */
	readonly maxInputTokens?: number;
	/** 最大输出 token 数 */
	readonly maxOutputTokens?: number;
	/** 完整上下文窗口（输入+输出）token 数 */
	readonly contextWindow?: number;
	/** 是否支持工具调用 */
	readonly toolCalling?: boolean;
	/** 是否支持图片输入 */
	readonly vision?: boolean;
	/** 是否支持思考能力 */
	readonly thinking?: boolean;
	/** 是否支持流式输出 */
	readonly streaming?: boolean;
	/** 编辑工具偏好（proposed API chatProvider） */
	readonly editTools?: string[];
	/** 是否启用零数据保留 ZDR（proposed API chatProvider） */
	readonly zeroDataRetentionEnabled?: boolean;
	/** 支持的推理努力级别，如 ['low', 'medium', 'high']。picker UI 依赖 proposed API chatProvider，但 defaultReasoningEffort 可独立生效 */
	readonly supportsReasoningEffort?: string[];
	/** 推理努力级别写入请求体的格式，未设置时根据 apiType 推断 */
	readonly reasoningEffortFormat?: 'chat-completions' | 'responses' | 'messages';
	/** 默认推理努力级别，请求时直接写入请求体（不依赖 proposed API） */
	readonly defaultReasoningEffort?: string;
	/** 附加请求头 */
	readonly requestHeaders?: Record<string, string>;
	/** 透传给请求体的模型参数 */
	readonly modelOptions?: Record<string, unknown>;
}

/** 供应商分组配置，与 chatLanguageModels.json 中单个 group 的结构一致 */
export interface KaiProviderGroup {
	/** 供应商 ID，固定为 customendpoint（致敬官方；见 CONFIG_VENDOR） */
	readonly vendor?: string;
	/** 分组名称 */
	readonly name: string;
	/** API Key（明文存储） */
	readonly apiKey?: string;
	/** 分组级默认 API 类型 */
	readonly apiType?: ApiType;
	/** 分组级默认 Base URL */
	readonly url?: string;
	/** 该分组下的模型列表 */
	readonly models?: KaiModelConfig[];
}
