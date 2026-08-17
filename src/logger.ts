/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ApiType } from './types';

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
		// 用 outputChannel?. 而非 getOutputChannel()，避免后者创建失败时回调本函数形成递归
		outputChannel?.appendLine(`[Logger Error] ${message} ${detail}`);
	} catch {
		// 通道写入也失败时，仅 console 已足够，不再处理
	}
}

/**
 * 记录请求开始：请求头 + 请求体。
 *
 * 并发安全：所有日志行先拼成单个字符串，再用一次 `getOutputChannel().append` 写入。
 * `OutputChannel.appendLine` 仅单行原子，多次调用之间会因 async `await` 切换事件循环
 * 被其它请求的日志穿插，故必须整块单次写入。请求体后截取保留末尾 MAX_LOG_CHARS 字符
 * （末尾靠近光标处更具诊断价值）。日志自身异常不影响主流程。
 */
export function logRequestStart(info: RequestLogInfo): void {
	try {
		const kindLabel = info.kind === 'chat' ? 'Chat' : 'Inline Completion';
		const bodyText = info.body.length <= MAX_LOG_CHARS
			? info.body
			: `… (truncated, ${info.body.length} chars total, showing last ${MAX_LOG_CHARS})\n${info.body.slice(-MAX_LOG_CHARS)}`;
		const lines: string[] = [];
		lines.push(`[${kindLabel}] [UID ${info.uid}] Model: ${info.modelId}${info.groupName ? ` (Group: ${info.groupName})` : ''}`);
		lines.push(`[Request URL] ${info.url}`);
		lines.push('[Request Headers]');
		for (const [key, value] of Object.entries(info.headers)) {
			lines.push(`  ${key}: ${formatHeaderValue(key, value)}`);
		}
		lines.push('[Request Body]');
		lines.push(bodyText);
		getOutputChannel().append(lines.join('\n') + '\n');
	} catch (e) {
		logError('[KaiCE] Failed to write request log:', e);
	}
}

/** 响应流协议：三种对话协议 + FIM 补全协议 */
export type ResponseProtocol = ApiType | 'completions';

//#region SSE 流合并：增量字段拼接、其余字段原样保留（后值覆盖）

/**
 * 合并原则：
 * - 增量（自增）字段：字符串拼接（如 delta.content、thinking、text、arguments 片段）
 * - 其它属性：后值覆盖（last-wins）
 * 不新增、不删除、不改字段名——只把同一字段的增量内容合并，其余原样保留。
 */

/** 后值覆盖设置（undefined 跳过，避免抹掉已有值） */
function setIfPresent(target: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined) {
		target[key] = value;
	}
}

/** 取 target[key] 数组，不存在则创建 */
function ensureArray(target: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
	const arr = target[key];
	if (Array.isArray(arr)) {
		return arr as Array<Record<string, unknown>>;
	}
	const created: Array<Record<string, unknown>> = [];
	target[key] = created;
	return created;
}

/** 工具调用合并（chat-completions 的 tool_calls）：id/type/name 后值覆盖，arguments 片段拼接 */
function mergeToolCall(dst: Record<string, unknown>, src: Record<string, unknown>): void {
	setIfPresent(dst, 'id', src.id);
	setIfPresent(dst, 'type', src.type);
	const fn = src.function;
	if (fn && typeof fn === 'object') {
		const f = fn as Record<string, unknown>;
		let dstFn = dst.function as Record<string, unknown> | undefined;
		if (!dstFn) {
			dstFn = {};
			dst.function = dstFn;
		}
		setIfPresent(dstFn, 'name', f.name);
		if (typeof f.arguments === 'string') {
			dstFn.arguments = (typeof dstFn.arguments === 'string' ? dstFn.arguments : '') + f.arguments;
		}
	}
}

