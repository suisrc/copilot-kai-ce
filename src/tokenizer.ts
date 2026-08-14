/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encode } from 'gpt-tokenizer/cjs/encoding/o200k_base';

/**
 * Token 计数。
 *
 * 整体参考 VS Code Copilot 扩展的 `extensions/copilot/src/platform/tokenizer/node/tokenizer.ts`
 * （BPETokenizer）。使用真实的 BPE 编码（o200k_base）而不是字符近似。
 */

/** BaseTokensPerCompletion 是最小补全请求 token 数(与 customendpoint 一致) */
export const BaseTokensPerCompletion = 3;

/** 每条 GPT 3.5/4 消息因特殊字符额外 3 token(与 customendpoint 一致) */
export const BaseTokensPerMessage = 3;

/** 消息 name 字段额外 1 token(与 customendpoint 一致) */
export const BaseTokensPerName = 1;

/** 简单 LRU 缓存,直接查 string -> token length */
class LRUCache<T> {
	private readonly _cache = new Map<string, T>();

	constructor(private readonly _maxSize: number) { }

	get(key: string): T | undefined {
		const value = this._cache.get(key);
		if (value === undefined) {
			return undefined;
		}
		// 命中后移到末尾(LRU)
		this._cache.delete(key);
		this._cache.set(key, value);
		return value;
	}

	put(key: string, value: T): void {
		this._cache.delete(key);
		this._cache.set(key, value);
		if (this._cache.size > this._maxSize) {
			// 删除最久未使用的(第一个)
			const oldestKey = this._cache.keys().next().value as string | undefined;
			if (oldestKey !== undefined) {
				this._cache.delete(oldestKey);
			}
		}
	}
}

//#region 文本 token 长度

const tokenCache = new LRUCache<number>(5000);

/** 真实 BPE 编码计算文本 token 长度 */
function textTokenLength(text: string): number {
	if (!text) {
		return 0;
	}
	let cached = tokenCache.get(text);
	if (cached === undefined) {
		cached = encode(text).length;
		tokenCache.put(text, cached);
	}
	return cached;
}

//#endregion

//#region 图片 token 成本（参考 customendpoint 的 calculateImageTokenCost）

function getImageDimensions(dataUrl: string): { width: number; height: number } {
	// 解析 data:image/...;base64, 头部,读取 PNG/JPEG/GIF/WebP 尺寸
	try {
		const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}

		// PNG: 前 8 字节签名, 16-24 字节是宽高(大端)
		if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
			return {
				width: (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19],
				height: (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23],
			};
		}

		// JPEG: SOI(FFD8) 后遍历标记段,查找 SOF0-SOF15
		if (bytes[0] === 0xff && bytes[1] === 0xd8) {
			let offset = 2;
			while (offset < bytes.length - 8) {
				if (bytes[offset] !== 0xff) {
					offset++;
					continue;
				}
				const marker = bytes[offset + 1];
				// 跳过填充 FF
				if (marker === 0xff) {
					offset++;
					continue;
				}
				// SOF 标记: C0-CF(不含 C4/C8/CC)
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return {
						height: (bytes[offset + 5] << 8) | bytes[offset + 6],
						width: (bytes[offset + 7] << 8) | bytes[offset + 8],
					};
				}
				const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
				offset += 2 + segmentLength;
			}
		}

		// GIF: 前 6 字节签名, 6-10 是宽高(小端)
		if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
			return {
				width: bytes[6] | (bytes[7] << 8),
				height: bytes[8] | (bytes[9] << 8),
			};
		}

		// WebP: RIFF....WEBP, VP8/VP8L/VP8X 尺寸
		if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
			const fourCC = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
			if (fourCC === 'VP8X') {
				const canvasWidth = 1 + ((bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) & 0xffffff);
				const canvasHeight = 1 + ((bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) & 0xffffff);
				return { width: canvasWidth, height: canvasHeight };
			}
			if (fourCC === 'VP8L') {
				const b0 = bytes[21];
				const b1 = bytes[22];
				const b2 = bytes[23];
				const b3 = bytes[24];
				const width = 1 + (((b1 & 0x3f) << 8) | b0);
				const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
				return { width, height };
			}
			if (fourCC === 'VP8 ') {
				return {
					width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
					height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
				};
			}
		}
	} catch {
		// 解析失败返回默认
	}

	return { width: 1024, height: 1024 };
}

/**
 * 计算图片 token 成本(参考 customendpoint 的 calculateImageTokenCost)。
 * 规则: https://platform.openai.com/docs/guides/vision#calculating-costs
 */
