# 模型网关

独立模块；公开入口为 `model/index.ts`，只消费上层 `index.ts` 的自有类型。
`createModelGateway` 直接实现现有 `ModelProvider.complete(request, signal)`，
可以交给 `createAgent({ provider, tools })`，无需改动内核或引入 Yui。
`generate` 额外返回本次请求的用量与尝试记录，不保存共享会话状态。

## 显式组装与可替换点

```ts
import { createAgent } from '../index.js';
import { createModelGateway } from './index.js';

// 这些值由调用方自己的配置/授权来源提供；模块不读取环境变量、文件或账号。
const provider = createModelGateway({
  endpoint: configuration.completionsUrl, // 完整 URL，不自动追加路径
  model: configuration.model,
  protocol: 'responses', // 缺省保留既有 chat-completions
  account: { kind: 'bearer', token: credential },
  generation: { maxOutputTokens: 2048 },
  stream: true,
  onObservation: event => display.enqueue(event),
});
const agent = createAgent({ provider, tools });
```

本地无认证服务必须显式选 `account: { kind: 'none' }`。仅接受 HTTPS 或
loopback HTTP；拒绝 URL 用户信息、查询串和 fragment，fetch 禁止重定向。
endpoint/model/token 在创建时固定；不切换模型、账号或 endpoint。
不提供网络服务、账号发现、凭据刷新、代理平台或动态插件安装。

- `ModelProtocolAdapter` 负责编码、解码、已知 HTTP 拒绝分类。
- `ModelTransport` 默认是 fetch，可显式替换；必须遵守 AbortSignal、
  不跟随重定向、不私自重试，在操作结算后返回。连接池由其创建方关闭。
- Gateway 持有并关闭每次响应 reader、deadline timer 和取消监听。
  自定义适配器提前返回或抛错也关闭已开始读取的 body。
- 内核仍只接收自有 `ModelResponse`。Gateway 在替换适配器之后仍检查
  响应大小、合法 JSON、调用数、唯一 ID、历史 ID 和已声明工具名。

## 协议、模型能力与范围

保留 Chat Completions，增加 OpenAI Responses 和 Anthropic Messages 的
文本/function tools、JSON 和 HTTP SSE 子集。三个 codec 共用一个 Gateway，
不添加 SDK、厂商消息类型、第二套模型循环或第三方 Agent 内核。
协议必须显式选择，不从 endpoint/model/token 猜测；不声称全模型/厂商兼容。

| `protocol` | 凭据 | `generation.maxOutputTokens` | 流式成功边界 |
| --- | --- | --- | --- |
| `chat-completions`（缺省） | bearer / none | 可选，`max_completion_tokens` | finish reason + `[DONE]` |
| `responses` | bearer / none | 可选，`max_output_tokens` | 完整 items + `response.completed` |
| `anthropic-messages` | api-key / none | 必填，`max_tokens` | 完整 blocks + stop reason + `message_stop` |

Messages api-key 只写到 `x-api-key`，版本固定 `anthropic-version: 2023-06-01`；
不复用 bearer，不开放任意 header/环境凭证链。`none` 必须由调用方显式选择。

`getProtocolCapabilities(protocol)` 返回适配器的 text/functionTools/streaming
子集；`gateway.profile` 是冻结的 protocol/model/capabilities/capacity。
`modelCapabilities` 只能收窄实际所选模型能力；不代表账号可用性探测。
`capacity.contextWindowTokens` 和 `capacity.maxOutputTokens` 是调用方声明的正安全
整数，不查模型目录，缺失表示 unknown。输出设置不得超过声明的输出容量；
上下文容量只是传给预算消费者的元数据，此层不估算 tokens、不压缩、不宣称
已经证明请求适合窗口。配置/预算权威仍属于调用方。

只支持 `generation.maxOutputTokens`，未知配置/请求/消息字段在发送前给出
`configuration` / `request` 错误。reasoning/thinking、cache 控制、
temperature/top_p、结构化输出、图像/音频/文件、旧式 function_call、
内置/server tools、工具 namespace/异步/程序调用上下文、assistant phase、
WebSocket、background/服务端 conversation、previous_response_id 均不支持。
不筛掉这些语义内容再冒充成功；Responses phase 无法由自有历史保真，因此
即使厂商支持也显式拒绝。未知输出 item/block 字段同样拒绝，已知非执行性
metadata（如 item ID/status/created_by、空 annotations/citations、logprobs）可解析。

