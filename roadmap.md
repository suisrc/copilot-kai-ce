# KaiCE — 开发路线图

> 本文件是开发的一手参考。修改代码前先读本文件,避免重复分析。
> 核心原则:**整体参考 VS Code Copilot 扩展的 `customendpoint` 实现**(`extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts` 及下游链路),不自己发明协议处理逻辑。只在「配置存储(settings.json 明文)」与「不依赖 copilot 私有服务」两点上偏离。

---

## 〇、开发约束(源自 `extensionsCG/agents.md`)

> **所有开发只能在 `extensionsCG/` 文件夹内完成。**
> 当前整个目录是 VS Code 软件的仓库镜像,仅供开发参考,**不要进行任何修改**。
>
> 具体约束:
> 1. 只修改 `extensionsCG/copilot-kai-ce/` 下的文件
> 2. `extensions/copilot/`、`src/vs/` 等仓库代码为只读参考,禁止编辑
> 3. 修改代码后需更新本路线图(`roadmap.md`),便于后续开发无需重新分析

---

## 一、项目目标

基于 VS Code 官方 Copilot 扩展的 `customendpoint` 模型供应商重构的独立对话模型供应商扩展,解决:

1. **Web 版 `chatLanguageModels.json` 丢失问题**:该文件在 Web 版存于浏览器 IndexedDB,刷新/换浏览器即丢。
2. **API Key 丢失问题**:Web 版 secrets 用内存存储(浏览器无安全密钥存储),刷新即丢。

**方案**:模型配置(含 API Key 明文)放入 `settings.json` 的 `kaicustomendpoint.models`(结构与 `chatLanguageModels.json` 的 provider groups 完全一致,零修改迁移),由 VS Code 原生持久化 + Settings Sync。

## 二、关键命名约定(vendor 双轨制)

| 用途 | 值 | 常量 | 说明 |
|---|---|---|---|
| 配置里 `vendor` 字段 | `customendpoint` | `CONFIG_VENDOR` | **致敬官方**,与 chatLanguageModels.json 一致,迁移零修改 |
| 工具注册 ID | `kaicustomendpoint` | `PROVIDER_VENDOR` | 系统唯一性,避免与官方扩展冲突 |
| 激活事件 | `onLanguageModelChatProvider:kaicustomendpoint` | — | 对应注册 ID |
| 配置键 | `kaicustomendpoint.models` | `CONFIG_MODELS_KEY` | settings.json 中的数组键 |

## 三、文件结构

```
extensionsCG/copilot-kai-ce/
├── package.json        # 扩展清单:vendor 贡献点 + 配置 schema
├── tsconfig.json
├── .vscodeignore
├── Makefile            # 构建 & 打包(make build / make package / make publish / make clean)
├── README.md           # 使用说明、迁移指南
├── CHANGELOG.md
├── roadmap.md          # 本文件
├── src/
│   ├── extension.ts    # 入口:注册 provider + 监听配置变更(onDidChangeConfiguration)
│   ├── provider.ts     # KaiCustomEndpointProvider:LanguageModelChatProvider 实现(核心)
│   │                   #   含 sanitizeCustomHeaders(请求头安全过滤)
│   │                   #   含 mergedModelOptions(请求级参数合并)
│   │                   #   含 applyReasoningEffort(推理努力级别写入请求体)
│   │                   #   含 System 消息处理、reasoning_content 输出
│   ├── client.ts       # 网关客户端:URL 解析 + 三种协议请求构造 + 通用 SSE 解析
│   │                   #   + FIM 补全请求构造(buildKaiCompletionRequest/streamKaiCompletions)
│   ├── cjs_encode.ts   # 轻量级 token 估算:字符分类统计(英文≈4字符/token、CJK≈1.5、标点≈3、空白≈4),误差±10%,替代 gpt-tokenizer BPE
│   ├── tokenizer.ts    # token 计数:轻量估算(基于 cjs_encode.ts)+ LRU 缓存 + 图片/文档/消息/工具计数
│   ├── config.ts       # 读取 kaicustomendpoint.models(vendor 过滤)+ inlineCompletion
│   ├── completions.ts  # KaiInlineCompletionProvider:内联补全(FIM prompt+suffix,独立于 Copilot)
│   └── types.ts        # 类型定义 + vendor 常量
├── out/                # 编译输出(tsc → JS)
└── dist/               # 打包产物(vsix)
```

