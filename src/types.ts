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
export const CONFIG_SECRETS_KEY = 'kaicustomendpoint.secrets';
export const CONFIG_INLINE_COMPLETION_KEY = 'kaicustomendpoint.inlineCompletion';

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
	/** 是否支持工具调用（默认 true，仅显式 false 时禁用） */
	readonly toolCalling?: boolean;
	/** 是否支持图片输入（默认 false） */
	readonly vision?: boolean;
	/** 是否支持思考能力 */
	readonly thinking?: boolean;
	/** 是否支持流式输出 */
	readonly streaming?: boolean;
	/** 编辑工具偏好（proposed API chatProvider） */
	readonly editTools?: string[];
	/** 是否启用零数据保留 ZDR（proposed API chatProvider） */
	readonly zeroDataRetentionEnabled?: boolean;
	/** 支持的思考级别，如 ['low', 'medium', 'high']。picker UI 依赖 proposed API chatProvider，但 defaultReasoningEffort 可独立生效。支持带 `-op` 调试后缀的条目（如 'high-op'），与去后缀的条目（如 'high'）相互独立、可并存；选择带 `-op` 的条目时启用 KaiCE 调试日志，后缀不写入请求体 */
	readonly supportsReasoningEffort?: string[];
	/** 思考级别写入请求体的格式，未设置时根据 apiType 推断 */
	readonly reasoningEffortFormat?: 'chat-completions' | 'responses' | 'messages';
	/** 默认思考级别，请求时直接写入请求体（不依赖 proposed API）。须精确存在于 supportsReasoningEffort 列表中；以 `-op` 结尾时启用 KaiCE 调试日志（打印请求/响应详情），后缀不写入请求体 */
	readonly defaultReasoningEffort?: string;
	/** 附加请求头 */
	readonly requestHeaders?: Record<string, string>;
	/** 透传给请求体的模型参数 */
	readonly modelOptions?: Record<string, unknown>;
	/**
	 * 元数据/扩展字段，按协议自适应注入：
	 * - Anthropic 协议（messages）：作为请求体的 `metadata` 字段发送（如 `{"user_id":"xxx"}`）
	 * - OpenAI 协议（chat-completions / responses）：展开到请求体顶层（如 `{"user":"xxx"}`）
	 * 已存在的请求体字段优先，不被覆盖。
	 */
	readonly metadata?: Record<string, unknown>;
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

/**
 * 内联补全（inline completion）使用的模型配置。
 * 与 chat 模型分组解耦，可独立指定补全专用模型（通常更快/更便宜）。
 */
export interface KaiInlineCompletionModelConfig {
	/** 模型 ID，请求时作为 FIM `model` 字段发送 */
	readonly id: string;
	/** 显示名称，缺省时使用 id */
	readonly name?: string;
	/** 完整端点 URL（必须为全地址，如 `https://api.deepseek.com/beta/completions`，不做路径拼接） */
	readonly url?: string;
	/** API Key，支持 `${input:chat.lm.secret.<id>}` 引用（与 models 一致） */
	readonly apiKey?: string;
	/** 最大输出 token 数 */
	readonly maxOutputTokens?: number;
	/** 默认思考级别（透传给 FIM 请求体，模型支持时生效）。以 `-op` 结尾时启用 KaiCE 调试日志，后缀不写入请求体 */
	readonly defaultReasoningEffort?: string;
	/** 附加请求头，支持 `${apiKey}` 插值 */
	readonly requestHeaders?: Record<string, string>;
	/** 透传给 FIM 请求体的模型参数（如 temperature 等） */
	readonly modelOptions?: Record<string, unknown>;
	/**
	 * 元数据/扩展字段，展开到 FIM 请求体顶层（FIM 走 OpenAI 补全协议）。
	 * 用于补充协议未覆盖的字段，如 `user_id` 等。已存在的请求体字段优先，不被覆盖。
	 */
	readonly metadata?: Record<string, unknown>;
}

/**
 * 内联补全配置（`kaicustomendpoint.inlineCompletion`）。
 * 未配置（或 model 缺失）时，KaiCE 不注册补全 provider。
 */
export interface KaiInlineCompletionConfig {
	/** 文档匹配 glob（DocumentSelector 的 pattern），如 `"**"` */
	readonly pattern?: string;
	/** 限定语言 ID（字符串或数组），如 `"typescript"` 或 `["typescript", "javascript"]` */
	readonly language?: string | string[];
	/** 补全提示词模板，支持 `{prefix}` / `{suffix}` / `{languageId}` 占位符；缺省为 `"{prefix}"`（标准 FIM） */
	readonly prompt?: string;
	/** 补全模型配置 */
	readonly model?: KaiInlineCompletionModelConfig;
}