Responses 以 caller-owned input 重送历史，assistant 文本使用合法输入消息，
不伪造输出 item ID；工具以原 `call_id` 和 `function_call_output` 配对。
固定 `store:false`、`truncation:'disabled'` 和 function `strict:false`，不修改
调用方的 JSONSchema 为严格模式。区分 `item.id` 与可执行的 `call_id`，
校验 output/content index、顺序号（若提供）、delta/done/final 一致性。
`function_call.status` 可省略；若提供，added 阶段必须为 `in_progress`，
done/最终输出必须为 `completed`。message 的状态仍必填。省略工具 item
状态不替代参数 done、item done 或 `response.completed`，也不放宽关联校验。

Messages 分离开头 system；中途 system、assistant prefill、空块等无法无损
映射的历史明确拒绝。assistant tool_use 的结果以 user tool_result 配对，
相邻结果按原顺序合并，错误 `is_error:true`，保留完整 ToolOutcome JSON。
具名 SSE event 与 JSON type 必须一致，usage 更新按累计值覆盖、不相加。
两种协议只接受完整文本和直接 function calls；截断、refusal、错误、
未知内容、关联冲突或缺失 native terminal 都不能交给内核执行。

请求固定一个 choice、`store:false`，流式请求 `include_usage:true`。
工具结果保留完整 `ToolOutcome` JSON（含错误效果分类），通过原 call ID 配对。
该协议子集的工具参数必须为 JSON object；类型/业务参数校验仍由工具负责。
拒绝悬空历史、重复工具定义/调用、未声明工具及复用历史 call ID。

非流式必须为一个完整 assistant choice。流式支持 UTF-8 分字节、
CR/LF/CRLF、SSE 多行 data 与按 index 拼接的多个 toolcall。
只有 `finish_reason: stop | tool_calls` 与完整 `[DONE]` 标记同时出现才返回。
length/content_filter、错误 frame、畸形参数、缺失 finish/DONE 均失败；
不会将已显示的文字或半截参数包装成成功结果。

限额：请求 1 MiB，编码请求 2 MiB，读取响应总量 4 MiB，HTTP 错误体
64 KiB，最终响应 512 KiB，每批 8 个调用，每调用参数 64 KiB，
JSON 最大深度 32。超限拒绝，不截断。

## 显示、用量和诊断消费者

`onObservation` 提供 Session/Turn/Step/requestId/attempt 身份与 text_delta、
tool_delta、usage、retry、attempt_finished。这些都是尽力显示，不是完整消息、可执行调用、
持久事实或可靠终态。回调异常/Promise 拒绝被隔离，Promise 不等待；
慢消费者自行持有有界队列及生命周期。调用次数有界于响应字节上限，
模块不缓存事件、不声称已送达 UI。内容本身可能敏感，显示方自行决定存储。

可靠结果从 `generate` 的返回/抛错取得。用量只保留服务端报告的 input、
output、total 和缓存计数；字段均可缺席，不填零、不合成 total、不推算金额。
Responses 的 cached/cache_write 映射为 `cachedInputTokens` / `cacheWriteInputTokens`；
Messages 的 cache_read/cache_creation 对应同名字段，原 input 不加上缓存计数
伪造统一用量。Chat 保留原有 prompt/completion/total 三个报告字段。
usage 增量可以早于失败出现，不能代表请求成功。
`ModelGatewayError` 含稳定 code、effect、尝试记录及可选 stopReason。
不保留原始异常 cause、服务器 message/body、URL、任意 header 或 token。
精确目标由持有配置的调用方关联，避免把含秘密的 URL 写入诊断。

### 给 72/78/79 的最小接线

```ts
import { createModelGateway, createModelObservationAdapter } from './index.js';

const onObservation = createModelObservationAdapter({
  display: event => ui.enqueue(event),            // 正文/工具参数片段，仅显示
  diagnostics: event => diagnostics.enqueue(event), // 仅 retry/attempt_finished
});
const provider = createModelGateway({ ...explicitConfiguration, onObservation });
// 72: createAgent({ provider, ... }); complete 的返回合同不变。
```