/** chat-completions：合并为单个 chunk 对象（delta.content / reasoning_content / tool_calls.arguments 拼接） */
function mergeChatCompletionsChunk(result: Record<string, unknown>, obj: Record<string, unknown>): void {
	for (const key of ['id', 'object', 'created', 'model', 'system_fingerprint', 'usage']) {
		setIfPresent(result, key, obj[key]);
	}
	const choices = obj.choices;
	if (!Array.isArray(choices)) {
		return;
	}
	const dstChoices = ensureArray(result, 'choices');
	for (const src of choices as Array<Record<string, unknown>>) {
		const index = typeof src.index === 'number' ? src.index : 0;
		let dst = dstChoices.find(c => c.index === index);
		if (!dst) {
			dst = { index };
			dstChoices.push(dst);
		}
		setIfPresent(dst, 'finish_reason', src.finish_reason);
		setIfPresent(dst, 'logprobs', src.logprobs);
		const delta = src.delta;
		if (!delta || typeof delta !== 'object') {
			continue;
		}
		const d = delta as Record<string, unknown>;
		let dstDelta = dst.delta as Record<string, unknown> | undefined;
		if (!dstDelta) {
			dstDelta = {};
			dst.delta = dstDelta;
		}
		setIfPresent(dstDelta, 'role', d.role);
		if (typeof d.content === 'string') {
			dstDelta.content = (typeof dstDelta.content === 'string' ? dstDelta.content : '') + d.content;
		}
		if (typeof d.reasoning_content === 'string') {
			dstDelta.reasoning_content = (typeof dstDelta.reasoning_content === 'string' ? dstDelta.reasoning_content : '') + d.reasoning_content;
		}
		if (Array.isArray(d.tool_calls)) {
			const dstCalls = ensureArray(dstDelta, 'tool_calls');
			for (const srcCall of d.tool_calls as Array<Record<string, unknown>>) {
				const callIndex = typeof srcCall.index === 'number' ? srcCall.index : 0;
				let dstCall = dstCalls.find(c => c.index === callIndex);
				if (!dstCall) {
					dstCall = { index: callIndex };
					dstCalls.push(dstCall);
				}
				mergeToolCall(dstCall, srcCall);
			}
		}
	}
}

/** completions（FIM）：合并为单个 completion 对象（choices[].text 拼接） */
function mergeCompletionsChunk(result: Record<string, unknown>, obj: Record<string, unknown>): void {
	for (const key of ['id', 'object', 'created', 'model', 'usage']) {
		setIfPresent(result, key, obj[key]);
	}
	const choices = obj.choices;
	if (!Array.isArray(choices)) {
		return;
	}
	const dstChoices = ensureArray(result, 'choices');
	for (const src of choices as Array<Record<string, unknown>>) {
		const index = typeof src.index === 'number' ? src.index : 0;
		let dst = dstChoices.find(c => c.index === index);
		if (!dst) {
			dst = { index };
			dstChoices.push(dst);
		}
		if (typeof src.text === 'string') {
			dst.text = (typeof dst.text === 'string' ? dst.text : '') + src.text;
		}
		setIfPresent(dst, 'finish_reason', src.finish_reason);
		setIfPresent(dst, 'logprobs', src.logprobs);
	}
}

/** messages（Anthropic）：合并为单个 message 对象（content 块按 delta.type 拼接增量） */
function mergeMessagesEvent(result: Record<string, unknown>, obj: Record<string, unknown>): void {
	switch (obj.type) {
		case 'message_start': {
			const message = obj.message;
			if (message && typeof message === 'object') {
				for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
					result[key] = value;
				}
			}
			break;
		}
		case 'content_block_start': {
			const content = ensureArray(result, 'content');
			const index = typeof obj.index === 'number' ? obj.index : content.length;
			const block = obj.content_block;
			if (block && typeof block === 'object') {
				const b: Record<string, unknown> = { ...(block as Record<string, unknown>) };
				// tool_use 的 input 用字符串累积 input_json_delta，content_block_stop 时解析
				if (b.type === 'tool_use') {
					b.input = '';
				}
				content[index] = b;
			}
			break;
		}
		case 'content_block_delta': {
			const content = ensureArray(result, 'content');
			const index = typeof obj.index === 'number' ? obj.index : 0;
			const block = content[index];
			const delta = obj.delta;
			if (!block || !delta || typeof delta !== 'object') {
				break;
			}
			const d = delta as Record<string, unknown>;
			switch (d.type) {
				case 'text_delta':
					block.text = (typeof block.text === 'string' ? block.text : '') + (typeof d.text === 'string' ? d.text : '');
					break;
				case 'thinking_delta':
					block.thinking = (typeof block.thinking === 'string' ? block.thinking : '') + (typeof d.thinking === 'string' ? d.thinking : '');
					break;
				case 'signature_delta':
					block.signature = (typeof block.signature === 'string' ? block.signature : '') + (typeof d.signature === 'string' ? d.signature : '');
					break;
				case 'input_json_delta':
					block.input = (typeof block.input === 'string' ? block.input : '') + (typeof d.partial_json === 'string' ? d.partial_json : '');
					break;
			}
			break;
		}
		case 'content_block_stop': {
			const content = ensureArray(result, 'content');
			const index = typeof obj.index === 'number' ? obj.index : 0;
			const block = content[index];
			if (block && block.type === 'tool_use' && typeof block.input === 'string') {
				try {
					block.input = JSON.parse(block.input);
				} catch {
					// 参数 JSON 未闭合（流被截断）时保留原始片段
				}
			}
			break;
		}
		case 'message_delta': {
			const delta = obj.delta;
			if (delta && typeof delta === 'object') {
				const d = delta as Record<string, unknown>;
				setIfPresent(result, 'stop_reason', d.stop_reason);
				setIfPresent(result, 'stop_sequence', d.stop_sequence);
			}
			setIfPresent(result, 'usage', obj.usage);
			break;
		}
		default:
			break;
	}
}

