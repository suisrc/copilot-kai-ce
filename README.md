# Kai Custom Endpoint

基于 VS Code `customendpoint` 模型供应商重构的对话模型供应商扩展。

## 解决的问题

Web 版本的 VS Code 将 `chatLanguageModels.json` 保存在浏览器的 IndexedDB 中，刷新页面或更换浏览器后配置即丢失；API Key 出于安全设计也只保存在内存中（刷新即丢）。

本扩展将模型配置与 API Key **明文保存在 `settings.json`**（`kaicustomendpoint.models`），由 VS Code 原生持久化，并可随 Settings Sync 同步，刷新不再丢失。

> ⚠️ **安全提示**：API Key 为明文存储。请勿将含密钥的 `settings.json` 提交到代码仓库或分享给他人。

## 安装与开发

```bash
npm install
npm run compile
```

然后在 VS Code 中通过「开发主机：重新加载窗口」或 F5 调试加载本扩展目录。

## 配置

在 `settings.json` 中配置 `kaicustomendpoint.models`，结构与 `chatLanguageModels.json` 保持一致（provider groups 数组），可直接迁移：

```jsonc
{
  "kaicustomendpoint.models": [
    {
      "vendor": "customendpoint",
      "name": "my-local-gateway",
      "apiKey": "sk-xxxx",                 // 明文，留空则不带 Authorization 头
      "apiType": "chat-completions",       // chat-completions | responses | messages
      "url": "http://localhost:8000/v1",   // 分组级默认 Base URL（可选）
      "models": [
        {
          "id": "gpt-4o-mini",
          "name": "GPT-4o Mini",
          "maxInputTokens": 128000,
          "maxOutputTokens": 16000,
          "toolCalling": true,
          "vision": true
        },
        {
          "id": "deepseek-coder",
          "url": "http://localhost:8000/v1", // 模型级 URL 覆盖（可选）
          "maxInputTokens": 64000,
          "maxOutputTokens": 8192,
          "toolCalling": false
        }
      ]
    }
  ]
}
```

### 从 `chatLanguageModels.json` 迁移

1. 复制 `chatLanguageModels.json` 中的整个数组到 `kaicustomendpoint.models`
2. `vendor` 保持 `customendpoint` 不变（致敬官方命名，零修改迁移）

### 字段说明

| 字段 | 说明 |
|---|---|
| `vendor` | 固定为 `customendpoint`（致敬官方命名；本扩展注册 ID 为 `kaicustomendpoint`） |
| `name` | 分组名称，模型选择器中用于区分同供应商的多个分组 |
| `apiKey` | 明文 API Key；留空则不带 `Authorization` 头 |
| `apiType` | `chat-completions`（默认）/ `responses` / `messages`（均完整支持） |
| `url` | Base URL，支持显式 API 路径；自动拼接 `/v1` + API 路径 |
| `models[]` | 模型列表，字段与 customendpoint 一致（`id` / `name` / `url` / `apiType` / `maxInputTokens` / `maxOutputTokens` / `contextWindow` / `toolCalling` / `vision` / `thinking` / `streaming` / `requestHeaders` / `modelOptions`） |

### 自定义请求头

`requestHeaders` 可用于自定义网关的鉴权方式（如 `x-api-key`），并允许覆盖 `authorization` 与 `api-key`：

```jsonc
{
  "id": "my-model",
  "requestHeaders": {
    "x-api-key": "my-secret"
  }
}
```

## 当前支持范围

- ✅ `chat-completions` API：文本、工具调用（tool calls）、图片输入（vision）、流式输出
- ✅ `responses` API：文本、工具调用（function call）、图片输入（vision）、流式输出
- ✅ `messages` API（Anthropic 兼容）：文本、工具调用（tool use）、图片输入（vision）、流式输出
- ⏳ 内联提示词（inline completion）：另行规划

## 已知限制

- API Key 明文存储（设计使然，解决 Web 刷新丢失问题）
- Token 计数使用真实 BPE 编码（o200k_base，`gpt-tokenizer`），与官方 customendpoint 一致
- 不支持 `LanguageModelThinkingPart`（proposed API，后续可选启用）
