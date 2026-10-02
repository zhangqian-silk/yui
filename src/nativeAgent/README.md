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

文件工具为 `read`、`write`、`edit`、`list`、`find`、`search`；显式启用后
增加 `command`。也可分别使用 `createTextTools`、`createSearchTools` 和
`createCommandTool`。工具实例没有持久化状态、后台服务或额外会话身份。
所有操作都在 `execute` 再次验证参数，因此可用简单 fixture 执行器独立验收。
调用方负责授予工具能力及审查命令内容；本模块不提供权限 UI 或授权策略。

### 文件读取、写入与精确编辑

`createTextTools({ root, maxBytes? })` 要求显式绝对目录，默认文件大小上限
64 KiB，可调小，按 `read, write, edit` 顺序返回。read 参数 `{path}`，
返回 JSON `{path,text,bytes,sha256}`；write 参数
`{path,content,expectedSha256?}`，缺省指纹只允许创建不存在的文件。
替换已有文件必须传入此前读取的 `expectedSha256`，缺失或不一致返回
`edit_conflict`，不会覆盖原文件。write/edit 成功返回 `{path,bytes,sha256}`。

edit 参数 `{path,expectedSha256,oldText,newText}`，`oldText` 必须非空且在
文件中恰好出现一次（重叠匹配也计数），否则冲突。它是字面精确替换，不是
正则或模糊补丁。所有工具拒绝额外字段；参数自身的 JSON 字节上限仍适用。
同一工具包的写调用按规范化目标路径串行；文件提交前重新核对内容及文件身份。
取消在提交前停止，已完成 rename 则如实返回成功，不回滚或伪称未发生。

拒绝绝对路径、父目录穿越、符号链接、非普通文件和多硬链接文件；父目录
必须存在。read 有界读取并验证 UTF-8；write 在同目录创建独占临时文件，
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
- `find({path,query})` 递归按文件名的大小写敏感字面子串查找，返回 `{path}`；
  不是 glob。
- `search({path,query})` 递归检索 UTF-8 文件中的单行字面子串，返回
  `{path,line,text}`；行号从 1 开始，不是正则。

`path` 为相对目录，`.` 选择 root；返回值均是 JSON
`{results,complete:true}`，顺序取决于目录迭代顺序。空匹配仅在完整扫描后返回。
默认且最大预算为 `maxEntries:10000`、`maxResults:200`、
`maxOutputBytes:65536`、`maxFileBytes:65536`、`maxTotalBytes:2097152`、
`maxDepth:32`，调用方可调小。达到预算会明确返回 `limit_exceeded`，
不冒充完整结果；可缩小目录或查询后重试。

这些工具采取严格遍历：遇到符号链接、非普通文件、多硬链接就失败；
search 遇到过大文件或非法 UTF-8 也失败，绝不静默跳过后声称没有匹配。
目录使用流式迭代；取消或失败关闭已打开的文件和目录。它不提供忽略文件
规则、大型代码索引或二进制检索。

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

### 独立验收与后续组合

`test/core/native-agent-{coding,edit,search,command}.test.js` 使用临时文件、
固定 provider 和本地 fixture 子进程验证成功、冲突、超限、取消及清理。
已有 mock read → write → final demo 仍运行；mock 不会补充已有目标的写入指纹，
因此它只演示新文件复制，不能代表会处理编辑冲突的语义 Agent。
本模块没有真实模型验证，也不以其他任务的网关、注册器或存储实现完成为前提；
这些真实模块接入后的联合验收是另一项证据。
