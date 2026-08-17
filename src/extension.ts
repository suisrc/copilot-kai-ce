/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { KaiCustomEndpointProvider } from './provider';
import { KaiInlineCompletionProvider } from './completions';
import { getInlineCompletionConfig } from './config';
import { disposeLogger } from './logger';
import { CONFIG_INLINE_COMPLETION_KEY, CONFIG_MODELS_KEY, PROVIDER_VENDOR } from './types';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new KaiCustomEndpointProvider();

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR, provider),
		// 配置变更时通知 VS Code 刷新模型列表
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_MODELS_KEY)) {
				provider.notifyConfigurationChanged();
			}
		}),
		// KaiCE 调试输出通道：扩展卸载/重载窗口时自动销毁，避免残留/重复通道
		{ dispose: disposeLogger },
	);

	// 内联补全：配置了 kaicustomendpoint.inlineCompletion 且含 model 时才注册
	registerInlineCompletion(context);
}

function registerInlineCompletion(context: vscode.ExtensionContext): void {
	let disposable: vscode.Disposable | undefined;

	const apply = () => {
		disposable?.dispose();
		disposable = undefined;

		const config = getInlineCompletionConfig();
		if (!config) {
			return;
		}

		// 构造 DocumentSelector：pattern（glob）+ 可选 language 过滤。
		// DocumentFilter.language 为单字符串，多语言时展开为多个 filter。
		const pattern = config.pattern ?? '**';
		let selector: vscode.DocumentSelector;
		if (Array.isArray(config.language)) {
			selector = config.language.map(lang => ({ pattern, language: lang }));
		} else if (config.language) {
			selector = { pattern, language: config.language };
		} else {
			selector = { pattern };
		}

		disposable = vscode.languages.registerInlineCompletionItemProvider(
			selector,
			new KaiInlineCompletionProvider(config),
		);
	};

	// 初次注册 + 配置变更时动态重注册
	apply();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_INLINE_COMPLETION_KEY)) {
				apply();
			}
		}),
		{ dispose: () => disposable?.dispose() },
	);
}

export function deactivate(): void { }
