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
│   │                   #   含 applyReasoningEffort(思考级别写入请求体,支持 -op 调试后缀)
│   │                   #   含 applyMetadata(metadata 按协议注入)
│   │                   #   含 usage report(三协议收集 usage 并 report,供 Context Usage Widget/compaction)
│   │                   #   含 System 消息处理、reasoning_content 输出
│   ├── client.ts       # 网关客户端:URL 解析 + 三种协议请求构造 + 通用 SSE 解析
│   │                   #   + FIM 补全请求构造(buildKaiCompletionRequest/streamKaiCompletions)
│   ├── cjs_encode.ts   # 轻量级 token 估算:字符分类统计(英文≈4字符/token、CJK≈1.5、标点≈3、空白≈4),误差±10%,替代 gpt-tokenizer BPE
│   ├── tokenizer.ts    # token 计数:轻量估算(基于 cjs_encode.ts)+ LRU 缓存 + 图片/文档/消息/工具计数
│   ├── config.ts       # 读取 kaicustomendpoint.models(vendor 过滤)+ inlineCompletion + readSecretsMap(secrets 批量预读)
│   ├── completions.ts  # KaiInlineCompletionProvider:内联补全(FIM prompt+suffix,独立于 Copilot)
│   ├── logger.ts       # KaiCE 调试日志(OUTPUT 面板「KaiCE」通道):effort 带 -op 后缀时打印请求/响应详情,后缀不写入请求体
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
| 注册表 id 与 API model 分离(分组防覆盖) | `provider.ts`(registry `id` 用 `model.name ?? model.id` 区分不同分组中的同 id 模型;真实模型 ID 存内部字段 `apiModelId`,请求体 `model` 字段与调试日志使用 `apiModelId`) | ✅ 已实现 |
| System 消息处理(chat-completions/responses) | `provider.ts` `toOpenAIMessages` / `toResponsesInput` | ✅ 已实现 |
| `reasoning_content` 流式输出 | `provider.ts` `processChatCompletionsStream` | ✅ 已实现 |
| `reasoningEffortFormat` / `defaultReasoningEffort` / `supportsReasoningEffort` | `provider.ts` `applyReasoningEffort` + `package.json` schema + `types.ts` | ✅ 已实现（`defaultReasoningEffort` 直接写入请求体，不依赖 proposed API；picker UI 因 `enabledApiProposals` 已移除不再渲染。条目支持带 `-op` 调试后缀，如 `high-op`，请求时去后缀并经 `logger.ts` 打印请求/响应详情） |
| KaiCE 调试日志（`-op` 后缀） | `logger.ts` + `extension.ts`（注册 `disposeLogger`）+ 请求链路 | ✅ 已实现（effort 以 `-op` 结尾时启用：OUTPUT 面板「KaiCE」通道打印请求头/体、响应头/体，同一请求共享 request UID，`-op` 不写入请求体；通道随扩展卸载自动销毁，避免残留/重复。响应体按协议合并 SSE 为协议最终完整对象，非 SSE 响应（如 JSON 错误体）回退为原始文本前 N 字符。双阈值：`MAX_RAW_CHARS`=1M 防病态流硬上限、`MAX_LOG_CHARS`=100K 单段日志展示上限；请求体截断保留末尾、响应体截断保留开头，提示文案分别标注 last/first。**并发安全**：每个日志块拼成单个字符串后用一次 `append` 写入，避免并发请求日志行穿插——`appendLine` 仅单行原子，多行组合会因 async `await` 切换事件循环被其它请求穿插） |
| metadata 注入（协议自适应） | `provider.ts` `applyMetadata` + `completions.ts` + `package.json` schema + `types.ts` | ✅ 已实现（Anthropic 协议合并进请求体 `metadata` 容器，如 `{"user_id":"xxx"}`；OpenAI 协议展开到请求体顶层，如 `{"user":"xxx"}`；FIM 展开到补全请求体顶层；已存在字段优先，不被覆盖） |
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

