# 会话事实与持久化恢复

公开入口为 `session/index.ts`。这是独立 Agent 的存储模块，不使用 Yui
Controller、Task、Home 或运行时；消息和执行身份使用上一级公开入口的
`AgentEvent`、`Message`、`ToolOutcome`，不重新定义模型/工具消息。

## 正常路径

```ts
import { createAgent } from '../index.js';
import { createSessionStore, createSqliteSessionBackend } from './index.js';

// 父目录由调用方创建并控制；文件路径必须是绝对路径。
const store = createSessionStore(createSqliteSessionBackend('/controlled/sessions.sqlite'));
try {
  await store.create('session-1'); // 仅新建；已有记录显式 load，不覆盖
  const saved = await store.load('session-1');
  const recorder = await store.recorder('session-1');
  const agent = createAgent({
    provider, tools, // 调用方提供的实现
    onEvent: async event => { await recorder.record(event); },
  });
  const result = await agent.runTurn({
    sessionId: 'session-1', turnId: 'turn-1',
    input: 'Hello', history: saved.messages, maxSteps: 4,
  });
  // result 是执行内存结果；只有 recorder.lastReceipt / store.load 是保存证据。
  // 保存失败时同时保留 result、recorder.failure 和最后确认回执以供诊断。
} finally {
  await store.close();
}
```

重启后省略 `create`，用 `load` 读取，再为新 Turn 创建 `recorder`。只有
`saved.recovery.disposition === 'ready'` 才可直接将 `saved.messages` 用作
完整历史；`recorder` 在其他状态下拒绝创建。Turn ID 和 call ID 在整个
Session 内唯一；Session 的执行由调用方串行管理，存储不是执行调度器。
系统消息可在首个 user 消息前用 `message_appended` 保存。

上面的 `onEvent` 是现有最小内核的必要记录接线，不是普通 UI 回调。后续内核
组合必须单独等待必要记录，普通 UI/遥测使用非权威观察出口；不能同时让一个
可选观察者的异常否定必要保存。此模块不修改公共内核或统一组装入口。

## 保存、查询与观察

- `create(sessionId)` 保存空会话；`append(event, expectedRevision)` 只追加一个
  事实，返回 `sessionId/revision/digest/source` 回执。revision 是会话范围的
  事实数，event.seq 则在每个 Turn 从 1 开始。没有隐式覆盖或自动重试。
- `load` 校验完整格式、身份、顺序和调用/结果配对后，返回只读文档、消息和
  派生恢复状态。只保存一个权威文档，派生投影不会独立写入。
- `query(sessionId, { after, limit })` 返回游标之后最多 100 条事实及当前修订号。
  游标是同 Session 的 revision；`nextCursor: null` 表示该次读取已到末尾，
  后续增量从该次回执的 revision 开始。不是跨多次请求冻结的快照。
- `subscribe` 返回幂等取消函数，只通知本 Store 成功提交的回执，不重播历史，
  不保证跨进程通知，不充当持久事件队列。每个订阅最多一个运行回调和一个
  合并后的待通知回执。回调拒绝/抛错会取消该订阅，不影响提交；挂起回调不会
  阻塞写入。调用方要恢复观察时重新 query/subscribe。最多 64 个订阅。
- `recorder` 持有最后确认回执；一次失败后停止接受新事实。`SessionSaveError`
  包含目标 Session、预期修订号、尝试写入的事件、原始 cause，且 effect 保守
  标为 unknown。错误不证明事务没有提交：先读取精确状态，禁止盲目重试。
  内核必须停止新增效果，并保留未保存的结果；模块不会自动补写内存结算。

记录协议要求：保存 `turn_started`、输入和 `step_started`，保存 assistant
完整批次；工具执行之前等待 `tool_started` 提交，之后保存真实结果，最后
结算 Step 和 Turn。没有启动标记不得记录成功或未知效果结果；未开始的调用
可以记录 `effect: none` 的失败。每个调用只配一个结果，顺序遵守当前内核的
串行工具合同。未知效果之后不能开始新工具或 Step，终态必须为 error。

