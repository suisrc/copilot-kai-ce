/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * KaiCE 调试日志：输出到 VS Code 的 OUTPUT 面板「KaiCE」通道。
 *
 * 当思考级别（effort）以 `-op` 结尾（如 `high-op`、`medium-op`）时启用，
 * 打印请求头、请求体、响应头与响应体，便于排查模型网关问题。
 * `-op` 后缀仅作为调试开关，写入请求体前会被去除，模型只会收到真实的思考级别。
 */

const OUTPUT_CHANNEL_NAME = 'KaiCE';

let outputChannel: vscode.OutputChannel | undefined;

/** 获取（并惰性创建）KaiCE 输出通道 */
function getOutputChannel(): vscode.OutputChannel {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
	}
	return outputChannel;
}

/**
 * 销毁 KaiCE 输出通道。
 * 应在扩展 deactivate 时调用（由 extension.ts 注册到 context.subscriptions），
 * 避免重载窗口后出现残留/重复的输出通道。
 */
export function disposeLogger(): void {
	outputChannel?.dispose();
	outputChannel = undefined;
}

/** `-op` 调试后缀（大小写敏感，必须全小写；output 的缩写） */
const LOG_SUFFIX = '-op';

/**
 * 生成请求日志 UID（短随机串）。
 * 同一 HTTP 请求的所有日志（请求头/体、响应、异常）共用同一个 UID，
 * 便于在 OUTPUT 面板中关联定位。
 */
export function generateRequestUid(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 判断 effort 是否以 `-op` 结尾（大小写敏感），即是否启用请求/响应调试日志。
 * 例：`high-op` → true，`high-OP` → false，`high` → false。
 */
export function isLogEffort(effort: string | undefined): boolean {
	return typeof effort === 'string' && effort.trim().endsWith(LOG_SUFFIX);
}

/**
 * 去除 effort 的 `-op` 调试后缀，得到真正的思考级别。
 * 例：`high-op` → `high`，`medium` → `medium`，`undefined` → `undefined`。
 */
export function stripLogEffort(effort: string | undefined): string | undefined {
	if (!effort) {
		return undefined;
	}
	const trimmed = effort.trim();
	return trimmed.endsWith(LOG_SUFFIX) ? trimmed.slice(0, -LOG_SUFFIX.length) : trimmed;
}

/** 日志请求种类 */
export type RequestLogKind = 'chat' | 'inline-completion';

/** 请求日志上下文 */
export interface RequestLogInfo {
	/** 请求 UID，关联同一请求的请求/响应/异常日志 */
	uid: string;
	kind: RequestLogKind;
	modelId: string;
	groupName?: string;
	url: string;
	headers: Record<string, string>;
	/** 请求体原始文本（与网络发送内容一致），日志中原样输出 */
	body: string;
}

/** 单段日志最大字符数（防止超长上下文撑爆输出面板） */
const MAX_LOG_CHARS = 100_000;

/** 敏感请求头（鉴权），日志中部分打码，避免 API Key 明文落入输出面板 */
const SENSITIVE_HEADERS = new Set([
	'authorization', 'api-key', 'x-api-key', 'x-goog-api-key', 'apikey', 'x-apikey',
]);

/** 部分打码：保留前 6 位与后 4 位，中间替换为 **** */
function maskSecret(value: string): string {
	if (value.length <= 12) {
		return '****';
	}
	return `${value.slice(0, 6)}****${value.slice(-4)}`;
}

function formatHeaderValue(key: string, value: string): string {
	return SENSITIVE_HEADERS.has(key.toLowerCase()) ? maskSecret(value) : value;
}

/**
 * 记录日志模块自身的异常（如 appendLine 失败），同时输出到 console 与 KaiCE 通道。
 * 直接用 outputChannel.appendLine 而非调用其他日志函数，避免递归。
 * 通道未创建或写入失败时仅 console，不抛出。
 */
function logError(message: string, e: unknown): void {
	console.error(message, e);
	try {
		const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
		outputChannel?.appendLine(`[Logger Error] ${message} ${detail}`);
	} catch {
		// 通道写入也失败时，仅 console 已足够，不再处理
	}
}

/**
 * 后截取：保留末尾 maxChars 字符，前面以 `…` 省略。
 * 用于请求体——请求体末尾（靠近光标处）通常更具诊断价值。
 */
function truncateForLog(text: string, maxChars: number = MAX_LOG_CHARS): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `… (truncated, ${text.length} chars total, showing last ${maxChars})\n${text.slice(-maxChars)}`;
}

