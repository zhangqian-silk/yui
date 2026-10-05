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
    recorder,
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

`recorder` 是内核必要记录接线，普通 UI/遥测通过独立的可选 `observer`；
可选观察者的异常不能否定必要保存。

## 保存、查询与观察

- `create(sessionId, location?)` 保存空会话与可选不可变位置；`append(event, expectedRevision)` 只追加一个
  事实，返回 `sessionId/revision/digest/source` 回执。revision 是会话范围的
  事实数，event.seq 则在每个 Turn 从 1 开始。没有隐式覆盖或自动重试。
- `load` 校验完整格式、身份、顺序和调用/结果配对后，返回只读文档、消息和
  派生恢复状态。只保存一个权威文档，派生投影不会独立写入。
- `query(sessionId, { after, limit })` 返回游标之后最多 100 条事实及当前修订号。
  游标是同 Session 的 revision；`nextCursor: null` 表示该次读取已到末尾，
  后续增量从该次回执的 revision 开始。不是跨多次请求冻结的快照。
  内置后端从事件投影按需读取，另受 2 MiB 页预算限制；有字节限制时可能少于
  limit。替换后端可提供 `SessionBackend.query`；原最小后端仍可用完整文档实现
  此旧增量合同，但不能以它冒充下述有界 `SessionCatalog`。
- `subscribe` 返回幂等取消函数，只通知本 Store 成功提交的回执，不重播历史，
  不保证跨进程通知，不充当持久事件队列。每个订阅最多一个运行回调和一个
  合并后的待通知回执。回调拒绝/抛错会取消该订阅，不影响提交；挂起回调不会
  阻塞写入。调用方要恢复观察时重新 query/subscribe。最多 64 个订阅。
- `recorder` 返回 `SessionRecording`，其 `record(event): Promise<void>` 与必要
  记录消费合同结构兼容，保存确认保留在 `lastReceipt`，不定义另一套内核
  SessionRecorder 类型。一次失败后停止接受新事实。`SessionSaveError`
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
版本 2 的工具结果事件保留 `settlement` 执行与释放证据；身份和结果使用外层
事件及配对消息，不重复保存。释放失败和部分获取失败派生为 `cleanup-required`，
不会改写已确认的工具 outcome，但禁止新 Turn/Step/工具启动。它是现有事实的
只读恢复判断，不是额外调度协议；目前没有自动清理/清除接口。
只读诊断始终可用。调用方可以在确认原执行者已经停止后，用明确的 `append`
操作保存确切缺失结果并结束原 Step/Turn，不能伪造未知调用的成功。需要记录
无法确认的效果时可写 `effect: unknown`，之后仍禁止新 Turn。本版没有“清除
未知”、外部效果核验或自动重放 API；业务处理或新 Session 的决定属于调用方，
不得通过换 ID 就把同一未知外部操作当成安全重试。

## 可替换后端与持久性边界

`SessionBackend` 是 `source/read/write/close` 的显式合同；带位置创建使用
可选的 `createWithLocation` 原子端口（完整签名见下）。`write` 必须完整
原子 CAS，只有达到声明的持久性边界才成功返回，失败不能猜测未提交。替换
后端不得返回旧缓存或绕过必要记录屏障。内存实现为 `volatile`；SQLite 实现为
`persistent`，关闭 Store 会关闭其拥有的后端，不能由多个 Store 共享同一
后端所有权。多个 SQLite 连接可指向同一文件，事务内 CAS 防止失更新，
但这不授权多个内核同时执行同 Session。

SQLite 使用当前仓库已有的 `better-sqlite3`，显式绝对文件路径、DELETE
journal、`synchronous=FULL`、1 秒锁等待。会话完整 JSON 与 revision/digest
及其只读事件查询投影在同一事务更新。投影没有独立写入 API；已有文档仍是
必要记录与恢复的权威。digest 用于发现意外不一致，不是防篡改签名。
SQLite 提供本地事务的原子提交与恢复；没有测试硬件掉电、损坏介质或不诚实
文件系统，网络文件系统和敌对路径替换不在支持边界内。

