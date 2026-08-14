# Kai CE

基于 VS Code `customendpoint` 模型供应商重构的对话模型供应商扩展。

## 解决的问题

Web 版本的 VS Code 将 `chatLanguageModels.json` 保存在浏览器的 IndexedDB 中，刷新页面或更换浏览器后配置即丢失；API Key 出于安全设计也只保存在内存中（刷新即丢）。

本扩展将模型配置与 API Key **明文保存在 `settings.json`**（`kaicustomendpoint.models`），由 VS Code 原生持久化，并可随 Settings Sync 同步，刷新不再丢失。

> ⚠️ **安全提示**：API Key 为明文存储。请勿将含密钥的 `settings.json` 提交到代码仓库或分享给他人，建议使用 [user-data] 在浏览器缓存中存储 kaicustomendpoint.secrets 内容， 服务器上只存储 kaicustomendpoint.models 信息。

然后在 VS Code 中通过「开发主机：重新加载窗口」或 F5 调试加载本扩展目录。

## 配置

在 `settings.json` 中配置 `kaicustomendpoint.models`，结构与 `chatLanguageModels.json` 保持一致（provider groups 数组），可直接迁移：

```jsonc
{
  // 密钥映射表,建议使用 user-data 存储，与 models 分开存储
  "kaicustomendpoint.secrets": {
    "alibaba": "sk-xxxxxxxxxxxx",
    "deepseek": "sk-xxxxxxxxxxxx",
    "bigmodel": "sk-xxxxxxxxxxxx"
  },
  // 模型配置中引用
  "kaicustomendpoint.models": [
    {
      "name": "alibaba",
      "vendor": "customendpoint",
      "apiKey": "${input:chat.lm.secret.alibaba}",
      "apiType": "messages",
      "models": [
        {
          "id": "qwen3.7-plus",
          "name": "kai-qwen3.7-plus",
          "url": "https://dashscope.aliyuncs.com/apps/anthropic",
          "toolCalling": true,
          "vision": true,
          "maxInputTokens": 256000,
          "maxOutputTokens": 16000,
          "supportsReasoningEffort": ["low", "medium", "high", "xhigh"]
        }
      ]
    },
    {
      "name": "deepseek",
      "vendor": "customendpoint",
      "apiKey": "${input:chat.lm.secret.deepseek}",
      "apiType": "messages",
      "models": [
        {
          "id": "deepseek-v4-flash",
          "name": "kai-deepseek-v4-flash",
          "url": "https://api.deepseek.com/anthropic",
          "toolCalling": true,
          "vision": false,
          "maxInputTokens": 1000000,
          "maxOutputTokens": 100000,
          "supportsReasoningEffort": ["low", "medium", "high", "xhigh"]
        },
        {
          "id": "deepseek-v4-pro",
          "name": "kai-deepseek-v4-pro",
          "url": "https://api.deepseek.com/anthropic",
          "toolCalling": true,
          "vision": false,
          "maxInputTokens": 1000000,
          "maxOutputTokens": 100000,
          "supportsReasoningEffort": ["low", "medium", "high", "xhigh"]
        }
      ]
    },
    {
      "name": "bigmodel",
      "vendor": "customendpoint",
      "apiKey": "${input:chat.lm.secret.bigmodel}",
      "apiType": "messages",
      "models": [
        {
          "id": "glm-5.2",
          "name": "kai-glm-5.2",
          "url": "https://open.bigmodel.cn/api/anthropic",
          "toolCalling": true,
          "vision": false,
          "maxInputTokens": 1000000,
          "maxOutputTokens": 100000,
          "supportsReasoningEffort": ["low", "medium", "high", "xhigh"]
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
| `apiKey` | API Key，支持两种写法：明文（如 `"sk-xxxx"`）或引用（`"${input:chat.lm.secret.<id>}"`，从 `kaicustomendpoint.secrets` 查找）；留空则不带 `Authorization` 头 |
| `apiType` | `chat-completions`（默认）/ `responses` / `messages`（均完整支持） |
| `url` | Base URL，支持显式 API 路径；自动拼接 `/v1` + API 路径 |
| `models[]` | 模型列表，字段与 customendpoint 一致（`id` / `name` / `url` / `apiType` / `maxInputTokens` / `maxOutputTokens` / `contextWindow` / `toolCalling` / `vision` / `thinking` / `streaming` / `requestHeaders` / `modelOptions`） |


如果不想将 API Key 直接写在模型配置中，可以使用引用语法将密钥分离到 `kaicustomendpoint.secrets`：
引用语法 `${input:chat.lm.secret.<id>}` 与 VS Code Copilot 的 `chatLanguageModels.json` 兼容，迁移时无需修改 apiKey 引用。

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

- API Key 明文存储（设计使然，解决 Web 刷新丢失问题）；可通过 `kaicustomendpoint.secrets` + 引用语法分离密钥
- `editTools` / Thinking Effort picker 依赖 proposed API（`chatProvider`），需通过 vsix 安装生效；发布到 Marketplace 时需移除 `enabledApiProposals`