## 四、与 customendpoint 的对应关系(参考映射)

| customendpoint 源码 | 本扩展对应 | 状态 |
|---|---|---|
| `customEndpointProvider.ts` — `CustomEndpointBYOKModelProvider` | `provider.ts` | ✅ 已实现(重构) |
| `customEndpointProvider.ts` — `CustomEndpointOAIEndpoint`(鉴权头) | `provider.ts` `buildRequestHeaders` | ✅ 已实现 |
| `customEndpointProvider.ts` — URL 解析函数 | `client.ts` URL 解析区 | ✅ 已实现 |
| `openAIEndpoint.ts` — `ChatEndpoint`(请求构造/流处理) | `client.ts` + `provider.ts` 流处理 | ✅ 已实现(简化) |
| `openAIEndpoint.ts` — `_sanitizeCustomHeaders`(请求头安全过滤) | `provider.ts` `sanitizeCustomHeaders` | ✅ 已实现 |
| `openAIEndpoint.ts` — `_applyConfiguredModelOptions`(请求级参数合并) | `provider.ts` `mergedModelOptions` | ✅ 已实现 |
| `messagesApi.ts` — `createMessagesRequestBody` / 流处理 | `client.ts` `buildMessagesRequest` + `provider.ts` `processMessagesStream` | ✅ 已实现 |
| `responsesApi.ts` — `createResponsesRequestBody` / 流处理 | `client.ts` `buildResponsesRequest` + `provider.ts` `processResponsesStream` | ✅ 已实现 |
| `abstractLanguageModelChatProvider.ts` — `AbstractOpenAICompatibleLMProvider` | `provider.ts`(合并,无继承) | ✅ 已实现 |
| `tokenizer.ts` — `BPETokenizer` / `countMessageTokens` / `calculateImageTokenCost` | `tokenizer.ts` + `cjs_encode.ts` | ✅ 已实现(轻量字符估算替代 gpt-tokenizer BPE,结构保留) |
| `byokStorageService.ts` — secrets 存储 | 直接用 settings.json(明文) | ✅ 重新设计 |
| `byokProvider.ts` — `resolveModelInfo` / `byokKnownModelToAPIInfo` | `provider.ts` `provideLanguageModelChatInformation` | ✅ 已实现 |
| System 消息处理(chat-completions/responses) | `provider.ts` `toOpenAIMessages` / `toResponsesInput` | ✅ 已实现 |
| `reasoning_content` 流式输出 | `provider.ts` `processChatCompletionsStream` | ✅ 已实现 |
| `reasoningEffortFormat` / `defaultReasoningEffort` / `supportsReasoningEffort` | `provider.ts` `applyReasoningEffort` + `package.json` schema + `types.ts` | ✅ 已实现（`defaultReasoningEffort` 直接写入请求体，不依赖 proposed API；picker UI 因 `enabledApiProposals` 已移除不再渲染） |
| `editTools` / `zeroDataRetentionEnabled` | `provider.ts` + `package.json` schema + `types.ts` | ✅ 已实现（`enabledApiProposals` 已移除：`editTools` 运行时为 `undefined` 被 VS Code 忽略；`zeroDataRetentionEnabled` 由 kai 自行处理 `store` 字段，不依赖 proposed API） |
| Thinking Effort picker UI（`configurationSchema`） | `provider.ts` `provideLanguageModelChatInformation` | ✅ 已实现（`enabledApiProposals` 已移除，picker 不再渲染；`defaultReasoningEffort` 直接写入请求体仍生效，不依赖 proposed API） |
| `fetch.ts` — `CompletionRequest`（FIM prompt+suffix 请求） | `client.ts` `buildKaiCompletionRequest` + `completions.ts` | ✅ 已实现（补全固定走 FIM `/completions`，`url` 为全地址不做路径拼接） |
| `componentsCompletionsPromptFactory.tsx` — prefix/suffix 上下文组装 | `completions.ts` `extractContext`（token 预算按完整行裁剪） | ✅ 已实现（简化：无相似文件/诊断等上下文，仅前缀后缀） |
| `vscodeInlineCompletionItemProvider.ts` — `provideInlineCompletionItems` | `completions.ts` `KaiInlineCompletionProvider` | ✅ 已实现（stable API 一次性返回；渐进式渲染为 Copilot 私有通道，不支持） |

