# 独立 Agent 执行内核与组合合同

这是自有 TypeScript 类型和循环组成的独立 Agent，默认样例不调用真实模型、不依赖
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
  `executeBatch({scope,calls,signal,beforeExecute,afterExecute})`。`tools` 数组通过 `createToolExecutor`
  组装成同一合同，也可只提供 `toolExecutor` 替换实现；两者必须且只能选一。
  内核先核对声明、调用身份与预算，再顺序调用；执行器负责授权、参数验证及
  实际效果结算，不得自行重放未知效果。`afterExecute` 在资源释放之后，
  将 `ToolSettlement` 的执行/释放证据与配对消息一起写入必要的 `message_appended` 事件
  （身份和 outcome 已由事件/消息承载，不重复存储）；
  cleanup 失败不覆盖已确认结果，但停止后续效果。`tools` 简写只表示调用方已授权
  这些预绑定工具，使用无资源 lease 和允许策略，不宣称额外限制 root/env。
  构造期固定工具声明，工具配置变更需重新组装。
- `ContextBuilder.build({request,budget}, signal)` 在每次模型调用前执行，返回
  `{request,report}`。默认使用真实上下文构建器；超限需要显式压缩器，否则报错，不静默丢弃历史；
  `contextBudget` 使用所选 estimator 的单位（默认 1 MiB JSON 字节、输出预留 0）。
  `TurnResult.contextReports` 保留每步报告及带报告的预算失败。投影会再次校验调用/结果配对及
  请求预算，不改写权威历史、工具声明和 Session/Turn/Step 身份。
  隐藏历史不能绕过原始调用 ID 去重或未知效果检查。
  可替换容量/计数来源、输出/工具预留、有界 provider 摘要、保留锚点和来源 digest
  见 [context 合同](context/README.md)。`node dist/nativeAgent/compactionDemo.js`
  是真实模块＋离线模型响应的多次压缩续聊示例，不证明真实模型摘要质量。
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
独立会话格式见 [session/README.md](./session/README.md)，不修改 Yui 存储版本。

项目编码指导的公开工厂 `createProjectGuidance({root,cwd,sessionId})` 提供已有
`ContextSource` 和两个普通工具，用于目录指令、先 catalog 后完整加载的 Skills、
唯一可见 `.agents/MEMORY.md`。只有内置编码行为是 system；项目文本保持带 scope
和指纹的 required 数据。组合、frontmatter 子集、记忆管理和边界见
[projectGuidance/README.md](./projectGuidance/README.md)，可执行消费证据见
`native-agent-guidance.test.js`。不需要改写内核、工具授权、协议或会话格式。

## 公共组合示例与模块所有权