这里的 `ui` / `diagnostics` 是调用方显式提供的回调，**不是**声称已存在的
79 API。适配器不导入 observability、不复制 AgentEvent、不伪造内核 seq；
实际 79 方法的映射由统一组合入口按其公开合同完成。
测试中的同名适配器用例可直接运行并证明消费者失败不传播。

- `requestId` 是 Gateway 每次 generate 创建的真实本地 UUID，同一次调用的
  多次尝试共用；不是服务端 ID，也不是 Session/Turn 的替代权威。
- 每次尝试携带唯一 `clientRequestId`，实际以 `X-Client-Request-Id` 发送。
  `providerRequestId` 仅取实际响应 `x-request-id`（Messages 为 `request-id`），并限制为 1–128 个
  ASCII 字母/数字/下划线/连字符，包含当前凭据或超限时省略，不替造。
  这些身份不构成幂等键或重放许可。
- 结果、错误和增量来源均明确为 `live`。保存后的回放或缓存应由读取方
  显式标 `replay` / `cached`，不能把旧来源字段当作现在仍是现场执行。
- 诊断仅转发 retry 和 attempt_finished，包含真实 status、效果、耗时和
  该次报告的 usage；不把 provisional usage 帧重复累计。
  流已报告 usage 后再异常结束，失败尝试仍保留这些已知用量。
  `elapsedMs` 是逻辑调用开始后的累计耗时（含之前尝试和退避），不是
  该次模型执行时长或服务端耗时；不要按多次尝试相加。
- `attempt_finished` 是一次请求尝试的结算观察，不是 Agent Turn 终态。
  取消发生在两次尝试之间时，以 `generate` 抛错为最终结果，不能把
  最后一个已拒绝尝试当作整个调用结论。未发送请求时 attempts 为空。
- 两个出口都是可选、非等待、异常隔离；真实送达/丢弃/排队状态属于
  接收方。必要存储不能接到这个出口，回调本身不得做阻塞工作。

## 重试与取消

默认至多 3 次，含请求与等待的总预算 30 秒，初始退避 250 ms，指数增长。
`Retry-After` 的秒数或 HTTP 日期是最低等待；超出预算即停止，不缩短提示。
Chat/Responses 仅 HTTP 429 + `rate_limit_exceeded`，且 type 为已知临时类型或缺省，
可自动重试；Messages 仅 HTTP 429 + `rate_limit_error`。quota/auth 优先分类，
未知 429 和 5xx 不推断为安全。新协议的流内已知认证/限流/配额错误也有稳定分类，
但 HTTP200/未知效果永远不能因此自动重放；未知流错误为 incomplete。
换成认证/配额/协议/传输错误即停止；错误保留各次分类与状态。
配置最多 10 次、5 分钟总预算，不支持无限重试。

成功 HTTP 的错误/半截流、断网、超时和未知远端效果一律不自动重放。
取消会中止 fetch、body 读取及等待并结算清理，绝不声称撤销远端计费。
deadline 是协作式中止；不合作的注入 transport/adapter/clock 可能不返回，
模块不以超时竞速伪造其已经停止。内置 fetch 与 timer 均合作取消。
没有持久化恢复或“续接半截流”：调用方保存原始错误和已知结果，
在获得所需决策后发起新的显式调用。

## 固定样例与独立验收

`test/core/native-agent-model.test.js` 与 `test/core/native-agent-protocols.test.js`
是可执行消费者样例：
通过公开入口组装 provider/Agent；loopback HTTP 核对请求与工具结果映射；
fixture 流 `你好 → read({"path":"a"}) → usage → DONE`；
单字节 fake stream 核对 UTF-8；fake transport/clock 检验取消、错误、
次数/时间边界和无重放。全部 fixture 使用假模型和假凭据。

```sh
npm run build
node --import ./test/helpers/physical-tmpdir.mjs --test test/core/native-agent-model.test.js test/core/native-agent-protocols.test.js
```

测试不使用真实模型、生产账号或第三方额度，不证明真实厂商兼容性。
模块独立验收与未来各模块的统一组装验收分开。
官方字段补核、固定来源及实际证据边界见
[`PROTOCOL_RESEARCH.md`](./PROTOCOL_RESEARCH.md)；Anthropic 托管规范仍受区域访问
限制，本次以固定官方 SDK schema 校准子集，不宣称验证所有当前模型或 beta。