## 五、三种协议支持状态

| 协议 | 端点 URL | 请求构造 | 流式解析 | 能力 |
|---|---|---|---|---|
| `chat-completions` | `/v1/chat/completions` | `buildChatCompletionRequest` | `processChatCompletionsStream` | 文本、工具调用(tool_calls 增量组装)、vision、流式、System 消息、reasoning_content |
| `responses` | `/v1/responses` | `buildResponsesRequest` | `processResponsesStream` | 文本、function_call(item_id 增量组装)、vision、流式、System 消息 |
| `messages` | `/v1/messages` | `buildMessagesRequest` | `processMessagesStream` | 文本、tool_use(content_block 增量)、vision、流式、System 消息(system 字段) |

**鉴权头**(参考 `CustomEndpointOAIEndpoint.getExtraHeaders`):
- `chat-completions` / `responses`:`Authorization: Bearer <apiKey>`;Azure 端点用 `api-key`
- `messages`:`x-api-key: <apiKey>` + `anthropic-version: 2023-06-01`
- 用户 `requestHeaders` 可覆盖,支持 `${apiKey}` 插值
- 若用户提供鉴权头则抑制默认头(参考 `_userAuthHeaderSuppressionSet`)
- 用户自定义头经 `sanitizeCustomHeaders` 安全过滤(参考 `OpenAIEndpoint._sanitizeCustomHeaders`):
  保留头检查、头名称格式验证(RFC 7230)、长度限制、控制字符过滤(防 HTTP header injection)、`proxy-*`/`sec-*` 模式过滤

**请求级参数合并**(参考 `OpenAIEndpoint._applyConfiguredModelOptions`):
- `options.modelOptions`(请求级,如调用方传入的 `temperature`)与 `model.modelOptions`(配置级)合并
- 请求级值优先于配置级值

## 六、token 计数(已实现,`tokenizer.ts` + `cjs_encode.ts`)

**当前状态**:✅ 已重写。文本计数改用轻量级字符估算(`cjs_encode.ts` 的 `estimateTokens`,不依赖 BPE 库);消息/工具/图片/文档计数与 LRU 缓存结构保留 customendpoint 参考实现。

**背景**:原方案用 npm `gpt-tokenizer`(o200k_base BPE)做精确计数,但该包为 CJS 模块,打包后含 4.76MB 词表数据(187 个文件),对仅需计数显示与上下文窗口检查的场景过重,故移除(commit `8c62403`)。

**本扩展实现**(`src/tokenizer.ts` + `src/cjs_encode.ts`):

1. **文本估算 `estimateTokens(text)`**(`cjs_encode.ts`):遍历字符按类型累计权重——
   - 英文/数字:约 4 字符 ≈ 1 token
   - CJK(中日韩):约 1.5 字符 ≈ 1 token(BPE 对 CJK 拆分更细)
   - 代码/标点符号:约 3 字符 ≈ 1 token
   - 空白符:约 4 字符 ≈ 1 token
   - 误差通常在 ±10% 以内,对计数显示/上下文窗口检查足够用