```ts
import { createAgent, createToolExecutor, type AgentOptions } from './index.js';

// provider、tools、contextBuilder、recorder、observer 由调用方创建。
const options: AgentOptions = {
  provider,
  toolExecutor: createToolExecutor({ tools, environment, permission }),
  contextBuilder,
  contextBudget: { capacity: 100_000, reserveOutput: 1000 },
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

`native-agent-composition.test.js` 已连接七个实际模块：网关编解码/流处理、工具管理、
编码工具、SQLite 会话、上下文、CLI、观测。证明读取→指纹编辑→本地检查→回答→
保存→关闭重开→续聊；网络传输替换为确定性 SSE fixture，不调用真实厂商账号。
因此这是实际模块的离线组合证据，不是真实模型规划能力或线上协议兼容性证据。

### 共同组合入口

`createExecutionOwner` 是交互入口与执行内核之间的薄连接：只持有当前执行句柄，
每次提交从 store 读取完整历史并取得必要 recorder，再调用同一个 `Agent.runTurn`。
不增加循环、调度器、后台重试或恢复状态。`settle(sessionId)` 返回当前/最近一次本地
执行的结果、保存回执和原始失败；它不从历史重造旧 TurnResult。
`close()` 取消并等待自己持有的执行，调用方随后关闭 store 和 observer。
同一 Session 必须只有一个执行所有者；CAS 不等于跨进程执行租约。
可选 `context: {builder,budget,tools,retention}` 必须与 Agent 工厂共享，
启用 `compact(sessionId,signal)`：空闲 ready Session 的只读手动压缩，随后 submit
校验并消费同一进程内投影。并发/存储变化/取消显式拒绝，不创建第二摘要账本。

```ts
const observations = createLocalObserver();
const progress = createInteractionProgress();
const store = createSessionStore(createSqliteSessionBackend(explicitAbsoluteFile));
const provider = createModelGateway({
  ...explicitModelOptions,
  onObservation: connectModelObservations(observations, progress.observe),
});
const executor = createToolExecutor({ tools, environment, permission });
const sessions = createExecutionOwner({
  store, maxSteps: 8, observer: observations,
  sessions: [{ id: knownSessionId, title: 'Explicitly selected session' }],
  agent: recorder => createAgent({
    provider, toolExecutor: executor, contextBuilder: createContextBuilder(),
    recorder, observer: observations,
  }),
});
// knownSessionId must already exist; sessions.create(title) creates a fresh ID.
try {
  const cli = await openCli({
    sessions, input, output, initialSessionId: knownSessionId, progress,
    diagnostics: createInteractionDiagnostics(observations),
  });
  await cli.done;
} finally {
  await sessions.close();
  await store.close();
  observations.close();
}
```

上例变量均由调用方显式提供，不隐式读账号、工作目录或全局配置。根/env 已预绑定的
工具必须匹配授予的环境；第四个 environment 参数不会重新限制其 root/env。
会话列表是调用方显式选择的 catalog 加本进程新建项，标题只是显示标签；
不是 SQLite 自动枚举或持久标题。重启时明确提供已知 ID，`/use ID` 仍可直接查询
同一 store 内的确切会话。未结束记录不冒充活动句柄；未知效果和 cleanup-required
拒绝新录制，不能通过 UI 自动恢复或重放。

存储现在另提供持久 `SessionCatalog`：`store.listSessions/getSessionInfo/
renameSession/readHistory` 可在重启后发现和命名原会话，并通过 ID 交给此 owner。
此窄查询端口不创建运行句柄，也没有改写现有 CLI 的 offset/显示标签接口；
产品入口应显式消费新端口，而非把上面的本进程 catalog 当持久目录。
公开签名、CAS/cursor、布局迁移和可运行的 `catalogDemo.js` 见
[session/README.md](./session/README.md#持久目录标题与按需历史给入口消费者)。

`connectModelObservations` 保留真实请求身份、用量、状态和累计 elapsedMs；
不虚构 started/duration。`createInteractionProgress` 只转发实时增量，CLI 有界暂存，
不将增量写入会话历史；显示可丢，最终消息来自必要记录。

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

## 基础编码工具包

`createCodingTools` 只做显式组合，不替代权限分派或工具执行结算框架。
使用者可单独选择、替换任何 `Tool`，依赖仍只有公开的 `Tool` 合同：

```ts
import { createCodingTools } from './index.js';