/** 在 output 数组中定位 item（优先 output_index，其次 item_id，兜底新建） */
function getOutputItem(
	output: Array<Record<string, unknown>>,
	outputIndex: unknown,
	itemId: unknown,
	fallbackType: string,
): Record<string, unknown> {
	if (typeof outputIndex === 'number' && output[outputIndex]) {
		return output[outputIndex];
	}
	if (typeof itemId === 'string') {
		const byId = output.find(it => it.id === itemId || it.call_id === itemId);
		if (byId) {
			return byId;
		}
		const created: Record<string, unknown> = { type: fallbackType, id: itemId };
		output.push(created);
		return created;
	}
	const created: Record<string, unknown> = { type: fallbackType };
	output.push(created);
	return created;
}

/** responses：合并为单个 response 对象（output 数组：output_text / function_call_arguments 增量拼接） */
function mergeResponsesEvent(result: Record<string, unknown>, obj: Record<string, unknown>): void {
	switch (obj.type) {
		case 'response.created':
		case 'response.in_progress':
		case 'response.completed': {
			const response = obj.response;
			if (response && typeof response === 'object') {
				for (const [key, value] of Object.entries(response as Record<string, unknown>)) {
					setIfPresent(result, key, value);
				}
			}
			break;
		}
		case 'response.output_item.added': {
			const output = ensureArray(result, 'output');
			const index = typeof obj.output_index === 'number' ? obj.output_index : output.length;
			if (obj.item && typeof obj.item === 'object') {
				output[index] = { ...(obj.item as Record<string, unknown>) };
			}
			break;
		}
		case 'response.output_text.delta': {
			const output = ensureArray(result, 'output');
			const item = getOutputItem(output, obj.output_index, obj.item_id, 'message');
			const content = ensureArray(item, 'content');
			const contentIndex = typeof obj.content_index === 'number' ? obj.content_index : content.length;
			let part = content[contentIndex];
			if (!part) {
				part = { type: 'output_text', text: '' };
				content[contentIndex] = part;
			}
			if (typeof obj.delta === 'string') {
				part.text = (typeof part.text === 'string' ? part.text : '') + obj.delta;
			}
			break;
		}
		case 'response.function_call_arguments.delta': {
			const output = ensureArray(result, 'output');
			const item = getOutputItem(output, obj.output_index, obj.item_id, 'function_call');
			if (typeof obj.delta === 'string') {
				item.arguments = (typeof item.arguments === 'string' ? item.arguments : '') + obj.delta;
			}
			break;
		}
		case 'response.function_call_arguments.done': {
			const output = ensureArray(result, 'output');
			const item = getOutputItem(output, obj.output_index, obj.item_id, 'function_call');
			if (typeof obj.name === 'string') {
				item.name = obj.name;
			}
			if (typeof obj.arguments === 'string') {
				item.arguments = obj.arguments;
			}
			break;
		}
		default:
			break;
	}
}

/** 按协议把单个 SSE 数据对象合并进结果对象 */
function mergeEvent(result: Record<string, unknown>, apiType: ResponseProtocol, data: unknown): void {
	if (!data || typeof data !== 'object') {
		return;
	}
	const obj = data as Record<string, unknown>;
	switch (apiType) {
		case 'chat-completions':
			mergeChatCompletionsChunk(result, obj);
			break;
		case 'responses':
			mergeResponsesEvent(result, obj);
			break;
		case 'messages':
			mergeMessagesEvent(result, obj);
			break;
		case 'completions':
			mergeCompletionsChunk(result, obj);
			break;
	}
}

/**
 * 合并流时原始字节的硬上限（防止纯空增量等病态流无限读取）。
 *
 * 双阈值职责：
 * - `MAX_RAW_CHARS`（1_000_000）：原始流读取的硬上限，超过即停止读取并置 truncated。
 *   仅在原始字节超大时触发，保护内存；与日志展示长度无关。
 * - `maxChars`（调用方传入 `MAX_LOG_CHARS`=100_000）：单段日志展示长度上限。
 *   对合并后的 JSON 与非 SSE 回退文本均取**前** maxChars 字符。
 *   当 100_000 < rawChars < 1_000_000 时，SSE 合并 JSON 可能超 maxChars 触发二次截断；
 *   非 SSE 回退则 rawFallback 本身已限定在 maxChars 以内。
 * 两层阈值各司其职：前者防病态流，后者防日志撑爆输出面板。
 */
