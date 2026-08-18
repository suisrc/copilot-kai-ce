/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CONFIG_INLINE_COMPLETION_KEY, CONFIG_MODELS_KEY, CONFIG_SECRETS_KEY, CONFIG_SECTION, CONFIG_VENDOR, KaiInlineCompletionConfig, KaiProviderGroup, PROVIDER_VENDOR } from './types';

/** ${input:chat.lm.secret.xxx} 引用前缀 */
const SECRET_REF_PREFIX = '${input:chat.lm.secret.';

/**
 * 读取 `kaicustomendpoint.models` 配置（provider groups 数组）。
 *
 * 相比 `chatLanguageModels.json`（Web 版存于浏览器 IndexedDB，刷新/换浏览器即丢），
 * 这里直接读取 `settings.json`，由 VS Code 原生持久化，并支持 Settings Sync。
 */
export function getProviderGroups(): KaiProviderGroup[] {
	const groups = vscode.workspace.getConfiguration().get<KaiProviderGroup[]>(CONFIG_MODELS_KEY, []);
	if (!Array.isArray(groups)) {
		return [];
	}
	// 过滤掉无 models 的分组。vendor 接受 customendpoint（致敬官方）或 kaicustomendpoint（本工具注册 ID）
	return groups.filter(g => g && Array.isArray(g.models) && g.models.length > 0 && (!g.vendor || g.vendor === CONFIG_VENDOR || g.vendor === PROVIDER_VENDOR));
}

/** 读取整个 secrets 映射（kaicustomendpoint.secrets），供批量解析引用时复用，避免重复读配置 */
export function readSecretsMap(): Record<string, string> {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).get<Record<string, string>>(CONFIG_SECRETS_KEY.replace(`${CONFIG_SECTION}.`, ''), {}) ?? {};
}

/**
 * 解析 apiKey 中的 `${input:chat.lm.secret.xxx}` 引用。
 *
 * - 普通字符串（如 `"sk-xxxx"`）：直接返回
 * - 引用语法 `"${input:chat.lm.secret.5c3fc3d9}"`：直接从 `kaicustomendpoint.secrets.5c3fc3d9` 配置项取值
 * - 引用未找到对应 secret：返回空字符串（请求时不带鉴权头）
 *
 * 这与 VS Code Copilot 的 `chatLanguageModels.json` 中 `${input:...}` 语法兼容，
 * 用户从 chatLanguageModels.json 迁移时无需修改 apiKey 引用。
 *
 * @param secretsMap 预读的 secrets 映射（由 {@link readSecretsMap} 读取），
 *                  避免在批量解析多个 group 时重复读配置；不传则每次内部读取
 */
export function resolveSecret(value: string | undefined, secretsMap?: Record<string, string>): string | undefined {
	if (!value) {
		return undefined;
	}
	if (!value.startsWith(SECRET_REF_PREFIX) || !value.endsWith('}')) {
		return value;
	}
	// 字符串截取：${input:chat.lm.secret.xxx} → 取 prefix 之后、末尾 } 之前的部分
	const secretId = value.slice(SECRET_REF_PREFIX.length, -1);
	const secrets = secretsMap ?? vscode.workspace.getConfiguration(CONFIG_SECTION).get<Record<string, string>>(CONFIG_SECRETS_KEY.replace(`${CONFIG_SECTION}.`, ''), {});
	return secrets?.[secretId] ?? '';
}

/** 在所有分组中查找包含指定模型 ID 的分组 */
export function findGroupForModel(groups: KaiProviderGroup[], modelId: string): KaiProviderGroup | undefined {
	return groups.find(g => g.models?.some(m => m.id === modelId));
}

/** 在所有分组中查找指定模型 ID 的模型配置 */
export function findModelConfig(groups: KaiProviderGroup[], modelId: string): { group: KaiProviderGroup; model: NonNullable<KaiProviderGroup['models']>[number] } | undefined {
	for (const group of groups) {
		const model = group.models?.find(m => m.id === modelId);
		if (model) {
			return { group, model };
		}
	}
	return undefined;
}

/**
 * 读取 `kaicustomendpoint.inlineCompletion` 补全配置。
 * 未配置（或 model 缺失）时返回 undefined，调用方据此决定是否注册补全 provider。
 */
export function getInlineCompletionConfig(): KaiInlineCompletionConfig | undefined {
	const config = vscode.workspace.getConfiguration().get<KaiInlineCompletionConfig | undefined>(CONFIG_INLINE_COMPLETION_KEY);
	if (!config || typeof config !== 'object') {
		return undefined;
	}
	// 补全必须有模型配置，否则无意义
	if (!config.model || typeof config.model !== 'object' || !config.model.id) {
		return undefined;
	}
	return config;
}