2. **`countTextTokens(text)`**(`tokenizer.ts`):`estimateTokens` + LRU 5000 缓存。
3. **`countMessageTokens(message)`**:`BaseTokensPerMessage(3)` + 递归遍历消息对象各字段。
4. **`countToolTokens(tools)`**:16(有工具时)+ 8×工具数 + 工具对象 tokens,结果 ×1.1。
5. **图片成本 `calculateImageTokenCost(url, detail)`**:
   - `detail === 'low'` → 85
   - 超 2048×2048 缩放;再按 768 缩放;tiles = ceil(w/512)×ceil(h/512);成本 = tiles×170 + 85
6. **文档成本 `estimateDocumentTokenCost(base64)`**:字节数 ≈ len×3/4,约 8 字节 ≈ 1 token。
7. **常量**:`BaseTokensPerMessage = 3`、`BaseTokensPerName = 1`、`BaseTokensPerCompletion = 3`。

**注意**:`countTextTokens` 只处理纯文本;image/document 等特殊 part 需按 `calculateImageTokenCost` / `estimateDocumentTokenCost` 分发,不能只对文本编码。

**如需精确计数**:恢复 `tokenizer.ts` 中对 `gpt-tokenizer/cjs/encoding/o200k_base` 的导入,将 `estimateTokens` 替换为 `encode(text).length`(见 `cjs_encode.ts` 头部注释)。

## 七、已完成的验证

- 编译:`npm run compile` 通过(零错误)
- 编辑器诊断:零错误
- 打包:`make clean && make package` 通过,vsix 正常生成(2.07 MB)
- URL 解析冒烟测试:11/11 通过(三种协议路径、显式路径、版本号、尾部斜杠)
- SSE 解析冒烟测试:5/5 通过(纯 data 流、event+data 流、[DONE] 终止)
- vendor 双轨制一致性:通过(注册 ID `kaicustomendpoint`,配置值 `customendpoint`)
- token 计数轻量化:移除 gpt-tokenizer(4.76MB 词表,187 文件)→ `cjs_encode.ts` 字符估算(±10%),打包体积显著下降
- 内联补全:stable API 一次性返回,`buildKaiCompletionRequest` FIM prompt+suffix 请求验证通过

## 八、待办清单(按优先级)

- [x] **P0 token 计数重写**:新建 `src/tokenizer.ts` + `src/cjs_encode.ts`,保留 customendpoint 结构(LRU 缓存 + countMessageTokens + countToolTokens + 图片/文档成本),文本计数改用轻量级字符估算(`estimateTokens`)替代 gpt-tokenizer BPE
- [x] P1 更新 README 的「已知限制」(Token 计数为轻量级字符估算,误差 ±10%;并移除 gpt-tokenizer 相关说明)
- [x] P2 配置 schema 补全 customendpoint 剩余字段（`editTools`、`zeroDataRetentionEnabled`、`supportsReasoningEffort`、`reasoningEffortFormat`、`defaultReasoningEffort`）——全部已实现：`editTools` 传递到 capabilities（`enabledApiProposals` 已移除，运行时为 `undefined` 被 VS Code 忽略）、`zeroDataRetentionEnabled` 控制 Responses API `store`（不依赖 proposed API）、`applyReasoningEffort` 使用 `defaultReasoningEffort` 写入请求体（picker 因 proposed API 移除不再渲染）
- [x] P3 内联提示词(inline completion)——已实现：`completions.ts` `KaiInlineCompletionProvider`，FIM prompt+suffix 请求，独立于 Copilot 登录/订阅。`kaicustomendpoint.inlineCompletion` 配置（`pattern` + 可选 `language`/`prompt` + `model`），`url` 为全地址不做路径拼接。stable API 一次性返回（渐进式渲染为 Copilot 私有通道，不支持）
- [ ] P4 实际端点联调测试(本地 Ollama / vLLM 网关)

## 九、proposed API 使用说明

`package.json` 中的 `enabledApiProposals: ["chatProvider"]` **已移除**(commit `af60f3f`,面向 Marketplace 发布,仅使用 stable API)。