## 中断与取消

恢复读取不运行模型/工具、不产生调用结果，也不自动续跑：

| 保存证据 | 恢复判断 |
| --- | --- |
| call 存在，启动标记和结果都没有 | `not-started`，依赖调用方遵守写前屏障 |
| 启动标记存在，结果缺失 | `unknown`；标记不证明真正执行过，也不证明未执行 |
| 已配对普通结果 | `settled`，完整保留原始结果 |
| 已配对 `effect: unknown` 结果 | 仍为 `unknown`，不能因为有终态而自动恢复执行 |

`recovery.calls` 给出 call/start/result 的 revision，`recovery.turns` 给出
最后 seq、Step、未闭合 Step 和保存的终态。`source` 标识本次读取的后端和
持久性；回执的 digest 对应完整已确认文档，不是对工具实际效果的证明。
取消不会撤销已完成工具，成功结果不会被取消标记改成未执行。

`interrupted` 表示还有未结束 Turn；`unknown-effects` 优先于 interrupted。
只读诊断始终可用。调用方可以在确认原执行者已经停止后，用明确的 `append`
操作保存确切缺失结果并结束原 Step/Turn，不能伪造未知调用的成功。需要记录
无法确认的效果时可写 `effect: unknown`，之后仍禁止新 Turn。本版没有“清除
未知”、外部效果核验或自动重放 API；业务处理或新 Session 的决定属于调用方，
不得通过换 ID 就把同一未知外部操作当成安全重试。

## 可替换后端与持久性边界

`SessionBackend` 是 `source/read/write/close` 的显式合同。`write` 必须完整
原子 CAS，只有达到声明的持久性边界才成功返回，失败不能猜测未提交。替换
后端不得返回旧缓存或绕过必要记录屏障。内存实现为 `volatile`；SQLite 实现为
`persistent`，关闭 Store 会关闭其拥有的后端，不能由多个 Store 共享同一
后端所有权。多个 SQLite 连接可指向同一文件，事务内 CAS 防止失更新，
但这不授权多个内核同时执行同 Session。

SQLite 使用当前仓库已有的 `better-sqlite3`，显式绝对文件路径、DELETE
journal、`synchronous=FULL`、1 秒锁等待。会话完整 JSON 与 revision/digest
在同一事务更新。digest 用于发现意外不一致，不是防篡改签名。
SQLite 提供本地事务的原子提交与恢复；没有测试硬件掉电、损坏介质或不诚实
文件系统，网络文件系统和敌对路径替换不在支持边界内。

此文件独立格式初始版本为 1（application_id 为 NAS1、user_version 为 1）。
`format.ts` 是会话格式校验/派生状态的统一入口；没有已发布前代格式需要迁移。
未来格式变化必须在此定义明确版本迁移，不能猜测修复畸形记录；未知数据库、
schema 或版本拒绝打开，不修改原证据。Yui Home storage 版本没有变化。

每 Session 最多 10,000 个事件、16 MiB JSON；每事件 1 MiB，批次最多 8 个
调用，每调用参数 64 KiB。达到容量即拒绝保存，不截断。当前实现每次读写
完整有界会话文档，分页限制输出而不减少内部校验开销。它不是无限日志、
压缩服务或大规模数据库；需要更大历史时由上下文/产品合同另行设计，
不能删除事实以伪装可恢复。内核本身的消息/历史限制仍然有效。

## 验证与未覆盖范围

`test/core/native-agent-session.test.js` 通过公开入口验证内存/SQLite 后端替换、
离线内核接线、重启后续聊、事务 CAS、分页、订阅失败隔离、取消保留结果、
保存失败阻止新增工具效果、回执丢失、未开始/未知效果、畸形与部分记录和
不支持的版本。fixture 自建目录且 finally 关闭连接并删除目录，不启动
Controller、Agent Host、真实模型或账号服务。

这是存储模块独立验收；新的 required-recording 内核、上下文构建、UI 和遥测
实现的组合验收尚未在此完成。生产内核必须遵守写前确认和失败结算合同。
