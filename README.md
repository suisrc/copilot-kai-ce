# KaiCE

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
          "defaultReasoningEffort": "high",
          "supportsReasoningEffort": ["none", "low", "medium", "high", "xhigh", "max"]
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
          "defaultReasoningEffort": "high",
          "supportsReasoningEffort": ["none", "low", "high", "max"]
        },
        {
          "id": "deepseek-v4-pro",
          "name": "kai-deepseek-v4-pro",
          "url": "https://api.deepseek.com/anthropic",
          "toolCalling": true,
          "vision": false,
          "maxInputTokens": 1000000,
          "maxOutputTokens": 100000,
          "defaultReasoningEffort": "high",
          "supportsReasoningEffort": ["none", "low", "high", "max"]
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
          "id": "glm-5.3",
          "name": "kai-glm-5.3",
          "url": "https://open.bigmodel.cn/api/anthropic",
          "toolCalling": true,
          "vision": false,
          "maxInputTokens": 1000000,
          "maxOutputTokens": 100000,
          "defaultReasoningEffort": "high",
          "supportsReasoningEffort": ["low", "high", "max"]
        },
        {
          "id": "glm-5.2",
          "name": "kai-glm-5.2",
          "url": "https://open.bigmodel.cn/api/anthropic",
          "toolCalling": true,
          "vision": false,
          "maxInputTokens": 1000000,
          "maxOutputTokens": 100000,
          "defaultReasoningEffort": "high",
          "supportsReasoningEffort": ["none", "low", "medium", "high", "xhigh", "max"]
        }
      ]
    },
    {
      "name": "deepseek-op",
      "vendor": "customendpoint",
      "apiKey": "${input:chat.lm.secret.deepseek}",
      "apiType": "messages",
      "models": [
        {
          "id": "deepseek-v4-flash",
          "name": "kai-deepseek-v4-op",
          "url": "https://api.deepseek.com/anthropic",
          "toolCalling": true,
          "vision": false,
          "maxInputTokens": 1000000,
          "maxOutputTokens": 100000,
          "defaultReasoningEffort": "high",
          "supportsReasoningEffort": ["none", "low", "high", "max", "low-op", "high-op", "max-op"],
          "metadata": {"user_id": "op-user-0001"},
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
| `models[]` | 模型列表，字段与 customendpoint 一致（`id` / `name` / `url` / `apiType` / `maxInputTokens` / `maxOutputTokens` / `contextWindow` / `toolCalling` / `vision` / `thinking` / `streaming` / `requestHeaders` / `modelOptions` / `metadata`） |


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

### 扩展字段（`metadata`）

用于补充协议未覆盖的请求体字段，按协议自适应注入：

- **Anthropic 协议**（`messages`）：作为请求体的 `metadata` 字段发送（如 `{"user_id":"xxx"}`）
  - Anthropic 顶层为封闭 schema，扩展字段须进 `metadata` 容器
- **OpenAI 协议**（`chat-completions` / `responses` / FIM 补全）：作为 `extraBody` 展开，合并到请求体顶层（如 `{"user":"xxx"}`）
  - OpenAI 采用顶层平铺设计，扩展字段为顶层命名参数

已存在的请求体字段优先，不被覆盖。

```jsonc
{
  "id": "my-model",
  "metadata": {"user_id": "log-user-0001"}
}
```

### 调试：`-op` 推理级别

`defaultReasoningEffort`（及 `supportsReasoningEffort` 条目）支持一种特殊的 `*-op` 写法：以全小写 `-op` 结尾时（大小写敏感，如 `high-op`；`high-OP` 不生效；`op` 为 output 缩写），KaiCE 会在 VS Code 的 OUTPUT 面板「KaiCE」通道打印本次请求的完整调试信息：

- **请求 Headers**（鉴权头部分打码）
- **请求 Body**：完整请求体（含 `model` / `messages` / `max_tokens` / `stream` / `reasoning_effort` 等参数，FIM 补全则为 `prompt` + `suffix`）
- **响应 Status + Headers**
- **响应 Body**（含 SSE 原始流）

每次请求会生成一个 UID（如 `[UID lzw4f-3kf9xq]`），同一请求的请求日志、响应日志与异常日志共用该 UID，便于在 OUTPUT 面板中关联定位。

`-op` 后缀仅作为调试开关，**不会写入请求体**：`high-op` 实际发送 `reasoning_effort: "high"`（或对应协议的 effort 字段）。`high` 与 `high-op` 是两个独立条目，可同时存在于 `supportsReasoningEffort` 列表中，picker 各自独立显示；是否启用调试日志完全由用户选择带 `-op` 后缀的条目决定。

```jsonc
{
  "id": "my-model",
  // high 与 high-op 并存：picker 各自独立显示，用户选哪个用哪个
  "supportsReasoningEffort": ["low", "medium", "high", "high-op"],
  // 默认启用调试日志：打印请求/响应详情到 OUTPUT 面板「KaiCE」，实际发送 reasoning_effort: "high"
  "defaultReasoningEffort": "high-op"
}
```

内联补全（`kaicustomendpoint.inlineCompletion.model.defaultReasoningEffort`）同样支持 `-op` 写法。

## 当前支持范围

- ✅ `chat-completions` API：文本、工具调用（tool calls）、图片输入（vision）、流式输出
- ✅ `responses` API：文本、工具调用（function call）、图片输入（vision）、流式输出
- ✅ `messages` API（Anthropic 兼容）：文本、工具调用（tool use）、图片输入（vision）、流式输出
- ✅ 内联补全（inline completion / ghost text）：FIM（prompt+suffix）格式，独立于 Copilot 登录/订阅

## 内联补全配置

通过 `kaicustomendpoint.inlineCompletion` 配置补全（可选，未配置则不注册补全 provider）：

```jsonc
{
  "kaicustomendpoint.inlineCompletion": {
    "pattern": "**",
    // 可选：限定语言（字符串或数组）
    // "language": ["typescript", "javascript"],
    // 可选：提示词模板，支持 {prefix} / {suffix} / {languageId}；缺省为标准 FIM
    // "prompt": "/* {languageId} */\n{prefix}",
    "model": {
      "apiKey": "${input:chat.lm.secret.deepseek}",
      "id": "deepseek-v4-flash",
      "name": "fim-deepseek-v4",
      "url": "https://api.deepseek.com/beta/completions",
      "defaultReasoningEffort": ""
    }
  }
}
```

补全请求使用 FIM（Fill-in-the-Middle）格式，body 为 `{ model, prompt, suffix, max_tokens, stream }`：

- `prompt` 为光标前的文本（前缀），`suffix` 为光标后的文本（后缀）
- `url` 必须是**全地址**（如 `https://api.deepseek.com/beta/completions`），不做路径拼接
- 自定义 `prompt` 模板时，渲染结果写入 `prompt` 字段，`suffix` 字段置空
- 前缀默认保留 2048 token、后缀 512 token（按完整行裁剪，保持代码结构）
- 请求失败静默（不弹错误提示），与 Copilot 无订阅时行为一致

## 已知限制

- API Key 明文存储（设计使然，解决 Web 刷新丢失问题）；可通过 `kaicustomendpoint.secrets` + 引用语法分离密钥
- `editTools` / Thinking Effort picker 依赖 proposed API（`chatProvider`），本扩展未声明 `enabledApiProposals`，运行时为 `undefined` 被 VS Code 忽略（不影响 `defaultReasoningEffort` / `zeroDataRetentionEnabled`）
- 内联补全为一次性返回完整补全（stable API 不支持 AsyncIterable 渐进式渲染，那是 Copilot 内部私有通道）