const tools = createCodingTools({
  root: '/absolute/controlled/workspace',
  // 不提供 command 时只有文件工具；提供时必须明确完整子进程环境。
  command: { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10_000 },
});
```

文件工具为 `read`、`write`、`edit`、`patch`、`list`、`find`、`search`；显式启用后
增加 `command`。也可分别使用 `createTextTools`、`createSearchTools` 和
`createCommandTool`。工具实例没有持久化状态、后台服务或额外会话身份。
所有操作都在 `execute` 再次验证参数，因此可用简单 fixture 执行器独立验收。
调用方负责授予工具能力及审查命令内容；本模块不提供权限 UI 或授权策略。

### 文件读取、写入与精确编辑

`createTextTools({ root, maxBytes?, maxOutputBytes? })` 要求显式绝对目录，
默认且最大文件大小 8 MiB、最终外层 JSON 回执 64 KiB，都可调小；
按 `read, write, edit, patch` 顺序返回。read 参数
`{path,startLine?,limit?,cursor?}`，默认从第 1 行读取 200 行。
返回 JSON `{path,text,bytes,fileBytes,sha256,byteStart,byteEnd,startLine,endLine,
complete,nextCursor,truncationReason}`。`sha256` 来自完整原始字节；
字节范围从 0 开始、右端不包含，行号从 1 开始，保留 BOM、CRLF 和 EOF。
长行允许按 Unicode code point 分页，不伪称整行返回；`bytes` 是本页原始
文本字节数，不是 JSON 编码大小。cursor 必须和原 path/startLine/limit/config
一起传入，绑定完整 hash 与文件身份；变更返回 `stale_cursor`，参数不一致返回
`invalid_cursor`。游标无持久状态，每页重读有界文件；实现保留最多 8 MiB
快照，不声称无限流式读取。write 参数
`{path,content,expectedSha256?}`，缺省指纹只允许创建不存在的文件。
替换已有文件必须传入此前读取的 `expectedSha256`，缺失或不一致返回
`edit_conflict`，不会覆盖原文件。write/edit 成功返回
`{path,status,beforeSha256,sha256,candidateSha256,bytes,diff}`。

edit 参数 `{path,expectedSha256,oldText,newText}`，`oldText` 必须非空且在
文件中恰好出现一次（重叠匹配也计数），否则冲突。它是字面精确替换，不是
正则或模糊补丁。所有工具拒绝额外字段；参数自身的 JSON 字节上限仍适用。
patch 参数 `{files:[{path,expectedSha256,edits:[{oldText,newText}]}]}`，
最多 16 个已有文件、每文件 32 个 edits；不支持删除/移动，创建仍用 write。
所有 edits 针对同一原文件定位，禁止重复路径别名和重叠；全批预检指纹、
候选内容及编码后 diff/回执预算，再按请求顺序提交。输入 JSON 仍最多
64 KiB，原文件与候选内容合计最多 32 MiB。无法表达回执时写前拒绝。
同包写调用按排序后的规范化目标路径取得队列；提交前重新核对内容与身份。
patch 成功返回 `{files,complete:true}`。中途失败停止，**不回滚**：
已提交文件保留，后续未尝试；`effect:unknown` 的错误 `message` 为有界 JSON
`{complete:false,files,failedIndex,cause,temporary}`。文件 `status` 为
`committed/rejected/not_attempted`；只有 committed 的 `sha256` 确认实际提交，
其他为 null，`candidateSha256/bytes/diff` 是计划内容而非磁盘当前状态。
公共执行器与 loop 保留回执、释放 lease、停止后续工具，禁止盲重放。
diff 来自本次实际 before/after（不是 HEAD），含 hunk 坐标及 EOF newline
标记；远距 edits 使用独立带上下文 hunks，不会把用户旧改动算作本次贡献。
取消在提交前停止，已完成 rename 则如实返回成功，不回滚或伪称未发生。

拒绝绝对路径、父目录穿越、符号链接、非普通文件和多硬链接文件；父目录
必须存在。read 有界读取并验证 UTF-8；文本工具以 NUL 为现有二进制分类界限，
预检发现源文件或候选内容包含 NUL 时返回 `binary_file/effect:none`，在任何
提交前拒绝；提交期间发生外部变化则沿用已有部分效果回执，不冒称没有效果。
非法 UTF-8 仍返回 `invalid_utf8`。这不是通用二进制格式检测。
write 在同目录创建独占临时文件，
完成后 rename 替换目标，取消前检查，保留已提交效果。临时文件创建权限
为 `0600`，替换会使用新文件权限；不保留旧 inode、权限或其他元数据。
清理失败报告自有临时文件相对路径和未知效果，不隐藏残留。

这里没有 fsync 掉电持久性、通用事务、敌对文件系统隔离或跨工具实例/外部
进程的原子 compare-and-swap 保证；最后复核与 rename 之间仍有竞争窗口。
调用方必须独占受控目录的写入期，不得把指纹检查当作强并发锁。根目录由
调用方显式授予并规范化；需要强隔离时应提供单独实现，而非夸大路径检查。

### 目录与检索

`createSearchTools({root,...limits})` 返回 `list, find, search`：

- `list({path})` 浏览直接子项，返回 `{path,type}`。
- `find({path,query,mode?})` 默认按文件名的大小写敏感字面子串查找；
  `mode:"glob"` 按 root 相对路径匹配，返回 `{path}`。
- `search({path,query,mode?})` 默认检索单行字面子串；
  `mode:"regex"` 使用下述有限语法。返回 `{path,line,text}`；
  长行返回有界预览，额外标明 `textTruncated,lineBytes,byteStart,sha256`，
  用 read 的 startLine 获取完整文本。匹配正文与预览只移除 LF 或完整 CRLF
  行终止符，不移除孤立 CR；原始字节偏移与完整文件 hash 不变。

`path` 为相对目录或显式文件，`.` 选择 root。每层路径排序，确定性深度优先；
返回 JSON `{results,complete,scanComplete,nextCursor,coverage,skipped,budgets,
truncationReason}`。`complete` 只代表查询结果分页结束，`scanComplete`
表示有界扫描已完成，`coverage.complete` 表示未因策略/二进制产生缺口；
跳过目录的计数是子树入口数，不是猜测后代文件数。三者不能互相替代。
结果上限与编码大小形成页，cursor 绑定工具/参数/策略/预算及扫描指纹；
每页完整有界重扫，无索引、游标存储或后台服务。变化拒绝续页。
默认且最大预算为 `maxEntries:10000`、`maxResults:200`、
`maxOutputBytes:65536`（含外层转义）、`maxFileBytes:8388608`、
`maxTotalBytes:33554432`、`maxDepth:32`、`maxPatternWork:2000000`。
达到扫描硬预算返回 `limit_exceeded`，模式工作量超限为 `pattern_limit`；
不返回伪完整页，要求缩小范围。目录名集合、结果页、文件快照均有上限。

共同参数 `ignore/generated/hidden/exclude/cursor`：ignore 默认 true，读取
root 及逐级 `.gitignore`（每份最多 64 KiB、合计最多 1024 规则，也计入扫描字节
和模式工作量）；生成目录 `node_modules/dist/build/coverage` 默认排除，
generated:false 关闭；隐藏文件默认可见，hidden:false 排除；exclude 是最多
16 个额外 glob。`.git` 元数据始终排除，显式文件绕过发现过滤但不绕过安全检查。
忽略目录直接剪枝，不能只否定其后代；嵌套仓库重置继承 ignore，不重置
调用者 exclude。显式选中目录本身不被过滤，其后代仍遵循策略；显式文件
不加载 ignore 规则。`.git` 显式路径也拒绝（文本 read 的权限范围不因此改变）。
非 Git 目录同样读取 `.gitignore`。不读取父 root/global ignore、
`.git/info/exclude` 或 index，不保证 Git 已跟踪文件特例。

glob 支持 `* ? [abc] [a-z] [!a]` 与反斜杠 literal escape；`**` 必须为
完整路径段，可匹配零或多个段（如 `**/*.ts`）。不支持 brace/extglob；
未转义的 `@(...) +(...) ?(...) !(...) *(...)` 明确拒绝；转义的操作符或
左括号可按字面匹配，不增加 extglob 引擎。
ignore 支持注释、`!` 否定、首 `/` 锚定、末 `/` 目录和逐级覆盖，
但尾部空格按字面处理，不宣称完全 Git wildmatch 兼容。
regex 支持字面字符、`.`、字符类、`^ $`、`* + ?`、`\d \w \s` 与元字符
转义；字符类内不支持转义。无分组、alternation、计数重复、flags、
backreference 或 lookaround。
模式最多 256 个 UTF-16 单元；动态状态匹配每次转移计入工作量，不使用任意
JavaScript 回溯正则。未支持语法明确报 `unsupported_pattern`。

这些工具采取严格遍历：遇到符号链接、非普通文件、多硬链接就失败；
search 遇到过大文件或非法 UTF-8 也失败，绝不静默跳过后声称没有匹配。
NUL 二进制跳过并计入 coverage；非法 UTF-8 仍明确失败，不伪称无匹配。
取消或失败关闭已打开文件和目录。安全检查不是强沙箱；同一次目录扫描
检测目录身份/时间戳变化，但不提供整个仓库的原子快照。

### 本地命令

`createCommandTool({root,env,timeoutMs?,maxOutputBytes?,killGraceMs?})` 返回
`command`，参数为 `{command,argv,cwd}`。command 和 cwd 必须绝对路径，
cwd 解析后必须仍在 root 内；argv 是字符串数组。不会隐式调用 shell，
也不继承 `process.env`；env 是调用方明确提供的完整环境。若需要 shell，
必须显式选择 shell 可执行文件及参数，仍由调用方负责其授权和风险。
标准输入关闭，无交互终端。

默认超时 10 秒（最大 60 秒），stdout/stderr 合计捕获最多 64 KiB
（可调小），终止宽限期默认 100 ms（最大 1000 ms）。超限、超时、取消或
直接子进程退出后仍有进程组成员时，向自有 POSIX 进程组发 TERM，再在
宽限期后发 KILL，并最多额外观察 100 ms；等待不是无限期。

成功执行返回 JSON：命令、参数、cwd、pid、实际 exitCode/signal、
stdout/stderr、capturedBytes、outputTruncated、directChildExited、
processGroup 等。非零退出码仍保留为实际执行结果，调用方须检查它，
不能把 Tool 的 `ok:true` 当作业务成功。终止类错误用 `effect:unknown`
保存同样证据，因为已开始的命令可能已经改变文件或产生其他副作用。
尚未启动则为 `effect:none`。进程组探测是观察而非全后代追踪；
`descendantsMayHaveEscaped:true` 明示自行脱离进程组的后代无法证明停止。
不自动重试、不自动回滚，也不声称取消后所有背景效果已停止。

仅支持受控 POSIX 进程。命令可以访问 cwd 以外的路径、网络及其他系统资源，
这里的 root/cwd 检查不是命令沙箱；不应对不受信任命令开放该能力。

### 用户入口的真实安全绑定（Task82 生产合同）

`createLocalToolBinding(options: LocalToolOptions): LocalToolBinding` 从根
`index.ts` 导出，实现在 `localSafety.ts`。同一工厂创建真实编码工具、匹配的
`ToolPermission<LocalToolEnvironment>` 与 `ToolEnvironment<LocalToolEnvironment>`；
消费端只将这三者交给已有 `createToolExecutor`。不要把 `binding.tools` 传给
Agent 的三参数 `tools` 简写，也不要混用不同工厂的 tools/permission/environment。
即使替换为“总是允许”的 permission，工具自身仍拒绝外来或伪造 lease。
这里没有新增执行器、循环、全局 ACL 或 Yui 控制面接线。

```ts
import {
  createLocalToolBinding, createToolExecutor, createAgent,
  type LocalToolOptions,
} from './index.js';

// trustedOptions 由入口根据本次明确授权建立，不能由模型生成。
const trustedOptions: LocalToolOptions = {
  root: '/absolute/canonical/controlled/workspace',
  cwd: '/absolute/canonical/controlled/workspace',
  allowWrite: false,
  allowCommand: false,
};
const binding = createLocalToolBinding(trustedOptions);
const toolExecutor = createToolExecutor({
  tools: binding.tools,
  environment: binding.environment,
  permission: binding.permission,
});
const agent = createAgent({ provider, toolExecutor, recorder, observer });
```

`root` 和 `cwd` 都必须显式提供，是存在、可访问、规范化且所有路径组件无软链的
绝对目录；cwd 必须在 root 内。文件工具的相对路径基于 root（不是 cwd），
只有命令使用固定 cwd。常见单目录入口应明确设 `root === cwd === workdir`。
软链别名如 macOS `/var` 或 Linux `/home` 的使用者应先明确选择其真实目录，
再授权该真实路径；工厂不悄悄把软链别名转成更广范围。
root/cwd 的设备/inode 身份在创建时固定，acquire、permission、实际 execute
均重新检查；目录消失、替换或变成软链会拒绝旧绑定。

默认声明只有 `read/list/find/search`；`allowWrite:true` 才增加 `write/edit`。
`allowCommand:true` 只增加受审查的 `command`，不增加文件写能力。
布尔字段不接受字符串；配置和子配置拒绝未知字段。`text:{maxBytes?}`、
`search:{maxEntries?,maxResults?,maxOutputBytes?,maxFileBytes?,maxTotalBytes?,maxDepth?}`
沿用真实工具预算和错误语义。定义、配置快照和公开描述不可变。

命令配置为
`command:{env,specs,timeoutMs?,maxOutputBytes?,killGraceMs?}`。
每个 `LocalCommandSpec` 是 `{executable:string,argv:readonly string[],effect:'read'|'write'}`：
executable 是无软链组件的规范化绝对普通可执行文件，argv 精确匹配，
调用参数仍使用既有 `{command,argv,cwd}` 格式，cwd 必须等于绑定 cwd。
同一 executable/argv 不能重复。工厂固定 executable 的设备/inode/大小/mtime/模式
并在执行前复核；不是可执行文件内容的加密完整性或敌对更新防护。
模型不能追加参数、替换 cwd、选择 shell 或另一个解释器。
`effect:'write'` 的规格还要求 `allowWrite:true`；
`effect:'read'` 不要求 write。未授权规格前置返回 `command_not_authorized/effect:none`。

规格的可信边界是调用方对**具体程序及完整参数**的显式审查，而非工厂证明
程序只读。固定 shell/解释器脚本也必须逐项审查；不得把任意模型脚本、可写脚本文件、
可变外部配置或任意参数伪装成已审查规格。程序仍可能访问 cwd/root 外部、网络，
并经自身逻辑加载账号配置；需要这种行为的程序不应授予此能力。
工厂不是 OS 沙箱，不限制程序的所有系统调用。消费者不得把普通配置文件中的
“allowCommand”直接解释为任意命令授权。

`env` 是完整显式环境，只接受 `PATH`、`LANG`、`LC_ALL`、`TZ`；
默认不注入任何键，不合并 `process.env`。PATH 各段须为规范化绝对路径，
语言/时区字段接受有界格式。不接受 HOME、账号令牌、代理、加载器/解释器注入变量
或隐式配置入口；没有任意 env 透传选项。环境值及规格/argv 不出现在
`binding` 描述中；描述仅含 root/cwd、两个开关、envKeys、commandCount。
调用方仍须审查 PATH 目录、程序自身配置行为与工作目录内的文件。

`redact?:readonly string[]` 显式列出已知秘密文字，工具 outcome 的内容/错误消息
会脱敏；JSON 内容先解析、逐字符串值脱敏再编码（固定键和文件 sha256 保留），
覆盖转义文字并保留结构。
没有凭据自动发现或跨消息 DLP；未知文件秘密、调用参数、用户输入、模型请求、
必要历史和第三方观察出口并不因此变成无敏感数据。
不要把凭据放入 argv；入口的其他诊断消费者仍负责自身脱敏。
已脱敏 read 内容的 sha256 仍对应原文件字节；编辑必须使用未脱敏的权威内容，
否则精确编辑会冲突。不是通过脱敏修改实际文件。

lease 是本工厂内 WeakMap 识别的活对象，绑定确切声明、调用身份和参数；
绑定比较合同字段和 JSON 值，不把对象成员顺序视为身份；数组顺序和值仍严格匹配。
acquire 保存独立冻结快照，随后修改调用方对象不能改变已授予的调用。
不是 hash 或持久权限令牌。复制/反序列化描述、跨绑定、改变声明/调用、
release 后重用均前置拒绝。生命周期本身不启动进程；
release 撤销本次 lease，命令工具继续拥有它已启动的自有进程和预算结算。
无自动重放账本：调用 ID 唯一性、Session 串行和恢复仍由原内核/存储合同负责。

恢复及切换合同：80 从明确配置/当前授权取 root/cwd/能力/env/精确规格，
81 仅提供所选 Session 和 cwd 事实，Session 标题或旧描述不是授权。
先取消并等待旧 execution owner 结算，再关闭自己的 store/observer；
重新打开时创建新 binding 与 executor，重新验证真实目录/程序/权限，
再用同一 store 的完整历史创建 Agent/execution owner。不热更新旧 lease，
不从 Session ID 推导授权，不自动清除 unknown 或 cleanup-required。
绑定拒绝可由调用方修正明确配置后重建；必要记录失败应核对原记录和内存回执，
cleanup 失败应核对真实资源；unknown 应核实真实效果，不能重试原工具。

顺序和失败语义保持唯一 ToolManager：
参数检查 → acquire → 必要 before 意图屏障 → 取消/permission →
实际 execute → release → 必要 after 结果屏障。
默认/关闭能力时工具不存在，返回 `unknown_tool/effect:none`；环境或声明错误会
返回 `environment_failed`/`permission_denied`，真实执行入口兜底 `binding_mismatch`；
目录或程序变化返回 `binding_changed`，均不启动目标效果。
已确认成功 outcome 与 release/after 失败分开，失败会停止后续效果；
取消不回滚写入，命令开始后的 timeout/output/cancel 保留 `effect:unknown`。
既有命令工具时间/输出/TERM→KILL→有界观察合同不变，不广泛 kill，
逃逸后代可能仍在运行。必要 recorder 不能由可选 observer 替代。

Task82 生产这些新增类型与工厂；ToolManager、文件/命令工具和 Agent 的公开合同
保持不变。Task80 消费配置和装配；Task81 消费/提供恢复事实，
其入口/catalog 不在本模块实现。代码采用仍需各 Task 的合法 Candidate/Integration，
不从私有 workspace 或未授权 Git 对象拼接，不默认为 push/PR/merge 授权。
本仓库的 composition 测试是真实模块离线装配证据，不是 Task80 入口联合验收。

### 独立验收与后续组合证据

`test/core/native-agent-{coding,edit,search,command}.test.js` 使用临时文件、
固定 provider 和本地 fixture 子进程验证成功、冲突、超限、取消及清理。
已有 mock read → write → final demo 仍运行；mock 不会补充已有目标的写入指纹，
因此它只演示新文件复制，不能代表会处理编辑冲突的语义 Agent。
本模块没有真实模型验证，也不以其他任务的网关、注册器或存储实现完成为前提；
这些真实模块接入后的联合验收是另一项证据。
`native-agent-local-safety.test.js` 保留少量真实副作用回归（独立开关、
精确规格、活 lease、路径/恢复、记录/释放失败），
`native-agent-composition.test.js` 将安全绑定装配到既有七模块组合，并在 SQLite
重开后重建绑定。命令预算、取消、unknown 和自有进程清理由既有 command/tools
回归保护；没有真实模型、账号、敌对文件系统或 OS 沙箱验证。
