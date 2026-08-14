/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { KaiCustomEndpointProvider } from './provider';
import { CONFIG_MODELS_KEY, PROVIDER_VENDOR } from './types';

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
	);
}

export function deactivate(): void { }
