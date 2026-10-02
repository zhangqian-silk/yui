# 独立 Agent 执行内核与组合合同

这是自有 TypeScript 类型和循环组成的独立 Agent，不调用真实模型、不依赖
Yui 控制面。当前和后续模块开发均不需要考虑接入 Yui；模块的持续约束见
[AGENTS.md](./AGENTS.md)。内置实现与外部实现走相同接口，依赖全部显式传入。
它不是完整生产 Agent，也不提供强沙箱、动态插件装载或自动崩溃恢复。

## 运行

在仓库根目录：

```sh
npm run build
node dist/nativeAgent/demo.js
node --test test/core/native-agent.test.js
```

demo 创建并最终删除自己的临时目录，用固定随机序列 `[0.1, 0.2, 0.9]`
实现 `mock(read) → read 结果 → mock(write) → write 结果 → mock(final)`。
write 的内容取自模型请求中的真实 read 结果；demo 独立读取输出文件核对，
demo 显式组合模型、工具执行器、上下文构建器、内存记录 fixture 和观察消费者，
核对记录、观察与返回事实一致，打印消息、事件、结束原因及 `fileVerified: true`。不启动 Controller、
Agent Host、账号或网络服务。仓库完整交付检查仍为 `npm test`。

## 公开入口与责任

只从 `index.ts` 导入公开类型和构造函数：

```ts
import { createAgent, createMockProvider, createTextTools } from './index.js';

const agent = createAgent({
  provider: createMockProvider({ toolCallProbability: 0.5 }),
  tools: createTextTools({ root: '/absolute/controlled/workspace' }),
});
const result = await agent.runTurn({
  sessionId: 'session-1', turnId: 'turn-1',
  input: 'Copy input.txt to output.txt', maxSteps: 8,
});
```

- 调用方持有 Session/Turn 身份和完整历史，同一 Session 串行调用。
  `Agent` 不持有隐藏会话状态；下一轮显式传入旧历史与 `result.messages`。
- `Agent.runTurn` 拥有本轮历史副本、顺序工具执行、预算与终止判断。
  provider 请求、工具参数、事件和返回结果是深复制并冻结的快照。
- `ModelProvider.complete(request, signal)` 返回完整 final 或非空工具批次；
  厂商类型、传输和未来流式处理属于 provider，不进入内核。
- `Tool` 提供声明、无副作用的 `validate` 和 `execute`。结果明确成功，
  或携带 `effect: none | unknown` 的错误；结果按调用 ID 写回历史。
- `ToolExecutor` 提供冻结的 `definitions` 与
  `execute(call, StepScope, signal)`。`tools` 数组通过 `createToolExecutor`
  组装成同一合同，也可只提供 `toolExecutor` 替换实现；两者必须且只能选一。
  内核先核对声明、调用身份与预算，再顺序调用；执行器负责授权、参数验证及
  实际效果结算，不得自行重放未知效果。构造期固定工具声明，工具配置变更需重新组装。
- `ContextBuilder.build(ModelRequest, signal)` 在每次模型调用前执行，返回
  本次模型消费的消息投影。默认使用完整历史；投影会再次校验调用/结果配对及
  请求预算，不改写权威历史、工具声明和 Session/Turn/Step 身份。
  隐藏历史不能绕过原始调用 ID 去重或未知效果检查。
- `SessionRecorder.record(AgentEvent)` 是可选外部必要记录入口。内核按序
  等待确认；未配置时 `recording.status=memory`，不声称持久化。
  失败停止新增效果，仍在内存补齐调用结果并返回
  `error/recording_failed`、`lastRecordedSeq` 和 `failedSeq`。
  失败那条外部记录的实际效果未知，之后的事件仅保留本地，不重试坏出口。
  终态记录失败时，仅修正唯一的本地终态；观察者收到该修正后的终态。
- `AgentObserver.observe(AgentEvent)` 是同步非阻塞通知，不是必要记录确认或
  策略 hook。抛错只进入 `observerErrors`，并断开该消费者到本轮结束，不中止执行。
  消费者自行排队异步 UI/遥测传输、维护传输错误并负责 drain/close；
  返回 Promise 是合同错误：内核不等待它，并接住 rejection，避免未处理异常。
  `observe` 已返回不证明 UI/远端已经收到事件。同步 CPU 阻塞不受内核隔离。

`contracts.ts` 是实际使用的公共合同，`test/core/native-agent.test.js`
提供可替换组合、final、调用/结果、取消和失败的可运行样例。新增能力实现
无需改写循环或操作其他模块私有状态；资源由创建方关闭，内核不关闭注入实例。
原骨架混合的 `onEvent` 出口已拆为 `recorder` 与 `observer`，不保留旧兼容入口。
这里未引入持久化格式或修改 Yui 存储版本。

## 公共组合示例与模块所有权

```ts
import { createAgent, createToolExecutor, type AgentOptions } from './index.js';

// provider、tools、contextBuilder、recorder、observer 由调用方创建。
const options: AgentOptions = {
  provider,
  toolExecutor: createToolExecutor(tools),
  contextBuilder,
  recorder,
  observer,
};
const agent = createAgent(options);
```

