/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kai. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 轻量级 token 估算（不依赖 BPE 编码库）。
 *
 * ## 背景
 *
 * 原方案使用 `gpt-tokenizer` 的 `o200k_base` BPE 编码进行精确 token 计数
 * （参考 VS Code Copilot 扩展的 `extensions/copilot/src/platform/tokenizer/node/tokenizer.ts`）。
 * 该方案基于 OpenAI 的 tiktoken `o200k_base` 词表，通过 BPE（Byte Pair Encoding）
 * 将文本拆分为子词序列并计数，精度最高。
 *
 * 但 `gpt-tokenizer` 基于 CJS 模块，打包后包含 4.76MB 词表数据（187 个文件），
 * 对于仅需 token 计数显示和上下文窗口检查的场景过于沉重。
 *
 * 本方案改用轻量级字符估算，按字符类型分类统计：
 * - 英文/数字：约 4 字符 ≈ 1 token
 * - CJK（中日韩）：约 1.5 字符 ≈ 1 token（BPE 对 CJK 拆分更细）
 * - 代码/标点符号：约 3 字符 ≈ 1 token
 * - 空白符：约 4 字符 ≈ 1 token
 *
 * 误差通常在 ±10% 以内，对 token 计数显示和上下文窗口检查足够用。
 *
 * 如需精确计数，可恢复 tokenizer.ts 中对 `gpt-tokenizer/cjs/encoding/o200k_base`
 * 的导入，并将 `estimateTokens` 替换为 `encode(text).length`。
 */

/** BaseTokensPerCompletion 是最小补全请求 token 数 */
export const BaseTokensPerCompletion = 3;

/** 每条消息因特殊字符额外 token 数 */
export const BaseTokensPerMessage = 3;

/** 消息 name 字段额外 token 数 */
export const BaseTokensPerName = 1;

// CJK Unicode 范围（常用区间，覆盖中日韩文字）
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x4e00, 0x9fff],   // CJK Unified Ideographs
	[0x3400, 0x4dbf],   // CJK Extension A
	[0x3000, 0x30ff],   // CJK Symbols + Hiragana + Katakana
	[0xff00, 0xffef],   // Fullwidth Forms
	[0x3040, 0x309f],   // Hiragana
	[0xac00, 0xd7af],   // Hangul Syllables
];

function isCJK(code: number): boolean {
	for (const [start, end] of CJK_RANGES) {
		if (code >= start && code <= end) {
			return true;
		}
	}
	return false;
}

/** 判断是否为代码/标点符号字符 */
function isPunctuationOrSymbol(code: number): boolean {
	// ASCII 标点符号与特殊字符
	if (code >= 0x21 && code <= 0x2f) { return true; }
	if (code >= 0x3a && code <= 0x40) { return true; }
	if (code >= 0x5b && code <= 0x60) { return true; }
	if (code >= 0x7b && code <= 0x7e) { return true; }
	// 全角标点
	if (code >= 0x3000 && code <= 0x303f) { return true; }
	return false;
}

/**
 * 估算文本的 token 数。
 * 策略：遍历字符，按 CJK / 标点 / 普通字符分类累积权重。
 */
export function estimateTokens(text: string): number {
	if (!text) {
		return 0;
	}

	let tokens = 0;
	let cjkCount = 0;
	let punctCount = 0;
	let otherCount = 0;
	let spaceCount = 0;

	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
			spaceCount++;
		} else if (isCJK(code)) {
			cjkCount++;
		} else if (isPunctuationOrSymbol(code)) {
			punctCount++;
		} else {
			otherCount++;
		}
	}

	// CJK: 约 1.5 字符/token
	tokens += Math.ceil(cjkCount / 1.5);
	// 标点/符号: 约 3 字符/token
	tokens += Math.ceil(punctCount / 3);
	// 普通字符(英文/数字): 约 4 字符/token
	tokens += Math.ceil(otherCount / 4);
	// 空白: 约 4 字符/token
	tokens += Math.ceil(spaceCount / 4);

	return tokens;
}
