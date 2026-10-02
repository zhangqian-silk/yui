# 独立 Agent 最小骨架

这是自有 TypeScript 类型和循环组成的独立 Agent，不调用真实模型、不依赖
Yui 控制面。当前和后续模块开发均不需要考虑接入 Yui；模块的持续约束见
[AGENTS.md](./AGENTS.md)。它不是完整生产 Agent，也不提供强沙箱或崩溃恢复。

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
打印消息、事件、结束原因及 `fileVerified: true`。不启动 Controller、
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
- `onEvent` 是可选的有序事实出口，不是策略 hook。循环先记录内存事件，
  再等待出口；出口失败停止新增效果，仍在内存补齐已记录调用的未执行结果。
  终态出口自身失败时，本地唯一终态修正为 `error/event_sink_failed`；
  不能声称外部出口已经持久化这个终态，不重试坏出口。

`contracts.ts` 是实际使用的公共合同，`test/core/native-agent.test.js`
提供 final、调用/结果、取消和错误的可运行样例。新增 provider、工具及事件
消费者无需改写循环或操作其他模块私有状态。持久化/上下文实现可从历史与
事件入口独立推进，但恢复与未知效果的重放需要另行设计，当前不会自动续跑。

## 终止与边界

`maxSteps` 为正整数，一次 provider 请求及其工具批次计一个 Step。最后一个
允许 Step 返回 final 仍为 `completed`；若返回工具调用，先结算该批次，
然后 `budget_exhausted`，不伪造 final。每轮一个内存 `turn_ended`，
每个已开始 Step 都有 `step_ended`，事件序号在本轮内从 1 递增。

输入历史拒绝悬空、重复或不匹配的调用/结果。provider 响应先验证完整批次，
畸形响应零工具执行。未知工具与已知参数/I/O 错误可以回填给模型纠正；
provider 异常、工具意外异常或未知效果结束为 `error`，无自动重试。
错误详情由 provider/工具实现负责脱敏；文件工具不会输出根外路径或堆栈。

取消传递 `AbortSignal`，停止下一次调用并等待已开始工具结算；已完成写入
不会因取消被撤销或改称“未执行”。没有硬超时竞速；不合作的 provider/tool
可能一直不返回，Step 预算不是墙钟超时。未知效果优先报告 error。

当前固定上限：每 Step 8 个调用；每调用 JSON 参数 64 KiB；每消息/响应
512 KiB（容纳 64 KiB 文本的 JSON 转义）；发起模型请求前历史 1 MiB。
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