**思考级别 `-op` 调试后缀**(`logger.ts`):
- `supportsReasoningEffort` / `defaultReasoningEffort` 条目支持 `-op` 后缀(如 `high-op`),与去后缀条目(如 `high`)相互独立、可并存
- 选中带 `-op` 的条目时,请求发送前去除后缀(模型只收到真实级别),并在 OUTPUT 面板「KaiCE」通道打印请求头、请求体、响应头、响应体
- 同一请求的所有日志共用 request UID(短随机串),便于关联定位;通道随扩展卸载自动销毁(extension.ts 注册 `disposeLogger`)
- 响应体按协议合并 SSE 为协议最终完整对象(`readResponseBodyForLog`):**增量字段拼接、其余字段后值覆盖,不新增/不删除/不改字段名**——messages 合并为单个 message 对象(content 块按 `delta.type` 拼接:`text_delta→text`、`thinking_delta→thinking`、`signature_delta→signature`、`input_json_delta→partial_json`(tool_use 最终解析为 `input`),`message_delta` 填 `stop_reason`/`usage`);chat-completions 合并为单个 chunk 对象(`delta.content`/`reasoning_content`/`tool_calls[].function.arguments` 拼接);responses 合并为单个 response 对象(output 数组 `output_text`/`function_call_arguments` 拼接);completions 合并为单个 completion 对象(`choices[].text` 拼接)。非 SSE 响应(如 JSON 错误体)回退原文。敏感头打码、单段限长 `MAX_LOG_CHARS` 与 `MAX_RAW_CHARS`(原始字节硬上限)
- **日志链路全兜底**:合并/写入错误绝不影响正常业务——`logError` 的 console 与通道写入各自独立 try/catch,绝不抛出;单行 SSE 合并失败仅打印一次后继续;调用侧 `await responseLogPromise.catch(() => {})` 吞掉,`finally` 中不会用日志错误覆盖业务结果

**metadata 注入**(`provider.ts` `applyMetadata`):
- Anthropic 协议(messages):合并为请求体 `metadata` 字段,已存在的 metadata 优先,不被覆盖(如 `{"user_id":"xxx"}`)
- OpenAI 协议(chat-completions / responses):展开到请求体顶层,已存在字段优先(如 `{"user":"xxx"}`)
- FIM 补全(`completions.ts`):展开到补全请求体顶层(OpenAI 补全协议)

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
- **LLM 流式渲染性能修复**:①responses 协议 `output_text.delta` 原来攒着不 flush、整个 output item 生成期间 UI 无更新(chat-completions/messages 均逐 delta 实时输出),已改为立即 flush;②messages 协议 `thinking_delta` 原被忽略,模型生成长思考期间 UI 无反馈,已与 chat-completions 的 `reasoning_content` 一致实时输出;③responses 协议新增 `reasoning_summary_text.delta`/`response_text.delta` 实时输出;④内联补全 `extractContext` 窗口化(前缀 300 行/后缀 100 行),避免大文件全量 getText+逐行 token 估算造成键盘输入到请求发出的同步卡顿;⑤`streamSSE` 空行重置 `currentEvent`(SSE 规范,避免 event 字段粘滞);⑥token 计数函数(`countMessageObjectTokens`/`countMessageTokens`/`countMessagesTokens`/`countToolTokens`)由伪 async 改为同步,消除 provideTokenCount 频繁调用时的微任务调度开销;⑦`serializeToolResult` 共享 `TextDecoder` 实例。注:内联补全渐进式渲染为 VS Code stable API 不支持(`@types/vscode` 1.125 的 `provideInlineCompletionItems` 仅返回 `InlineCompletionItem[] | InlineCompletionList`,无 `AsyncIterable`),补全需等完整流生成,属设计限制
- **usage report（修复 Context Usage Widget / compaction 失效）**:三种协议流式解析收集 usage 并在流结束后 report `LanguageModelDataPart`（MIME `usage`，与 Copilot 的 `CustomDataPartMimeTypes.Usage` 一致，内容为 `APIUsage` JSON `{prompt_tokens,completion_tokens,total_tokens,prompt_tokens_details.cached_tokens,completion_tokens_details.reasoning_tokens}`）——chat-completions 从最后一个 chunk 的 `usage` 收集（请求体加 `stream_options.include_usage=true`，`prompt_tokens` 已是总值）；responses 从 `response.completed` 事件的 `response.usage` 收集（`input_tokens` 已是总值）；messages 参考 Copilot `messagesApi.ts` 的 `AnthropicStreamingHandler`+`buildAnthropicCompletion`：`message_start` 初始化各 token 字段，`message_delta` 逐字段更新（`??` 保留已有值），流结束后合并 `prompt_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`（Anthropic 的 `input_tokens` 只是非缓存部分）。端点不返回 usage 时延迟估算（`countMessagesTokens`+`countToolTokens`）。VS Code Context Usage Widget 与 compaction 据此显示上下文窗口使用量并触发压缩
- **resolveTokenLimits 修复**:maxInputTokens/contextWindow 均未配置时给输入窗口默认 128000，避免仅有 maxOutputTokens 时 maxInputTokens=0 导致 VS Code 判定 context window 无效（totalContextWindow<=0）
- **性能优化（全部）**:`resolveSecret` 批量预读 secrets（`readSecretsMap`，避免每个 group 重复读配置）；`sanitizeSchema` 用 WeakMap 缓存（同一 schema 对象复用清理结果，避免递归重建）
- 调试日志:`-op` 后缀识别(`high-op`→true、`high-OP`→false)、request UID 生成、OUTPUT 通道随扩展卸载自动销毁(commit `79ae16a`)
- metadata 注入:Anthropic 合并进 `metadata` 容器、OpenAI/FIM 展开请求体顶层,已存在字段优先不被覆盖(commit `79ae16a`)
- 打包:版本 v0.0.3,`make clean && make package` 通过,vsix 正常生成(78.39 KB)