会话文档仍为版本 2，保留可选 settlement 证据；SQLite 布局升级为版本 4
（application_id 仍为 NAS1、user_version 为 4）。`sqliteFormat.ts` 是集中布局
初始化和迁移入口，声明 v1→v2→v3→v4 链；`format.ts` 仍拥有文档校验及 v1→v2
文档转换。打开合法旧库时，同一事务验证所有原始身份/revision/digest/事件：
v1 只转换文档版本和摘要，不补造 started/cleanup；v2→v3 完整保留文档字节、
revision 和 digest，新增 null 标题、metadataRevision=0、库 UUID 以及按
`(session_id, revision)` 主键索引的事件投影。每次只验证一个有界文档，
整次迁移仍是一笔事务。v3→v4 验证原文档、标题版本与事件投影一致性后只添加
nullable `location TEXT` 并扩展 SQLite 维护的覆盖索引。原 v2/v3 文档字节、
revision、digest、历史及 settlement 不改写；v3 的库 UUID、目录版本、
标题和 metadataRevision 不变。所有 v1/v2/v3 旧记录位置均为 null，不猜补。
失败连同 DDL 和版本推进一起回滚；未知版本、schema 或畸形历史保留现场，
不猜测修复。新库直接创建布局 4；没有自动降级，旧二进制不可打开布局 4。
仅处理调用方显式选择的独立库，不改变 Yui Home。

每 Session 最多 10,000 个事件、16 MiB JSON；每事件 1 MiB，批次最多 8 个
调用，每调用参数 64 KiB。达到容量即拒绝保存，不截断。`load`/追加保存及
owner admission 仍校验完整有界文档；目录/历史查询不加载完整文档。它不是无限日志、
压缩服务或大规模数据库；需要更大历史时由上下文/产品合同另行设计，
不能删除事实以伪装可恢复。内核本身的消息/历史限制仍然有效。

## 持久目录、标题与按需历史（给入口消费者）

`SessionStore` 实现公开 `SessionCatalog`，两个内置后端提供同语义的
`SessionBackend.catalog`。最小的第三方 read/write 后端没有此端口时，
目录调用明确返回 `unsupported_catalog`，没有进程标签或完整历史扫描回退。
消费者可只注入 `SessionCatalog`；执行时另把同一个 store 交给既有 owner。

```ts
import {
  createSessionStore, createSqliteSessionBackend,
  type SessionCatalog, type PageOptions,
} from '../index.js';

const store = createSessionStore(createSqliteSessionBackend(explicitAbsoluteFile));
const catalog: SessionCatalog = store;
try {
  const page = await catalog.listSessions({ limit: 20 });
  // 展示 page.items 的 sessionId/title；重复标题仍以用户所选真实 ID 定位。
  const id = page.items[0]?.sessionId;
  if (id !== undefined) {
    const info = await catalog.getSessionInfo(id);
    await catalog.renameSession(id, 'User-supplied title', info.metadataRevision);
    const history = await catalog.readHistory(id, { limit: 20 });
    // nextCursor 非 null 时，以同一 limit 读取下一页；到 null 停止。
    // history 不是完整执行上下文，不能把单页交给内核自动重放。
  }
} finally { await store.close(); }
```

实际签名：

```ts
create(sessionId: string, location?: SessionLocation): Promise<SaveReceipt>;
listSessions(options?: PageOptions): Promise<SessionCatalogPage>;
getSessionInfo(sessionId: string): Promise<SessionDetail>;
renameSession(sessionId: string, title: string | null, expectedMetadataRevision: number): Promise<SessionDetail>;
readHistory(sessionId: string, options?: PageOptions): Promise<SessionHistoryPage>;
```

- 新建兼容 `create(id)`，空文档和初始元数据原子保存后立即可发现，没有第二步
  目录注册。列表只返回 `sessionId/title/metadataRevision`、库身份、目录 revision、
  `nextCursor`；不含正文、预览或 live 状态。详情加现有 document revision/digest/source。
  详情还返回 `location: SessionLocation | null`，列表不含位置。
  标题只有 sessions 行（Memory 的元数据项）一个可写权威，不放进历史。
- title 为 null（清除）或 trim 后 1–200 个 Unicode code points；拒绝控制字符、
  单独 surrogate、空白及超长值，不静默截断。标题可重复，ID 是唯一选择键。
  同标题且正确预期版本是无变化成功；过期版本即使标题相同仍报 `revision_conflict`。
- `metadataRevision` 和 document revision 分离。标题变更不改事件/历史回执，不使
  历史 cursor 失效；追加事件不覆盖标题，也不使目录 cursor 失效。SQLite 的标题
  CAS/目录版本维护在同一 immediate 事务；两个连接竞争同一版本只有一个成功。
- 默认 limit=20、范围 1..100；ID 按 UTF-8 二进制顺序 keyset 分页。SQLite
  目录 SELECT 不选择 document，最多取 limit+1 个摘要；目录与详情指定 SQLite
  自动维护的 `session_info` 覆盖索引，不读取含大文档的表记录/overflow pages。
  索引没有独立写入 API，不是第二份标题权威。Memory 维护排序 ID，
  二分定位后只复制当前页摘要，不扫描/复制所有文档。没有默认全量总数。