/** 记录请求开始：请求头 + 请求体（日志自身异常不影响主流程） */
export function logRequestStart(info: RequestLogInfo): void {
	try {
		const channel = getOutputChannel();
		const kindLabel = info.kind === 'chat' ? 'Chat' : 'Inline Completion';
		channel.appendLine('');
		channel.appendLine(`[${kindLabel}] [UID ${info.uid}] Model: ${info.modelId}${info.groupName ? ` (Group: ${info.groupName})` : ''}`);
		channel.appendLine(`[Request URL] ${info.url}`);
		channel.appendLine('[Request Headers]');
		for (const [key, value] of Object.entries(info.headers)) {
			channel.appendLine(`  ${key}: ${formatHeaderValue(key, value)}`);
		}
		channel.appendLine('[Request Body]');
		channel.appendLine(truncateForLog(info.body));
	} catch (e) {
		logError('[KaiCE] Failed to write request log:', e);
	}
}

/**
 * 前截取流式读取响应体：累计到 maxChars 即停止读取，保留开头部分。
 * 与一次性 `text()` 的区别：峰值内存恒定为 maxChars，且达到上限后立即取消读取，
 * 不再消耗 CPU 解码剩余 chunk（大响应下避免拖延日志完成时间）。
 * 响应体开头（HTTP 错误信息 / SSE 首块）通常更具诊断价值。
 * 返回 { text, truncated, totalChars } 便于调用方追加截断提示。
 */
async function readResponseStreamLimited(response: Response, maxChars: number): Promise<{ text: string; truncated: boolean; totalChars: number }> {
	const reader = response.body?.getReader();
	// 无 body（如 HEAD）或不可读：回退到 text()
	if (!reader) {
		const text = await response.text().catch(() => '');
		return { text, truncated: text.length > maxChars, totalChars: text.length };
	}
	const decoder = new TextDecoder();
	let result = '';
	let totalChars = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			const chunk = decoder.decode(value, { stream: true });
			totalChars += chunk.length;
			if (result.length < maxChars) {
				result += chunk.slice(0, maxChars - result.length);
			}
			if (result.length >= maxChars) {
				// 已达上限：立即取消读取，不再消耗 CPU 解码剩余 chunk。
				// totalChars 仅记录到当前位置，剩余部分不累计（大响应下以性能优先）。
				truncated = true;
				break;
			}
		}
		// flush decoder（仅未截断时；截断路径已 break，无需 flush）
		if (!truncated) {
			const tail = decoder.decode();
			if (tail) {
				totalChars += tail.length;
				if (result.length < maxChars) {
					result += tail.slice(0, maxChars - result.length);
				}
				if (result.length >= maxChars) {
					truncated = true;
				}
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// 已被 cancel 时 releaseLock 可能抛错，忽略
		}
	}
	return { text: result, truncated, totalChars };
}

/** 记录响应：状态 + 响应头 + 响应体（流式读取，提前截断，不阻塞主流解析） */
export async function logResponseInfo(response: Response, uid: string): Promise<void> {
	try {
		// clone() 创建独立 reader，主流仍可读取原 response.body
		const clone = response.clone();
		const channel = getOutputChannel();
		channel.appendLine(`[Response Status] [UID ${uid}] ${clone.status} ${clone.statusText}`);
		channel.appendLine('[Response Headers]');
		clone.headers.forEach((value, key) => {
			channel.appendLine(`  ${key}: ${formatHeaderValue(key, value)}`);
		});
		channel.appendLine('[Response Body]');
		// 前截取：保留开头，峰值内存恒定为 MAX_LOG_CHARS（而非完整响应体）
		const { text, truncated, totalChars } = await readResponseStreamLimited(clone, MAX_LOG_CHARS);
		if (truncated) {
			// totalChars 为已读取部分的大小（达上限后立即停止，不再累计剩余）
			channel.appendLine(`${text}\n… (truncated, >= ${totalChars} chars total, showing first ${text.length})`);
		} else {
			channel.appendLine(text || '(empty)');
		}
	} catch (e) {
		logError('[KaiCE] Failed to write response log:', e);
	}
}

/** 记录请求异常（网络错误 / 非 2xx / 流解析错误等） */
export function logRequestError(kind: RequestLogKind, modelId: string, error: unknown, uid: string): void {
	try {
		const channel = getOutputChannel();
		const kindLabel = kind === 'chat' ? 'Chat' : 'Inline Completion';
		channel.appendLine('');
		channel.appendLine(`[${kindLabel} Error] [UID ${uid}] Model: ${modelId}`);
		channel.appendLine(`  ${error instanceof Error ? error.message : String(error)}`);
	} catch {
		// 忽略日志自身异常
	}
}
