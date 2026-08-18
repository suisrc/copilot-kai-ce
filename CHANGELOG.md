# Change Log / 更新日志

## [0.0.3] - 2026-08-18

### 修复 / Fixed

1. 修复对话用量统计失效，上下文压缩恢复正常 — Fixed usage stats not updating; context compaction works again
2. 修复未配置上下文窗口时模型无法使用的问题 — Fixed models failing when no context window is configured
3. 修复流式输出不显示文字，思考过程实时可见 — Fixed streaming output; thinking is now shown in real time
4. 修复内联补全请求头未做安全过滤，存在 HTTP 头注入风险 — Fixed inline completion headers not sanitized (HTTP header injection risk)

### 改进 / Improved

1. 优化流式渲染，文字与思考过程输出更流畅 — Smoother streaming for text and thinking output
2. 提升 token 计数与配置读取速度，响应更迅速 — Faster token counting and config loading
3. 优化内联补全上下文读取，大文件打字不卡顿 — Faster inline completion in large files

## [0.0.2] - 2026-08-18

### 新增 / Added

1. 新增内联补全（代码联想）功能，独立于 Copilot 使用 — Added inline code completion, independent of Copilot
2. 新增 KaiCE 调试日志功能，方便排查连接问题 — Added KaiCE debug logging for easier troubleshooting
3. 新增一键发布扩展的功能，清理废弃的旧版接口 — Added one-click publishing; removed legacy APIs

### 改进 / Improved

1. 移除重量级分词库依赖，扩展体积更小更轻量 — Removed heavy tokenizer dependency; lighter extension
2. 日志输出改为并发安全，多请求不再穿插混乱 — Concurrency-safe logging; no more mixed log lines

### 修复 / Fixed

1. 修复模型列表重复显示、工具配置为空的问题 — Fixed duplicate models and empty tool configs
2. 修复模型分组相互覆盖，工具调用默认开启 — Fixed overlapping model groups; tool calling on by default

## [0.0.1] - 2026-08-14

### 新增 / Added

1. 首个版本，提供自定义对话模型供应商接入能力 — First release with custom chat model provider support
2. 模型配置与密钥保存在 settings.json，刷新不丢失 — Config and keys saved in settings.json, survive refresh
3. 支持对话、工具调用、图片识别和流式输出 — Supports chat, tools, vision and streaming
4. 修改配置后实时刷新模型列表，无需重启 — Model list refreshes instantly on config change
