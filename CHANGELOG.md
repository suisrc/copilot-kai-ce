# Change Log

## [0.0.1] - 2026-08-14

### Added

- 基于 VS Code `customendpoint` 重构的对话模型供应商（vendor: `customendpoint`）
- 模型配置与 API Key 明文保存在 `settings.json`（`kaicustomendpoint.models`），结构与 `chatLanguageModels.json` 一致，解决 Web 版刷新丢失问题
- 支持 `chat-completions` API：文本、工具调用、图片输入（vision）、流式输出
- 配置变更实时刷新模型列表