- 历史是原始 `{revision,event}`，保留 Session/Turn/seq、call/result/settlement
  身份，工具配对可能跨页。SQLite 先读轻量 revision/digest，再从索引按位置取
  单个事件；每页最多访问 limit+1 个有界事件，2 MiB 输出预算含 64 KiB envelope
  预留，覆盖 JSON 转义后的身份、文件 source 及最大 4 KiB cursor。
  每个合法事件最多 1 MiB，因此一定能完整进入一页，无 `ItemTooLarge` 死路、
  截断或静默跳过。每条投影校验自己的摘要和 Session 身份；完整历史语义校验
  仍属于 `load`，查询页不能用于恢复判断。
- 不透明 cursor 绑定协议、持久库 UUID/Memory 实例、操作、Session（历史）、
  limit、相关 revision 和下一位置；最大 4 KiB，不是权限凭证或防篡改签名。
  错库/错会话/结构错/参数错配报 `invalid_cursor`，绝不默默回首屏。
  新建或真实改名使目录链报 `cursor_stale`；历史追加使历史链失效。调用方应刷新
  首屏，不混合新旧页。无变化的链不重不漏；SQLite 重开同库 UUID 保持，仍有效的
  cursor 可继续。复制数据库会复制其 UUID，视为同一数据来源；不支持分叉副本
  的游标互用或跨数据库调度。Memory close 后事实和 cursor 不持久。
- 读取同页版本和记录在同一 SQLite 读事务内完成，不维持跨请求长事务；
  高频写入下不保证长列表能走到末页。不提供 TTL、快照归档或后台清理器。
- `not_found` 不新建；读 I/O 失败为 `read_failed`，没有空目录回退。
  标题写失败为 `SessionMetadataSaveError`，带目标/title/预期 revision/cause，
  effect 保守为 unknown；可能已提交，先用 getSessionInfo 对账，不能盲重试。
  确认的 not_found/CAS/closed 前置拒绝保持原错误。旧 `SessionSaveError` 不变。
  命名没有隐式写重试、模型生成或订阅通知；调用方显式刷新目录。
- 查询不创建 Agent、工具执行、订阅、计时器或 live handle。选中 ID 后是否允许
  新 Turn 仍由既有 owner/load/recorder 决定；持久未终态不等于 live execution，
  未知效果/cleanup-required 不会被目录读取清除。

独立可执行样例（无需账号/Controller/网络）：

```sh
npm run build
node dist/nativeAgent/session/catalogDemo.js
```

样例创建三个会话（一个带位置，其余明确缺失）、重复标题/清除、通过 owner
保存一轮、关闭全部连接后重开，按 ID 读取原位置，
分页发现与 ID 选择、改名、分页读取原历史/回执，再通过同一公开 owner 合同续聊。
finally 关闭自有 owner/store 并删除临时目录。它是 81 存储/owner 合同证据，
不是 80 CLI 装配或 82 授权/环境的最终联合验收。

## 原子创建位置与恢复消费合同

完整类型和签名位于 `session/contracts.ts`；从 `session/index.ts` 或上级
`nativeAgent/index.ts` 导入 `SessionLocation`、`SessionStore`、`SessionDetail`。
运行时有界常量 `locationLimits` 也由两个入口导出。

```ts
type SessionLocation = { readonly root: string; readonly cwd: string };
type SessionDetail = SessionInfo & SaveReceipt & {
  storeId: string;
  location: SessionLocation | null;
};
// SessionStore:
create(sessionId: string, location?: SessionLocation): Promise<SaveReceipt>;
getSessionInfo(sessionId: string): Promise<SessionDetail>;
// SessionBackend 可选端口，带位置时必须同时提供 SessionCatalog:
createWithLocation?(document: SessionDocument, location: SessionLocation): Promise<void>;
```

调用方解析配置并验证实际位置，然后显式传入 `store.create(id, { root, cwd })`。
只接受恰好这两个字段的普通对象；每个路径最多 4096 UTF-8 字节，拒绝控制字符、
未配对 surrogate、相对路径、未解析的 `.`/`..`、多余分隔符及非根路径的尾分隔符。
使用运行平台的 `node:path` 语义：必须等于 `resolve(path)`，
`relative(root, cwd)` 不得逃出 root；cwd 可等于 root。不会 trim、改写、
探测文件系统或判断 symlink，非存在路径也可存储。跨 OS 路径搬迁不是支持合同。
校验在写入前完成且复制输入，后续调用方改动不影响位置；公开 Store 详情递归只读。
没有修改位置 API，append/rename 不更新位置；再 create 同 ID 发生 CAS 冲突，
不能用它改根目录。旧 create 的 undefined/省略参数表示缺失，显式 null 是坏值。
不接受 grant、credential、allowlist 或任意 metadata。