export function calculateImageTokenCost(imageUrl: string, detail: 'low' | 'high' | 'auto' | undefined): number {
	let { width, height } = getImageDimensions(imageUrl);

	if (detail === 'low') {
		return 85;
	}

	// 必要时缩放到 2048x2048 正方形内
	if (width > 2048 || height > 2048) {
		const scaleFactor = 2048 / Math.max(width, height);
		width = Math.round(width * scaleFactor);
		height = Math.round(height * scaleFactor);
	}

	const scaleFactor = 768 / Math.min(width, height);
	width = Math.round(width * scaleFactor);
	height = Math.round(height * scaleFactor);

	const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);

	return tiles * 170 + 85;
}

//#endregion

//#region 文档 token 成本（参考 customendpoint 的 estimateDocumentTokenCost）

/**
 * 估算 base64 文档(如 PDF)的 token 成本。用大小启发式,避免对大型二进制做 BPE。
 * 故意保守(高估)以避免超出上下文。
 */
export function estimateDocumentTokenCost(base64Data: string | undefined): number {
	if (!base64Data) {
		return 0;
	}
	// base64 将 3 字节编码为 4 字符,字节数 ≈ len * 3 / 4
	const length = base64Data.length;
	const estimatedBytes = Math.floor((length * 3) / 4);
	// 启发式:约 8 字节 ≈ 1 token
	const estimatedTokens = Math.ceil(estimatedBytes / 8);
	return estimatedTokens;
}

//#endregion

//#region 消息对象 token 计数（参考 customendpoint 的 countMessageObjectTokens）

interface TokenCountablePart {
	type?: string;
	text?: string;
	image_url?: { url?: string; detail?: 'low' | 'high' | 'auto' };
	tokenUsage?: number;
	[key: string]: unknown;
}

interface TokenCountableMessage {
	role: string;
	content?: string | TokenCountablePart[] | null;
	name?: string;
	tool_call_id?: string;
	tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
	[key: string]: unknown;
}

/** 递归统计消息对象各字段的 token 数(与 customendpoint 的 countMessageObjectTokens 一致) */
async function countMessageObjectTokens(obj: Record<string, unknown>): Promise<number> {
	let numTokens = 0;
	for (const [key, value] of Object.entries(obj)) {
		if (!value) {
			continue;
		}

		if (typeof value === 'string') {
			numTokens += textTokenLength(value);
		} else if (typeof value === 'object') {
			const casted = value as TokenCountablePart;
			if (casted.type === 'text' && typeof casted.text === 'string') {
				numTokens += textTokenLength(casted.text);
			} else if (casted.type === 'image_url' && casted.image_url?.url) {
				if (casted.image_url.url.startsWith('data:image/')) {
					try {
						numTokens += calculateImageTokenCost(casted.image_url.url, casted.image_url.detail);
					} catch {
						numTokens += textTokenLength(casted.image_url.url);
					}
				} else {
					numTokens += textTokenLength(casted.image_url.url);
				}
			} else {
				let newTokens = await countMessageObjectTokens(value as Record<string, unknown>);
				if (key === 'tool_calls') {
					// 估计值,加上一点安全余量
					newTokens = Math.floor(newTokens * 1.5);
				}
				numTokens += newTokens;
			}
		}

		if (key === 'name' && value !== undefined) {
			numTokens += BaseTokensPerName;
		}
	}

	return numTokens;
}

//#endregion

//#region 公开 API

/**
 * 计算文本 token 长度(真实 BPE,o200k_base)。
 */
export function countTextTokens(text: string): number {
	return textTokenLength(text);
}

/**
 * 计算单条 chat 消息的 token 数(含 BaseTokensPerMessage)。
 * 与 customendpoint 的 `countMessageTokens` 一致。
 */
export async function countMessageTokens(message: Record<string, unknown>): Promise<number> {
	return BaseTokensPerMessage + (await countMessageObjectTokens(message));
}

/**
 * 计算多条消息的 token 总数(含 BaseTokensPerCompletion)。
 * 与 customendpoint 的 `countMessagesTokens` 一致。
 */
export async function countMessagesTokens(messages: readonly TokenCountableMessage[]): Promise<number> {
	let numTokens = BaseTokensPerCompletion;
	for (const message of messages) {
		numTokens += await countMessageTokens(message);
	}
	return numTokens;
}

/**
 * 计算工具列表的 token 数(与 customendpoint 的 countToolTokens 一致)。
 */
export async function countToolTokens(tools: readonly { name: string; description?: string; inputSchema?: object }[]): Promise<number> {
	const baseToolTokens = 16;
	let numTokens = 0;
	if (tools.length) {
		numTokens += baseToolTokens;
	}

	const baseTokensPerTool = 8;
	for (const tool of tools) {
		numTokens += baseTokensPerTool;
		numTokens += await countMessageObjectTokens({ name: tool.name, description: tool.description, parameters: tool.inputSchema });
	}

	// 估计值,给一点安全余量
	return Math.floor(numTokens * 1.1);
}

//#endregion
