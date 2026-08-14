/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CONFIG_MODELS_KEY, CONFIG_VENDOR, KaiProviderGroup, PROVIDER_VENDOR } from './types';

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