const MAX_RAW_CHARS = 1_000_000;

/**
 * 读取响应体并按协议合并为完整 JSON 文本。
 * - SSE 流（chat-completions / responses / messages / completions）：解析 `data:` 行，
 *   增量字段拼接、其余字段后值覆盖，输出合并后的完整 JSON（超 maxChars 取前 maxChars）。
 * - 非 SSE 响应（如 JSON 错误体）：回退为原始文本（取**前** maxChars 字符，截断）。
 */
async function readResponseBodyForLog(
	response: Response,
	apiType: ResponseProtocol,
	maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
	const reader = response.body?.getReader();
	// 无 body（如 HEAD）或不可读：回退到 text()
	if (!reader) {
		const text = await response.text().catch(() => '');
		return { text, truncated: text.length > maxChars };
	}

	const decoder = new TextDecoder();
	const result: Record<string, unknown> = {};
	let buffer = '';
	let sawDataLine = false;
	let rawChars = 0;
	let rawFallback = '';
	let truncated = false;
	// 合并行失败只打印一次，避免病态流刷屏
	let mergeWarned = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			const chunk = decoder.decode(value, { stream: true });
			rawChars += chunk.length;
			// rawFallback 累积前 maxChars 字符，供非 SSE 回退使用（超出部分丢弃）
			if (rawFallback.length < maxChars) {
				rawFallback += chunk.slice(0, maxChars - rawFallback.length);
			}
			buffer += chunk;

			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith('data:')) {
					continue;
				}
				sawDataLine = true;
				const data = trimmed.slice(5).trim();
				if (data === '[DONE]') {
					continue;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(data);
				} catch {
					// 非 JSON 的 data 行（注释 / 心跳）忽略
					continue;
				}
				try {
					mergeEvent(result, apiType, parsed);
				} catch (e) {
					// 单行合并失败：打印错误后继续合并其余行，不影响业务
					if (!mergeWarned) {
						mergeWarned = true;
						logError('[KaiCE] Failed to merge SSE line:', e);
					}
				}
			}

			if (rawChars >= MAX_RAW_CHARS) {
				truncated = true;
				break;
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// 已被 cancel 时 releaseLock 可能抛错，忽略
		}
	}

	// 非 SSE 响应：展示原始文本（如 JSON 错误体），取前 maxChars 字符
	if (!sawDataLine) {
		return { text: rawFallback.trim(), truncated: rawChars > maxChars };
	}

	// SSE 合并：JSON 序列化后超 maxChars 则取前 maxChars 字符
	let text = JSON.stringify(result, null, 2);
	if (text.length > maxChars) {
		text = text.slice(0, maxChars);
		truncated = true;
	}
	return { text, truncated };
}

//#endregion

/** 记录响应：状态 + 响应头 + 响应体（按协议合并 SSE 为完整 JSON，提前截断，不阻塞主流解析） */
export async function logResponseInfo(response: Response, uid: string, apiType: ResponseProtocol): Promise<void> {
	try {
		// clone() 创建独立 reader，主流仍可读取原 response.body
		const clone = response.clone();
		// 先读取并合并响应体（async，会 await 让出事件循环），
		// 再与响应头拼成单个字符串一次性写入——保证 Body 与 Header 不被并发请求穿插
		const { text, truncated } = await readResponseBodyForLog(clone, apiType, MAX_LOG_CHARS);

		const lines: string[] = [];
		lines.push(`[Response Status] [UID ${uid}] ${clone.status} ${clone.statusText}`);
		lines.push('[Response Headers]');
		clone.headers.forEach((value, key) => {
			lines.push(`  ${key}: ${formatHeaderValue(key, value)}`);
		});
		lines.push('[Response Body]');
		if (truncated) {
			lines.push(`${text}\n… (truncated, showing first ${text.length} chars)`);
		} else {
			lines.push(text || '(empty)');
		}
		getOutputChannel().append(lines.join('\n') + '\n');
	} catch (e) {
		logError('[KaiCE] Failed to write response log:', e);
	}
}

/** 记录请求异常（网络错误 / 非 2xx / 流解析错误等） */
export function logRequestError(kind: RequestLogKind, modelId: string, error: unknown, uid: string): void {
	try {
		const kindLabel = kind === 'chat' ? 'Chat' : 'Inline Completion';
		const lines: string[] = [];
		lines.push(`[${kindLabel} Error] [UID ${uid}] Model: ${modelId}`);
		lines.push(`  ${error instanceof Error ? error.message : String(error)}`);
		getOutputChannel().append(lines.join('\n') + '\n');
	} catch {
		// 忽略日志自身异常
	}
}