task-72 维护 `contracts.ts`、`index.ts`、执行循环和组合样例；
task-73 消费 `ModelProvider`，task-74 提供 `ToolExecutor`，
task-75 提供 `Tool`，task-76 提供 `SessionRecorder` 与恢复后的 `TurnInput.history`，
task-77 提供 `ContextBuilder`，task-78 消费 `Agent/TurnInput/TurnResult`，
task-79 消费 `AgentObserver/AgentEvent`。这些是独立实现的最小边界，不是
内核对其他 Task 的运行时依赖。公共合同修改须明确生产者、消费者与可运行证据。

当前独立验收使用 mock、内存 fixture 和受控目录文本工具。尚未证明实际模型网关、
通用编码工具、持久会话或 UI 已组合。读取项目→修改文件→本地检查→回答→保存并
恢复会话的真实模块组合证据，须在那些模块可用后单独补齐，不能用 fixture 冒充。

## 终止与边界

`maxSteps` 为正整数，一次 provider 请求及其工具批次计一个 Step。最后一个
允许 Step 返回 final 仍为 `completed`；若返回工具调用，先结算该批次，
然后 `budget_exhausted`，不伪造 final。每轮一个内存 `turn_ended`，
每个已开始 Step 都有 `step_ended`，事件序号在本轮内从 1 递增。
`tool_started` 是执行前记录的意图，不是效果证明；记录后取消或记录失败仍可能
产生未启动结果。实际效果以配对的工具结果为准。记录完整性以 `recording` 为准，
不能仅通过是否存在 `turn_ended` 推断外部存储成功。

输入历史拒绝悬空、重复或不匹配的调用/结果。provider 响应先验证完整批次，
畸形响应零工具执行。未知工具与已知参数/I/O 错误可以回填给模型纠正；
provider 异常、工具意外异常或未知效果结束为 `error`，无自动重试。
历史包含未知效果时返回 `unresolved_effect`，不调用模型或执行器；调用方须先
根据外部证据显式结算，再提供完整历史。内核不加载 Session、不恢复半条记录、
不判断原 Turn 是否已经执行过。持久化/恢复实现必须验证完整性、身份和去重，
尤其不能把未确认记录之后的成功内存结果误作已持久化。
错误详情由能力实现负责脱敏；文件工具不会输出根外路径或堆栈。

取消传递 `AbortSignal`，停止下一次调用并等待已开始工具结算；已完成写入
不会因取消被撤销或改称“未执行”。没有硬超时竞速；不合作的 provider/tool
及必要记录器可能一直不返回，Step 预算不是墙钟超时。未知效果优先报告 error。

当前固定上限：每 Step 8 个调用；每调用 JSON 参数 64 KiB；每消息/响应
512 KiB（容纳 64 KiB 文本的 JSON 转义）；投影后的完整模型请求 1 MiB
（含身份和工具声明）。完整源历史可超出模型预算，以供上下文构建器投影，
仍要求每条消息有界、配对完整；存储层自行限制加载资源。
所有大小按 UTF-8/JSON 编码计算。超限显式报错，不截断；最后一个有界批次
的结果仍完整保留，即使下一次模型请求因此触及历史上限。

mock 每次请求只抽一次 `u`，`u < p` 调用工具，否则 final；`p` 为 `[0,1]`，
随机源必须返回 `[0,1)`。默认 `Math.random`，测试注入有限序列。
工具分支在奇数 Step read；偶数 Step 有成功 read 时 write，否则 read。
路径默认 `input.txt`/`output.txt`，可通过 `readPath`/`writePath` 设置。
final 只统计观察到的成功/失败结果，不声称用户目标已验收。
`p=1` 可持续调用，但受循环预算约束。

## 文本工具

`createTextTools({ root, maxBytes? })` 要求显式绝对目录，默认文件大小上限
64 KiB，可调小。read 参数 `{path}`，write 参数 `{path, content}`，
拒绝额外字段；成功 content 是 JSON 文本，分别包含 `{path,text,bytes}`
和 `{path,bytes}`。参数自身的 JSON 字节上限仍适用（转义文本可能更早触限）。

拒绝绝对路径、父目录穿越、符号链接、非普通文件和多硬链接文件；父目录
必须存在。read 有界读取并验证 UTF-8；write 在同目录创建独占临时文件，
完成后 rename 替换目标，取消前检查，保留已提交效果。临时文件创建权限
为 `0600`，替换会使用新文件权限；不保留旧 inode、权限或其他元数据。
清理失败报告自有临时文件相对路径和未知效果，不隐藏残留。

这里没有 fsync 掉电持久性、通用事务、敌对文件系统隔离或防并发路径替换
保证。根目录由调用方显式授予并规范化；只用于受控、无对抗修改的本地目录。
后续生产文件工具应单独实现授权/沙箱，而非将这些路径检查宣称为强隔离。