内置 Memory/SQLite 将位置与空 Session、初始目录元数据一起原子保存；没有
第二步写入窗口。最小第三方 backend 不实现 `createWithLocation` 或不提供
bounded catalog 时，带位置创建在调用写端口前报 `unsupported_location`；
旧 create 仍走原 `write(document, null)`。端口实现者必须原子仅创建空文档，
拒绝已有 ID、保存原位置且不可修改、同一 ID 详情可读；不能静默丢弃。
`SaveReceipt.digest` 仍对应原文档，不包含位置/标题，不是权限或位置完整性签名。
SQLite 的同一 sessions 行保存唯一位置权威；索引由 SQLite 自动维护。
getSessionInfo 为有界覆盖索引读取，不加载完整文档或历史，位置坏值报
`corrupt_session`，不存在 ID 报 `not_found`，不返回猜测位置。

任何 backend 创建确认失败仍为 `SessionSaveError`，`effect: 'unknown'`、
expectedRevision=null，并带复制只读的 `location`（无位置时 undefined）。
即使失败也可能已经提交；不自动重放 create 或模型/工具效果。消费者用**同一个
Session ID** 调用 `getSessionInfo`，比对位置并用 `load` 对账文档状态；读失败时保留
未知边界，不能换 ID 伪装安全重试。可以通过 backend.createWithLocation 直连
原始 CAS 错误，但 Store 保留原必要保存错误的保守语义。

```ts
const store = createSessionStore(createSqliteSessionBackend(explicitAbsoluteFile));
try {
  // 首次创建，root/cwd 已由入口解析并验证；自行选择稳定 Session ID。
  await store.create('chosen-id', { root: resolvedRoot, cwd: resolvedCwd });
  // 重启/确认丢失后：只读同 ID，绝不自动再 create。
  const detail = await store.getSessionInfo('chosen-id');
  if (detail.location === null) {
    throw new Error('Missing saved location: refuse automatic restoration; choose a new Session explicitly');
  }
  // 80 在这里负责实际存在性/边界、显式配置冲突检查。
  // 随后按原位置重新装配 82/84 并获取本次授权，历史位置本身不是权限。
  const saved = await store.load(detail.sessionId);
  // 仍必须遵守 saved.recovery；unknown-effects/cleanup-required 不自动恢复执行。
} finally { await store.close(); }
```

位置只是恢复配置的原始事实：不创建执行者、不恢复凭证、不消除 unknown-effects。
本模块交付存储与离线可消费合同，不实现/宣称 80、82、84 的联合产品恢复验收。

## 验证与未覆盖范围

`test/core/native-agent-session.test.js` 通过公开入口验证内存/SQLite 后端替换、
离线内核接线、重启后续聊、事务 CAS、分页、订阅失败隔离、取消保留结果、
保存失败阻止新增工具效果、回执丢失、未开始/未知效果、畸形与部分记录和
不支持的版本。fixture 自建目录且 finally 关闭连接并删除目录，不启动
Controller、Agent Host、真实模型或账号服务。

上述是存储模块独立证据；实际 required-recording 内核、上下文、UI、遥测与
SQLite 重启组合见 `native-agent-composition.test.js`。迁移与失败回滚另有固定
`native-agent-session-migration.test.js`。均不证明真实模型或硬件掉电行为。
`native-agent-session-catalog.test.js` 增加 Memory/SQLite 查询替换、命名 CAS、
真实关闭重开、cursor 刷新、确认丢失不重放、v2→当前布局原子回滚和大事件分页。
`native-agent-session-location.test.js` 增加真实 Memory/SQLite 原子位置、不可变、
缺失/坏值、替换 backend 能力拒绝、同 ID 确认丢失对账、创建竞争/事务失败、
关闭全部连接重开及 v3→v4 字节/settlement 保留与 DDL/投影损坏回滚。

对其他模块：上下文构建只能使用不可变历史副本，裁剪不能写回会话事实。
交互层可从分页事件投影历史，订阅只负责通知刷新；submit/cancel 和真正的
activeTurnId 仍由执行所有者提供，未保存终态不等于进程仍在执行。观测层
可以将已保存的 `document.events` 标为 replay，而不能标为 live/cached；
本模块没有缓存读取。现有 AgentEvent 终态只含 errorCode，不含原始
TurnResult.error.message，因此不会伪造完整原始 TurnResult。需要该原始
结果时由生产者提供，未来持久化它须先确定明确的公共证据合同。
