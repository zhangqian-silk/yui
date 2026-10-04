# 本地观测与诊断

`observability/index.ts` 是可替换消费者的公开入口。它消费父模块公开的
`AgentEvent`、`TurnResult`、`Scope` 和 `StepScope`，不定义第二套会话事实、
模型协议或恢复状态。没有 Yui、数据库、网络或真实模型依赖。

## 接入

从仓库根目录构建后，可以在 ESM 中运行：

```js
import { createAgent, createMockProvider } from './dist/nativeAgent/index.js';
import { createLocalObserver } from './dist/nativeAgent/observability/index.js';

const observations = createLocalObserver({ capacity: 512 });
try {
  const agent = createAgent({
    tools: [],
    provider: createMockProvider({ toolCallProbability: 0, random: () => 0 }),
    observer: observations,
  });
  const result = await agent.runTurn({
    sessionId: 's1', turnId: 't1', input: 'hello', maxSteps: 1,
  });
  observations.observeSnapshot(result);
  console.log(observations.query({ sessionId: 's1', turnId: 't1' }));
  console.log(observations.health());
} finally {
  observations.close();
}
```

这是可选观测适配器，不是必要持久化出口。内核分别注入必要的 `recorder`
和同步 `observer.observe`，不要把必要存储塞进 best-effort consumer。
观测失败不等于存储成功。

## 生产者与消费者

- 内核提供 `observeEvent(event, source?)`，保留源序号及会话、轮次、步骤和
  工具调用身份。不会变更源事件或回写执行状态。
- 模型网关显式提供 `observeModel({ sessionId, turnId, step, requestId,
  attempt, phase, status?, effect?, usage?, errorCode?, retryAfterMs?,
  clientRequestId?, providerRequestId?, httpStatus?, elapsedMs? }, source?)`。
  `phase` 为 `started | ended | retry`，`status` 为
  `completed | error | cancelled | unknown`。记录重试提示不执行重试。
  `requestId + attempt` 必须来自生产者；本模块不生成模型调用身份。
- 会话模块或调用方提供 `observeSnapshot(result, source?)`。它产生最终结果的
  **诊断摘要**（真实 reason、错误码、消息数、未知工具效果数），不保存完整历史。
  事件曾报告的终态与最终结果不一致时，两者分别保留，不宣称流式观察优于结果。
- UI 可通过 `observeStream({ sessionId, turnId, step, requestId?, text }, source?)`
  记录文本增量的字符数，始终标记 `provisional`；字符数不是 token 用量。
  本模块不保存/显示正文，不实现 UI，UI 正文应直接消费自己的流。
- UI/诊断工具使用 `query`，或实现 `ObservationConsumer.export(record, signal)`。
  `subscribe` 返回幂等取消订阅函数；`close` 禁止新记录并释放全部订阅。
  `LocalObserver` 接口允许替换本地实现，依赖由调用方显式传入。

这些是最小消费样例，不是对尚未组合的模型、会话或 UI 模块实现的宣称。
公共内核类型和统一组合入口仍由其拥有方维护；本模块不修改根 `index.ts`。

## 真实性和脱敏

每条记录携带本地 cursor、来源、观测到达时间和完整性类别。`source` 默认为
`live`；重读或缓存数据的调用方必须明确传入 `replay` 或 `cached`，本模块
无法从消息内容推断来源。快照只表明收到完整 `TurnResult`，不表示已持久化、
业务验收、工具回滚、恢复安全或实时可用。

耗时只对仍在保留窗口内、同身份、同 attempt 的 live 起止记录配对，使用可注入
的单调毫秒时钟。Turn、Step、模型请求和工具均可配对。它是**观察到达间隔**，
不是服务端计费时间。起点已淘汰、重复终点、重放、缓存或时钟倒退时不提供耗时；
缺失不替换成零。调用方应保持同一身份的事件有序。

