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
  account: { kind: 'bearer', token: credential },
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

## 首个协议与范围

提供 Chat Completions 兼容文本/function 协议，依据 OpenAI 官方
`POST /v1/chat/completions` OpenAPI 的消息、工具、usage 与 SSE 合同。
选择它是为了直接映射既有无状态消息与工具循环，不声称支持所有兼容厂商。
不实现 Responses、图像/音频、旧式 function_call、结构化输出或厂商扩展。
不添加 SDK、厂商消息类型或第三方 Agent 内核。

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

`onObservation` 提供 Session/Turn/Step/attempt 身份与 text_delta、
tool_delta、usage、retry。这些都是尽力显示，不是完整消息、可执行调用、
持久事实或可靠终态。回调异常/Promise 拒绝被隔离，Promise 不等待；
慢消费者自行持有有界队列及生命周期。调用次数有界于响应字节上限，
模块不缓存事件、不声称已送达 UI。内容本身可能敏感，显示方自行决定存储。

可靠结果从 `generate` 的返回/抛错取得。用量只保留服务端报告的 input、
output、total tokens；未提供时字段缺席，不填零、不据此推算金额。
usage 增量可以早于失败出现，不能代表请求成功。
`ModelGatewayError` 含稳定 code、effect、尝试记录及可选 stopReason。
不保留原始异常 cause、服务器 message/body、URL、header 或 token。
精确目标由持有配置的调用方关联，避免把含秘密的 URL 写入诊断。

## 重试与取消

默认至多 3 次，含请求与等待的总预算 30 秒，初始退避 250 ms，指数增长。
`Retry-After` 的秒数或 HTTP 日期是最低等待；超出预算即停止，不缩短提示。
仅 HTTP 429 + `rate_limit_exceeded`，且 type 为已知临时类型或缺省，
可自动重试；quota/auth 优先分类，未知 429 和 5xx 不推断为安全。
换成认证/配额/协议/传输错误即停止；错误保留各次分类与状态。
配置最多 10 次、5 分钟总预算，不支持无限重试。

成功 HTTP 的错误/半截流、断网、超时和未知远端效果一律不自动重放。
取消会中止 fetch、body 读取及等待并结算清理，绝不声称撤销远端计费。
deadline 是协作式中止；不合作的注入 transport/adapter/clock 可能不返回，
模块不以超时竞速伪造其已经停止。内置 fetch 与 timer 均合作取消。
没有持久化恢复或“续接半截流”：调用方保存原始错误和已知结果，
在获得所需决策后发起新的显式调用。

## 固定样例与独立验收

`test/core/native-agent-model.test.js` 是供 72/78/79 使用的可执行样例：
通过公开入口组装 provider/Agent；loopback HTTP 核对请求与工具结果映射；
fixture 流 `你好 → read({"path":"a"}) → usage → DONE`；
单字节 fake stream 核对 UTF-8；fake transport/clock 检验取消、错误、
次数/时间边界和无重放。全部 fixture 使用假模型和假凭据。

```sh
npm run build
node --test test/core/native-agent-model.test.js
```

测试不使用真实模型、生产账号或第三方额度，不证明真实厂商兼容性。
模块独立验收与未来各模块的统一组装验收分开。