移除后的实际行为:

| 功能 | 状态 | 说明 |
|---|---|---|
| `editTools` | ❌ 失效 | `LanguageModelChatCapabilities.editTools` 为 proposed API,运行时为 `undefined`,VS Code 忽略 |
| `zeroDataRetentionEnabled` | ✅ 生效 | 不依赖 proposed API,kai 自行处理 Responses API 的 `store: false` |
| `defaultReasoningEffort` + `reasoningEffortFormat` | ✅ 生效 | `applyReasoningEffort` 直接写入请求体,不依赖 proposed API |
| Thinking Effort picker | ❌ 不渲染 | `configurationSchema` / `modelConfiguration` 为 proposed API,运行时为 `undefined`,模型选择器中不再显示下拉选择器 |

代码无需修改:所有 proposed API 字段均以可选方式传递(运行时为 `undefined` 即被忽略)。

## 十、参考源码索引(只读,勿改仓库)

> 以下文件位于 VS Code 仓库镜像中,仅供开发参考,**禁止修改**(见第〇节开发约束)。

| 文件 | 用途 |
|---|---|
| `extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts` | 供应商主类、URL 解析、OAI 端点子类、`getExtraHeaders`、`_userAuthHeaderSuppressionSet` |
| `extensions/copilot/src/extension/byok/vscode-node/abstractLanguageModelChatProvider.ts` | 抽象基类、消息转换入口 |
| `extensions/copilot/src/extension/byok/node/openAIEndpoint.ts` | `_sanitizeCustomHeaders`、`_reservedHeaders`、`_applyConfiguredModelOptions`、`createRequestBody` |
| `extensions/copilot/src/extension/byok/common/byokProvider.ts` | `resolveModelTokenLimits`、`resolveModelInfo`、`byokKnownModelToAPIInfo` |
| `extensions/copilot/src/extension/byok/vscode-node/byokModelInfo.ts` | `byokKnownModelToAPIInfoWithEffort`(reasoning effort schema) |
| `extensions/copilot/src/extension/byok/vscode-node/byokStorageService.ts` | secrets 存储(本扩展用 settings.json 明文替代) |
| `extensions/copilot/src/extension/conversation/vscode-node/languageModelAccess.ts` | `provideTokenCount`、`CopilotLanguageModelWrapper` |
| `extensions/copilot/src/platform/endpoint/node/chatEndpoint.ts` | 请求构造分发、`getExtraHeaders`、`getAnthropicBetaHeader` |
| `extensions/copilot/src/platform/endpoint/node/messagesApi.ts` | Messages API 请求构造与流处理 |
| `extensions/copilot/src/platform/endpoint/node/responsesApi.ts` | Responses API 请求构造与流处理 |
| `extensions/copilot/src/platform/tokenizer/node/tokenizer.ts` | BPETokenizer、token 计数、图片/文档成本 |
| `extensions/copilot/src/util/common/imageUtils.ts` | `getImageDimensions`(图片尺寸解析) |
| `extensions/copilot/src/platform/networking/node/stream.ts` | SSE 处理器 |
| `extensions/copilot/src/platform/networking/node/chatStream.ts` | 流返回整理 |
| `extensions/copilot/src/platform/networking/common/networking.ts` | IEndpointBody、createCapiRequestBody |
| `extensions/copilot/src/platform/networking/common/openai.ts` | CAPIChatMessage、rawMessageToCAPI、工具调用类型、`ChatRole` 枚举 |
| `extensions/copilot/package.json` | customendpoint 的 configuration schema(已移植) |
| `src/vscode-dts/vscode.d.ts` | `LanguageModelChatProvider`、`LanguageModelChatInformation`、`LanguageModelChatMessageRole` (stable API) |
| `src/vscode-dts/vscode.proposed.languageModelSystem.d.ts` | `LanguageModelChatMessageRole.System = 3` (proposed API) |