## 八、待办清单(按优先级)

- [x] **P0 token 计数重写**:新建 `src/tokenizer.ts` + `src/cjs_encode.ts`,保留 customendpoint 结构(LRU 缓存 + countMessageTokens + countToolTokens + 图片/文档成本),文本计数改用轻量级字符估算(`estimateTokens`)替代 gpt-tokenizer BPE
- [x] P1 更新 README 的「已知限制」(Token 计数为轻量级字符估算,误差 ±10%;并移除 gpt-tokenizer 相关说明)
- [x] P2 配置 schema 补全 customendpoint 剩余字段（`editTools`、`zeroDataRetentionEnabled`、`supportsReasoningEffort`、`reasoningEffortFormat`、`defaultReasoningEffort`）——全部已实现：`editTools` 传递到 capabilities（`enabledApiProposals` 已移除，运行时为 `undefined` 被 VS Code 忽略）、`zeroDataRetentionEnabled` 控制 Responses API `store`（不依赖 proposed API）、`applyReasoningEffort` 使用 `defaultReasoningEffort` 写入请求体（picker 因 proposed API 移除不再渲染）
- [x] P3 内联提示词(inline completion)——已实现：`completions.ts` `KaiInlineCompletionProvider`，FIM prompt+suffix 请求，独立于 Copilot 登录/订阅。`kaicustomendpoint.inlineCompletion` 配置（`pattern` + 可选 `language`/`prompt` + `model`），`url` 为全地址不做路径拼接。stable API 一次性返回（渐进式渲染为 Copilot 私有通道，不支持）
- [x] **P4 KaiCE 调试日志 + metadata 注入**（commit `79ae16a`）——新增 `logger.ts`：`supportsReasoningEffort`/`defaultReasoningEffort` 条目支持 `-op` 调试后缀（如 `high-op`），请求时去后缀并经 OUTPUT 面板「KaiCE」通道打印请求/响应详情（同请求共享 UID，通道随扩展卸载销毁）；模型配置新增 `metadata` 字段按协议自适应注入（Anthropic 进 `metadata` 容器、OpenAI/FIM 展开请求体顶层，已存在字段优先）；同批统一品牌为 KaiCE、版本升至 v0.0.2、README 补充 glm-5.3 与 `defaultReasoningEffort` 示例
- [x] **P5 usage report + 性能调优**（v0.0.3）——①修复 VS Code Context Usage Widget / compaction 失效：三协议流式解析收集 usage 并 report `LanguageModelDataPart`（MIME `usage`，与 Copilot 的 `CustomDataPartMimeTypes.Usage` 一致）；②修复 `resolveTokenLimits` 仅配 maxOutputTokens 时 maxInputTokens=0 导致 context window 无效；③LLM 流式渲染修复（responses flush / messages thinking / responses reasoning）；④性能优化：token 计数同步化、streamSSE event 重置、resolveSecret 批量预读、sanitizeSchema WeakMap 缓存、serializeToolResult 共享 TextDecoder、extractContext 窗口化
- [ ] P6 实际端点联调测试(本地 Ollama / vLLM 网关)

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