用量只白名单复制生产方实际提供的 `inputTokens`、`outputTokens` 和
`cachedInputTokens`、`totalTokens`，保留缺失值，不估算、不求和、不把重复观察算作新账单。
实际网关通过 `connectModelObservations` 接入；累计 `elapsedMs` 与观察间隔
`durationMs` 分开，没有 started 证据时不虚构 duration。
取消保留实际 `cancelled` 终态；已执行工具不会改称未执行；`effect: unknown`
始终保留，不用于自动重放。

默认丢弃所有用户/模型正文、工具参数、工具输出、错误消息与堆栈，且忽略输入
对象上的额外属性。只保留结构化元数据。会话/轮次/调用 ID、工具名、错误码
必须是调用方提供的**非敏感不透明标签**；这些关联字段保留原值，不用正则
猜测其含义或掩盖后制造身份碰撞。每个标签最多 256 UTF-8 字节，超限拒绝
整条观测并计数；这不是对把密钥放进 ID 的防泄漏保证。

## 有界与失败

默认保留 512 条，容量可设为 1–10000 条。投影后的固定字段与标签上限限制单条
体积；不缓存原始事件、消息或文本。`query` 每页默认 100、最多 1000 条，支持
session/turn/request/toolCall 过滤及 `after` cursor。`nextCursor` 用于下一页，
`throughCursor` 表示查询当时记录水位；`evicted` 是全局淘汰累计，
`gap` 表示 cursor 落后于保留窗口，过滤后也保守报告此事实。
查询是当前有界内存窗口，不是固定历史快照。记录及嵌套 usage 不可变。

每个 consumer 至多一个异步调用在途，没有待发队列或后台重试。
忙时丢弃通知；本地窗口仍接收记录，`consumerDropped` 如实累计。
最多 32 个订阅、总计最多 32 个在途导出（包括已取消但未结算的导出）。
同步抛错或 Promise 拒绝计入 `consumerFailures`，异常文本不进入日志。
非法观测或时钟异常计入 `rejected`，`observe` 不将其传播给 Agent。

取消订阅/关闭会发送 AbortSignal，但不谎称导出已结算；`inFlight` 在 Promise
真正结算前仍非零。插件必须合作释放自己创建的文件/连接；本模块不创建这些
资源或计时器，也不能强杀不合作插件。进程内 consumer 不得同步阻塞线程。
这不是必要审计机制或无损日志服务。需要完整的本地导出时，应在执行后分页
读取尚未淘汰的记录并显式等待写入，而不是依赖实时 best-effort 通知。

## JSONL 导出

`createJsonlExporter(write)` 为每条已投影记录输出一行 JSON。目的地与关闭责任
由调用方持有；可用于本地文件、stdout 或 fake writer。下面的操作发生在
Agent 执行之后，写入失败直接交给调用方，不被当作成功：

```js
import { open } from 'node:fs/promises';
import { createJsonlExporter } from './dist/nativeAgent/observability/index.js';

const file = await open('/explicit/owned/directory/observations.jsonl', 'wx', 0o600);
try {
  const exporter = createJsonlExporter(line => file.writeFile(line));
  const signal = new AbortController().signal;
  let after = 0;
  for (;;) {
    const page = observations.query({ after, limit: 1000 });
    // 保存这份诊断的窗口损失证据，而不把 JSONL 冒充完整会话历史。
    if (page.gap) console.error({ evicted: page.evicted });
    for (const record of page.records) await exporter.export(record, signal);
    after = page.nextCursor;
    if (after >= page.throughCursor) break;
  }
} finally {
  await file.close();
}
```

无持久化 schema 或迁移：JSONL 是显式导出的诊断，不是可加载的恢复数据库。
订阅导出器时，其写入错误会被 observer 隔离；直接调用则由调用方处理。

## 验证边界

`node --test test/core/native-agent-observability.test.js` 使用真实骨架 Agent、
固定事件/快照、fake consumer 和注入时钟，不创建 Controller、网络连接或
后台进程。覆盖脱敏、终态/未知效果、缺失用量、流式/缓存区别、耗时关联、
保留窗口与分页、失败隔离和取消后实际结算。整个仓库交付检查为 `npm test`。
真实模型、账号、付费 API 和跨模块真实组合未包含在这份独立证据中。
