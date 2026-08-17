# Change Log

## [0.0.2] - 2026-08-18

### Added

- 新增内联补全（inline completion / ghost text），FIM prompt + suffix 独立于 Copilot 登录
- KaiCE 调试日志（`-op` 后缀）、metadata 协议自适应注入、全局更名（vendor: `customendpoint` → `kaicustomendpoint`）
- 新增 `vsce publish` 发布目标，移除废弃的 `chatProvider` API 提案

### Changed

- 移除 `gpt-tokenizer` 依赖，改用轻量级字符估算（`cjs_encode.ts`）
- 日志并发安全重构，SSE 按协议合并
- 移除 `enabledApiProposals` 相关描述，同步更新 roadmap 与 README

### Fixed

- 修复模型列表重复、工具 schema 为空以及 vendor 冲突问题
- registry id 分组防覆盖，`toolCalling` 默认开启

## [0.0.1] - 2026-08-14

### Added

- 基于 VS Code `customendpoint` 重构的对话模型供应商（vendor: `customendpoint`）
- 模型配置与 API Key 明文保存在 `settings.json`（`kaicustomendpoint.models`），结构与 `chatLanguageModels.json` 一致，解决 Web 版刷新丢失问题
- 支持 `chat-completions` API：文本、工具调用、图片输入（vision）、流式输出
- 配置变更实时刷新模型列表
