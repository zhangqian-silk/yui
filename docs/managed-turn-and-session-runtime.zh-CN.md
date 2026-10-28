<p align="right"><a href="./managed-turn-and-session-runtime.md">English</a> | <strong>简体中文</strong></p>

# Session、AgentRun 与通知

局部停止等待自身的持久清理义务完成，不等待整个 Home 的 `scheduler.scan`
循环排空。signal 只请求调度；完成仍以现有物理停止证明及清理事务为准。
超时保留义务并阻止替换；选择失败和新会话启动未确认分别报告，不允许重放未知效果。

`operator status` 与 Session context 区分 desired/effective 配置版本、选定写入者
状态和 Host 观测健康。旧会话失败保留为审计证据，不是新会话的当前失败。
明确 rejected 的过时输入可以显式退役；accepted、submitting、unknown 和
interrupt-owned 输入仍保留原处理路径。

`controller status --json` 的 `identity.runtime.observations` 分别呈现已认证请求、
调度待处理范围、阶段／读取成本及采样的事件循环延迟。样本使用进程单调时钟，
目标／请求标签仅保存哈希；每组最多保留 16 个近期样本、16 个活动样本及最慢完成样本。
in-flight 请求数不是排队数，路由前等待尚未测量。观测不能反推旧事故的唯一根因，
也不构成静止证明；重启 Controller 不会刷新存活 Host。

`observations.persistence` 将主线程数据库锁等待／事务体／提交成本，与持久化
worker 的往返耗时、执行和读取成本分开。worker 摘要搭载既有响应，保留 worker
实例标识；status 只读缓存观测，不另发诊断 RPC。比较往返和执行时间时须匹配
同一个请求哈希，其差值还包括启动、排队、传输和主线程延迟，不是纯排队时长。
嵌套的数据库／读取耗时已包含在 worker 执行中，不能重复相加；历史最大值可能
来自其他请求，latest／slowest 样本保留各自时间戳。

生产 Controller（含升级接管后的启动）将运行诊断保存至
`runtime/controller-diagnostics.jsonl`，另保留两个轮转文件，每个最多 1 MiB，
仅文件所有者可读写。异步写入器最多排队 32 条记录，每条最多 16 KiB，
不写业务数据库。调度及启动错误只保留分类、指纹和构建内相对源码位置，
不保留原始错误正文、参数或凭据。每 250 ms 仅检查内存指标；出现新的失败／
至少 1 秒慢操作、仍在进行的慢操作或自身事件循环延迟时，每秒最多记录一次快照。
记录包含墙钟、单调时间、PID、进程实例及版本，阶段摘要使用请求／目标哈希。
这是采样证据，不是逐请求追踪，也不直接证明路由前阻塞原因。
`observations.diagnostics` 显示写入、丢弃、待写数量和写入失败；磁盘故障不伪装为
记录成功。轮转、队列溢出、突然终止均可能丢失证据，主线程恢复前也无法输出快照。
不新增自动重启或操作重放。这些可丢弃运行日志不是 Task 状态、验收依据的替代物、
第二套恢复权威或 Home 数据格式迁移。

调度缓存按需加载记录族，并使用事务维护的 Task 读取修订号。其他 Task 或 Global
消息不会使未变化的本 Task 历史失效；更新、删除、其他进程写入仍正确失效。
组合折叠固定在一个读取快照，未提交写入不产生可复用缓存标识，最多保留最近
16 个 Task 的投影。缓存不授权派发，也不替代变更时的精确身份检查。

## 当前身份与持久处理回执

桌面与 TUI 使用相同的当前 Session 授权。只有 `CODEX_THREAD_ID` 的桌面命令
先在所选 Home 的当前及历史 Session 记录中定位角色，再校验当前绑定、撤销状态、
工作域和 Assignment。Codex 原生线程 ID 优先于继承的 transport ID，携带父会话
Yui 提示的原生子 Agent 不能借用父身份。只有未知原生线程 ID、没有 Yui 专属身份
提示的普通会话，与用户终端共享现有公共入口，无需 Manifest 即可读取公共信息和
创建 Draft；不会因此启动讨论／开发，也不会获得内部受管能力。
部分受管身份、已知历史身份、冲突提示，以及带 Yui 提示的错误 Home 保持拒绝。
仅在其他 Home 登记、当前 Home 完全未知的裸线程 ID 无法与普通线程区分，必须
保留受管会话的正确 Home／Manifest 上下文，不能清空身份字段或切换 Home 绕权。
环境变量和 Manifest 是定位提示，不是持续授权。旧 Session 仅保留限定的自身诊断读取。
完整角色提示仍可生成离线帮助模板；只有原生 ID 时需只读查询本地登记，失败则显示
有限的 unbound 模板。帮助均不是精确授权。职责和权限矩阵见
[authorization.md](authorization.md)。

`yui inbox list` 分别返回当前身份、投递事实、处理状态和阻断原因。自动接受的
Global 消息、已投递的 Leader 窗口及当前 Assignment 续接消息仍须显式 claim，
核对原文和既有副作用，完成处理后再 `ack --reason`。这不会重新投递输入；
pending/unknown 不能借 claim 接管。合法继任者可以核对并结清已接受的 Global
输入或 Leader 窗口，保留原投递目标。说明中可引用结果和外部操作回执。
native terminal 不能替代用户输入处理，也不能单独满足 Task 完成条件。

回执继续保存在现有 Message/TaskWake 中。自动通知和主动领取都以既有
`message.updated` 事件 ID 绑定可变 Draft 修订，同时间戳的修改也不会沿用旧
ack。已领取消息的原文和固定窗口引用不能被悄悄替换，重复通知不会重新提交
已投递修订。处理崩溃或副作用完成后 ack 失败时，先读回 claim 和外部回执，
只完成未完成工作，再重试相同确认。上下文压缩、Session 续接和升级不清空回执。
实现复用 storage 1.7 的现有字段，不新增消息系统或 schema 迁移，也不承诺
任意外部系统的天然 exactly-once。

Global Session 停止／替换与 Task Session 共用精确的原生执行静止确认边界。
Host 消失或 Session 已入历史不代表已接受输入结束：须先检查并停止保留的
Provider binding，再结算执行占用。Global 停止证据保存为仅记录的 system Message，
不触发新的原生输入。待投递通知不能重启已明确停止的 Session；普通 Host 脱离仍
保留 active Session，可正常重连。部分切换失败后，仍须先结算旧输入再选择新会话。

新建 global Operator 对话会按 Yui 当前配置时区请求原生标题
`Yui · Operator · MMdd`。只有 Provider 返回新对话的确切身份后才执行该请求；
恢复与重连路径不会重放。若 Provider 不支持创建后改名，已创建的 Session 仍保持
可用，并留下诊断，而不会把元数据失败冒充为 Session 创建失败。

## 权威

Task、WorkItem、Message、Decision、Artifact 和 Project Knowledge 保存持久工作。
Session 标识一段原生对话及其捕获的权限。AgentRun 记录一次明确请求的执行和原始
结果。AgentHost 是一次性 attachment，不是 Task 真相的 owner。

一个当前、未撤销的 Leader Session 可以在没有活动 Run 的情况下读取 Context 并保存
范围受限的 Task 事实，包括一个正式的 InputRequest。它确切的 Session 是该请求的
来源；有实际 Run 时会一并包含。这个问题在该执行结束后仍然存在，直到被回答或取消
才关闭。Worker 与 Reviewer 命令保留精确的 Assignment 检查。Session 替换、Role
绑定、Task 范围和资源 grant 各在其边界检查。一个活动 Run 指针并不证明同一 Session
中一条无关命令来自那个 Run。

原生对话、Goal 延续和普通 Leader 通知不会自动创建 Run。显式派发加载一个确切的
Run Context Pack。

## Context

```sh
yui task context <task> --json
yui task context list <task> --store <store> [--cursor <cursor>]
yui task context delta <task> --after <coreCursor>
yui task context inspect <task> --store <store> --ref <id>
yui task run context <task/run> --json
yui task run context expand <task/run> <ref-id> --store <store> --mode full --json
```

Task Context 是一个有界的、获授权的工作集，带有当前 core 游标。delta 在一个固定
上界内分页不可变事件；inspect 展开一条当前记录，并可要求确切摘要。运行时观察声明
自己的覆盖范围，不会成为另一份持久快照。

入口 Context 抽样当前事实，不是完整历史目录。先列出一种获授权的记录，再展开相关原文。
长详情使用 `contentPage` 与 `--cursor`；必须拼接全部确切文本分块后再解析 JSON。
Global `session context` 同样把有界 pending/recent 发现与 `role message show` 原文分开。
预算、范围、续读及完整原文协议见 [CLI 信息契约](cli-information-contract.zh-CN.md)。

Run Context 冻结 Assignment、来源引用、生效配置和工作区边界。一次 Role 编辑不改写
既有 Assignment。读取任一 Context 都不确认输入或创建执行权限。每一条受管输入都指向
确切的 Session Manifest 和 CLI 入口。Run Pack 是一个参考目录：动手前先读相关的需求
和消息正文，而不是把加载成功当成交付物。规划 Pack 不暴露 Project 写范围或 Task 完成
权限。

Manifest 指针是恢复定位入口，不是已读凭据。每轮开始通过本 Session 的 CLI/Home 执行
`yui session skills --json`，轻量检查当前路径、内部 `VERSION` 和文件可读性，不读取
正文或遍历/冻结资源。内置入口是当前安装目录的 `skills/<id>`，自定义入口是
`YUI_HOME/skills/<id>`，不包含 Session/内容摘要；安装位置变化后由检查重新解析当前入口。
Global Manifest 的 `skillCheckCommand` 使用自包含的 `session context <role>`，
同时返回 Skill 元数据，因此切换到 Desktop 后不依赖启动 shell 的环境；
旧 Global Manifest 的 `loadCommand` 也能执行相同检查。
首次进入、版本变化、恢复，以及压缩后全文缺失或可用性不确定时，读取当前 Runtime、
Role/custom Skills 全文及必要引用、Manifest 的 profile。只有版本未变且全文仍在当前
上下文时才复用。系统不保存“已经读过”状态，也不声称检查了模型上下文。
历史冻结包仅作审计：缺失或损坏不阻止合法 Session 恢复与消息投递；当前文件缺失则
报告具体路径和修复动作。身份、作用域、writer fence 与实际 CLI/Home 不兼容仍会拒绝。
动态事实仍须刷新：
Leader 通知使用 `currentCommand`，显式 AgentRun 使用真实 Run ID 的
`loadCommand`/`expandCommand`，不可直接执行占位模板。

正常和重试通知共用有界呈现：流程事实、标明作者来源的可选摘要与原文入口。Agent 可在
Message/报告首行写 `Yui-Summary: <单行摘要>`（摘要最多 512 UTF-8 字节），保留失败、
未验证、待决定等限定。摘要存在原文本身，不新增数据格式、摘要存储、已读状态或模型调用；
缺失或超长时使用事实模板，不截断关键限定。摘要不是授权、验收或审查通过结论。

`task wake show <task> <wake>` 默认展示消息、结果与明确引用（包括窗口外原文），
不再枚举无关诊断事件和仅启动的 Run；`--history` 展开完整固定窗口历史。两个视图保留
去重、固定窗口、确切原文命令及 `contentPage` 续读。决策所依赖的原文仍须全文读取。

新 Run（包括规划、Review 和消息续接）必须在派发前绑定明确冻结的 Snapshot。
Context 读取校验完整身份与内容 digest，然后直接读取已保存的值，不重新收集当前
Task 记录。聚合执行从该 Snapshot 读取已选择的 Producer 结果；可写 Project 来自
Run 捕获的生效授权。当前活动状态仍是独立观察，不属于冻结合同。
展开引用必须同时指定 `store` 与 `refId`，即使 id 唯一也不能省略 store。

新的 Task 执行需要首个 Snapshot。保留的 Run 缺失执行证据时，仍可供
Leader／Operator 查看、结算失败或显式废弃，无关工作继续推进。提交执行和读取
确切冻结上下文在证据缺失、漂移时局部失败。显式普通重试根据当前授权事实创建
新的 Run 和 Snapshot，不补造旧快照；Review／结果汇总的确切复用仍需冻结证据。
后续原生输入或 steer 可以没有独立 Snapshot，因为它们不建立新的 Assignment。
存储采用 1.0 基线；可选执行证据缺失保持为 Run 局部状态，不扩大为
整个 Home 的阻塞。

运行异常按所属对象限制影响，不等同于整个 Controller 必须停摆。可选的资源回收
和 continuation 元数据检查失败会报告诊断，不阻断正常调度；Provider 重试准入
按 Session 隔离，continuation 观察按 Task 隔离。Job 和全局输入错误包含
Task／Job 或 Role 身份，并保留原始原因。已提交的观察仍然有效，失败的观察不代表
输入已确认、进程已停止，也不授权再次发送或删除。对受影响对象使用既有的查看、
停止／取消、废弃、确认和显式重试入口。存储结构损坏、权限失败及未知外部效果，
仍在各自边界明确诊断，不用统一兜底值或伪造成功绕过。

当前 Task 读取也会把无定向目标的 user/Operator 消息暴露给该 Task 当前的 Worker 和
Reviewer Session，包括在它们 Run 快照冻结之后新增的需求。用 `task message list/show`
或 Task Context inspect 来读取那些原始记录。这不改写冻结的 Assignment，也不授予投递
权限。定向消息、其他 Role 的结果以及其他 Task 仍在调用者范围之外，除非其 Assignment
授权访问它们。

## 派发与通知

一次显式派发在原生提交之前持久化执行意图。普通 Leader 唤醒则认领一个固定的
TaskWake/mailbox 批次，并通过同一个 Host/Endpoint 提交一条通知。已确认的接受只消费
那个批次；之后的输入仍待处理。通知不需要最终执行报告，也不会强行 steer 进入一段忙碌
的原生对话。

Leader 本地编辑保留持久事件，但不创建自唤醒。当 Leader 忙碌或不可用时，其他来源的
输入仍然持久。Operator 通知同样携带 TaskEvent/InputRequest 读取指针，而不是重复的
Task 叙述。人工输入、显式执行进入和激活失败通过既有唤醒机制及时投递。Worker 结果
保留其聚合窗口。忙碌的原生输入仍保留待处理的消息。

### Operator 积压与周期恢复

Task 完成／取消／退役、Publication 记录／采用及 InputRequest 与持久事件在同一事务中
进入 Operator 邮箱；Run 失败继续遵守既有重试和监督路由。邮箱自身就是增量恢复源：
通知信号遗漏或 Controller 重启后，既有周期协调读取尚未处理的引用，不依赖 Leader
主动报告，也不遍历历史 Task。已结算且无变化的邮箱不会生成消息或调用模型。

最多保留一条未发送的工程通知，后续事实在原邮箱中合并，直到该通知已接受或明确未投递。
每次认领最多 64 个来源信号，读取精确记录并保留未认领后缀。Global 投递每个 Role 每轮
最多读取 64 条待处理消息；已证明失效的原始消息保留未投递证据，后续页由下一轮处理。
interrupt-then 的预留输入不会因超出普通页而被跳过，用户输入顺序和未知效果围栏保持不变。
SQL 聚合仍检查匹配的存储行；这些上界约束物化记录和每轮投递工作，不限制持久邮箱或数据库大小。

完整周期协调可要求原 Host 重发它已经观察到的精确终态，严格绑定 Session、
authority、attempt 和 native Turn。Desktop direct 回合还要求该 Host 保留同一 writer 围栏下
精确匹配的开始和结束，同时核对 `direct:<nativeTurnId>` 与 native Turn；只保留最近一次
观察，不把 direct 输入改为 client-owned。通过原 Inbox 和规范观察器处理完整结果；不提交新输入、
另开原生客户端查询、重启 Host，也不凭时间或 idle 推定静止。正常终态在释放 Host 占用后
再次发出队列信号。未知接受只有精确证据才能结算，显式停止／替换及外部 writer 仍是硬边界。

`yui session context <role> --json` 的 `backlog` 提供有界待投递数量、最老时间、
目标与尝试身份、阻塞原因和恢复指引；实时年龄位于分页摘要外的 `backlogObservation`，
不会令分页游标因时间流逝失效。`in-flight-or-unobserved-terminal` 不把长期 accepted
误报为卡死。Host 不可达、不支持重观察或缺少保留终态时，每个精确尝试只留下一个 record-only
runtime-attention Message，可通过既有 message list/show 查看，不自动唤醒恢复 Agent。
如果 Provider 从未报告终态，或原 Host 已失去证据，则不能自动证明完成；须恢复兼容观察路径，
或在取得原生静止证据后显式停止／替换。不新增私有定时器、迁移或 ack 状态，不猜补任意旧历史、
收养旧 Host，也不授权生产升级／重启。

Controller 重启保留存活 Host，不替换它们已加载的代码。支持当前协议的原 Host 在 Controller
停机期间仍把原始观察写入不可变 Inbox，重启后由 Controller 按当前 Session 围栏应用。
Inbox 写入故障时，Host 保留尚未持久化的原始 start 与完整终态，不能被后续直接 Turn
覆盖；修复后按原始观察顺序补收。Task 与 Global 完整协调也覆盖没有后续输入的最后
一个未结算 Turn。补收不重执行；落盘前进程丢失仍是明确的恢复缺口。
冻结 Manifest 的旧 CLI/storage 不匹配是 Context 读取失败，不足以证明 Host 发布失败：
发布器使用 Inbox/RPC，不执行该 CLI。Endpoint 的 checkout generation 也不是完整 Host
构建身份。runtime-attention 区分控制通道不可达、控制被拒绝（包括实现不支持协调）和
精确终态未保留，并附已报告的 Endpoint/eventDelivery 观察；缺少诊断表示未报告，而非健康。
status 的 `controlCapabilities` 决定可用的 v1 增量命令，未声明 `reconcile-turn` 时
直接返回 unsupported，不发送已知无效请求，仍可消费原始 Inbox。
`hostImplementation` 在 Host 加载时捕获，不借磁盘当前安装或 Endpoint generation
冒充运行代码。兼容构建差异不阻止安全释放后的同一原生 Session 恢复，
不改变模型、账号、原生权限或工作域。
再次重启 Controller 或猜测 adoption 不能修复不支持的存活代码；须检查原证据，并为必要的
生命周期恢复另行取得明确授权。

| 证据 | 处置 |
| --- | --- |
| 忙碌且已证明未接受 | 保留输入；新的传输尝试可以使用同一 Session |
| 原生接受 | 绝不重发；若这是一次执行，等待确切终态 |
| 仅有传输写入 | 保留传输证据；不宣称原生已接受 |
| 显式拒绝 | 保留原始原因并结算相应的准入 |
| 未知接受/效果 | 保留该尝试和冲突资源围栏；不重放也不切换 Session |

崩溃后缺少回执不证明未接受。结构化的 `SESSION_BUSY` 是证据；含有 “busy” 字样的文本
不是重试合同。

## 延续既有工作

```sh
yui task message send <task> "Continue with the clarified requirement" \
  --to <role> --work-item <work-item>
yui task message handoff <task/message> --to <successor-role>
```

Review 澄清使用 `--review-round` 代替 `--work-item`。Message 保留收件人、工作关联和
owner Run。当 Role 忙碌时，保存会返回而不打断它。一旦它可用，一个有界有序批次可以
创建一个 continuation Run，与那些消息原子地关联。既有 Assignment、生效权限、工作区
和未完成文件都保留；快照再加上获授权的消息和前一次原始结果。重复的终态不能把消息
指派两次。

所有权变更、不兼容的 Session、终态工作和过时的 Review 候选都保留可见的未投递原因。
显式 handoff 只针对同一工作已派发的后继。复制的 Producer/综合血缘不会被一条消息
静默改写。

被拒绝的 Leader 通知保留原始输入和失败原因。确定性的启动错误不再自动重试，
只有明确的运行时资源争用可以延后再试。新消息和 Controller 重启不会重放被拒绝
的认领。修正原因后，显式重试对应的 wake：

```sh
yui task wake show <task> <wake>
yui task wake retry <task> <wake> --reason "<已修正的原因>"
```

retry 把被拒绝批次及后续排队输入交回现有 mailbox，不把旧 wake 改成已接受，
也不替换 Session；当前运行权限和就绪检查仍然生效。模型／effort 校验拒绝会显示原生
报告的模型选项，并提供查询完整当前目录的命令。

没有 Run 的启动失败与原生 Provider 拒绝都保留规范的 `runtime.agent-error` 事实。
通知投递引用该原始错误，而不复制第二份原因。`task event show` 的人类和 JSON 输出
都提供有作用域的能力查询入口，`wake show` 也链接同一事实。无法接收的 Leader 将
错误通过既有 Operator 通道通知一次；Worker／Reviewer 仍通知 Leader。不启动新的
恢复 Agent，也不为了记录错误制造 Run 或 Session。

错误上下文记录原生元数据查询选项和请求的模型／effort。未记录的配置保持不可用，
不会从当前 Role 猜测过去的选择，也不会把不透明审计字节当作当前配置读取。
查看模型选项不校验 Task 权限、Review 状态、
工作区条目或当前 Session 引导协议。三类错误入口保留各自的原生身份检查与分类，
错误创建、去重统一一个写入入口，上级通知统一使用事件路由边界。

未知的 Leader 通知保留其唤醒和输入窗口：

```sh
yui task wake show <task> <wake>
yui task wake resolve <task> <wake> --reason <quiescence-evidence>
```

resolve 在原生效果围栏清除后释放该认领。它既不重放通知，也不编造接受或完成。独立的
Role 工作和合法的本地事实不是一把 Task 范围的恢复锁。

wake 状态记录通知投递，不记录 Message 的实施结果。普通 Leader 通知的 `consumed`
表示原生接受；原生 Turn 完成与 Task 交付应分别依据运行证据和持久结果判断。
被拒绝的 wake 保持 `dispatched` 并保留 claim，直到显式重试或 Session 替换；
已显式释放的历史 wake 可以保持 `dispatched` 而不占用 claim。
接受状态未知的通知不能用 `wake retry` 重放。Session 替换把待投递输入
保留给新 wake 与当前 Context，不会追溯把旧 wake 标成已接受；旧回执也不能结算
新批次。Session 清理期间，新输入保持排队。检查时应结合 wake、
`notification.delivery` 事件、当前 mailbox 与 Session，不应要求每个历史 wake
都对应一条最终回复。

现行 wake 只表示通知，Run 完成不能消费 wake；首次通知窗口从 Task 创建时间开始。
退役的 Run-linked wake 通过 Task 事件保留原 ID 和完整原文，不作为第二种活动 wake 格式。

## 输入时机：queue、steer 与 interrupt

提交意图（`record / discuss / develop`）决定需求如何路由。输入时机决定一条已经
获授权的输入何时到达 Role；它不激活 Task、不扩大 Assignment，也不提升 planning
权限。仅保存输入使用 `message send --intent record`，`--wake-policy` 已移除。
未绑定请求身份的 Draft Message 仍可编辑，保留原提交意图。编辑 `record` 或
`develop` 不会启动规划、创建或重试激活；编辑 `discuss` 复用讨论提交的激活／规划
路由，因此已有 pending 或 failed 激活时，编辑后的讨论仍等待激活处理。

带 submission key、queue/steer 请求或 interrupt-then 交接的 Message 正文不可变；
需要改内容时，应使用新的 request ID 提交新消息。这保留原请求的判重依据和回执，
不新增第二套输入存储。更新为相同正文是无操作：不写事件、不改队列、不通知
Controller。现行 user/operator 消息必须存有意图；改变意图同样需要显式提交新输入。
[经认证的 Web 控制](architecture/capabilities-and-resources.zh-CN.md#cli-与-web)
与 CLI 使用同样的三种操作。

| 动作 | 效果 | 不证明什么 |
| --- | --- | --- |
| `queue` | 保存 Message，等待收件人的下一个合法机会，按 request ID 幂等 | 读取 Context 或接受投递不等于实施 |
| `steer` | 保存 Message，并尝试原生 steer 精确的当前 Turn | 不受支持、目标陈旧或未确认的 steer 不等于排队延续 |
| `interrupt` | 记录控制请求，请 Provider 取消精确的当前 Turn | 停止请求不等于终态，也不证明后台资源已停止 |

选择实时目标前先检查 Session：

```sh
yui task role session inspect <task> <role>
yui task message queue <task> "<continuation>" --request-id <id>
yui task message steer <task> "<correction>" --request-id <id> --to leader --expected-target <turn>
yui task role interrupt <task> <role> --expected-target <turn> --request-id <id> [--then-message <task/message>]
```

普通 Leader `queue` 输入省略 `--to`。显式 `--to <role>`（包括 `leader`）指向既有
Assignment，必须带 `--work-item` 或 `--review-round`；Message 不能创建 Assignment。
`steer` 仍需要显式 Role 与精确实时目标。同一个 request ID 若换正文或目标会产生冲突。
`steer` 与 `interrupt` 不会静默改目标、
替换 Session、杀进程或回退到另一动作。没有活动受管 Turn 时返回 `NO_ACTIVE_TURN`；
陈旧目标与不受支持的控制也保持为显式结果。

裸 interrupt 不创建 Message。可选的 `--then-message` 引用一条已保存且符合交接条件
的输入，只在精确终态之后、原 Session/writer 边界内保留下一次机会。它不是第四种动作，
也不能用来重放已接受、待确认或未知的 steer。明确证明未投递时，若用户意图允许，
可以显式选择新的控制；不确定性不允许重放。

Global Role 使用同样的三种动作和自己的 owner、Session，不虚构 Task 或 Run。
本地用户 Web Surface 通过共享 Global Role 处理器暴露这些动作。公开 CLI 提供
`yui role message queue|steer <role> <text>` 和 `yui role interrupt <role>`。
queue/steer 要求 `--request-id`，steer/interrupt 要求 `--expected-target`。
这些命令保留调用者现有 Session 权限，不虚构 Task/Run 或借用浏览器用户权限。
配置仍使用 `config role`，生命周期使用 `session`。新的受控 Global Session 使用 Host console。活动的非受管 Session
不会被静默采用，需要先执行显式的 Session 生命周期操作。

当前受控 Codex Operator 与 Task Leader 也可从 Web Terminal 打开原生 TUI 视图。
经过认证的本地 relay 连接 Host 现有 App Server 连接中的精确 Thread；完整文本、
steer 和 interrupt 复用 Host 准入与回执，原生问题/审批保留原 request/Thread/Turn
身份。配置覆盖和新建/派生 Thread 被拒绝。Web 复用已有终端 writer lease，
其他窗口在 writer 脱离前保持只读。关闭视图不会停止 Host 或 Provider。会话与
原生历史仍来自同一 Provider 事实，不建立另一份 Task 消息存储。

## 精确结果

原生终态只结算相匹配的那次执行。已知的原生 Turn ID 必须匹配；串行流可以使用已证明的
本地尝试关联。message UUID 不是原生 Turn ID。同一 Session 中无关的原生对话不能完成
待处理的 Yui 请求。

终态事务保存一个 AgentRunResult 和一条引用 Message。
`resultRef: { type: "agent-run-result", runId: "run-12" }` 展开原始报告而不是复制它。
Candidate 和 ReviewRound 保留来源；Core 不从散文中推导语义接受。

取消请求不证明物理静止。确切的终态证据保留部分输出，并只结算原始执行。Host 退出
并不意味着共享 Provider 或后代进程已停止。

## Draft 规划与激活

`EffectiveLaunchSnapshot.executionAuthority` 捕获 `planning | delivery`。它不从 Task
当前生命周期重新计算。planning 允许本地规划事实，不允许交付派发、候选采用、集成或
交付工作区 Job。

初始 Draft 规划派发创建一个 planning Run，并只绑定其初始消息批次。接受或一个确切终态
消费该批次；失败不会反复重建同一个规划执行。既有 planning Session 中后续的普通消息
仍是通知。Operator 提交和直接的 Task 消息都能到达那个 Session。Draft 计划/WorkItem
编辑保留执行历史；外部编辑通知 Leader，而它自己的规划编辑不创建自唤醒。

新的 Draft Role 使用位于 `<YUI_HOME>/runtime/task-runtimes/planning` 下、专属于该 Task 的规划
目录，与持久控制数据和交付树分开。一个 planning Run 可以用 `task activation request`
持久化意图并立即返回一个 `afterPlanningRun` 引用。它的终态把该请求释放给 Controller
准入；被取消的意图不会复活。Leader 也可以在普通讨论中请求激活而无需 AgentRun：一旦
原生输入结算，Controller 就采用其持久意图。不需要合成 Run 或额外的用户“continue”。

对于已绑定的 Git Project，`--environment empty` 表示没有额外环境：这些 Project 仍会
获得受管 worktree。`scratch` 选择一个 Task 拥有的目录。`local` 需要一个已登记的 local
Resource 及其 grant；Project ID 不是 local Resource ID。

`task activate` 是对已有请求的前台采用，不是创建激活意图的另一条路径。
没有请求的 Draft 会在资源准备前被拒绝；命令不代填环境计划或 request ID。

资源准备先于对 Task 状态和工作区所有权的原子采用。一次失败的采用记录一个失败请求，
并用持久事实通知 Leader；在失败未变时它不反复准备资源。Leader 选择显式重试或修正后的
请求。成功激活同样为 Leader 留下一条交付通知。激活绝不把活动 Session 变更为交付权限。
一次改变的启动必须通过既有的 Session 替换/环境边界。planning 权限是一项 CLI 保证，
不是针对恶意代码的文件系统沙箱。

## 检查与生命周期

```sh
yui task run list <task>
yui task run show <task/run> --json
yui task message show <task/message>
yui task role session inspect <task> <role>
yui task execution start <task>
yui task execution stop <task> --force --reason <reason>
```

`task run retire` 的进度围栏只接受 `--expected-progress-at`，移除旧的
`--progress-at` 别名。退役活动 Run 仍要求精确进度、Agent/Adapter 及已绑定的
原生 Session 身份，不放宽静止性检查或退役权限。

Task execution start/stop 控制 Task 准入，而不是 Task 验收。stop 先围住新的 Yui 工作，
然后中断每一条被拥有的确切原生输入，并在移除 attachment 之前确认其终态。这也覆盖没有
Run 的普通 Leader 通知。未知的原生状态阻塞清理；仅停止一个代理绝不证明一个共享 Turn
已结束。start 保留持久进展，并在旧占用结算后接纳新输入。Draft 规划可以暂停/恢复，
失败的 planning Run 以 planning 权限重试。获授权的 user/Operator 可以通过
`task role session stop` 停止一个空闲的 Draft Session；它不必仅为恢复就激活 Task。
`task role session new <task> <role> --reason <reason>` 持久化一个显式替换请求。复用是
一种偏好，而不是要求证明旧对话不可恢复。该请求在 AgentRun 活动、Session 已结束或
上一次清理待处理时都是合法的。Leader 也可以请求替换自己并结束当前轮次。

对于 planning Run 已结束的 Draft Leader，替换初始化通知在确认清理后允许所选的新
Session 登记。它不会新增业务 Run、激活 Task 或接纳 delivery 工作区；后继仍只有
planning 权限，先读取当前 Task 上下文和保留的信箱原文，再处理输入。普通 Draft 通知
和无启动范围的原生 hook 不能借用此准入。启动被拒绝时保留通知，修正原因后可显式
`task wake retry`，或再次合法替换 Session；接受状态未知的输入始终不能据此重放。

`task role session stop` 也可以在不先更改 Run 状态的情况下停止一个运行中的 Role。它
保留原生对话以备复用。待处理的 Message 仍是意图，可以在停止后启动一次 continuation；
当整个 Task 都必须保持暂停时，使用 Task execution stop。对于自我替换，使用异步的
`session new` 请求，而不是同步的自我停止。

既有的运行时清理路径停止确切的原生执行，把该 Role 剩余的工程尝试关闭为 cancelled，
保留 Session/Run 历史和工作区，并选择一段新对话。其他 Role 和 Task 验收保持不变。
Leader 收到一条新的上下文通知；它决定重试哪些 Worker/Reviewer 尝试。待处理的输入
引用在替换后仍然存在，包括比新通知时间窗更早的记录。

一个缺席的 Host 不移除恢复入口。Codex 可以通过一个一次性的原生控制连接被检查和中断，
而不启动模型。专用 Claude 进程托管独立于 Host 持久化。真实的未确认执行仍阻止冲突资源
复用；清理失败是一条路由给 supervisor 的持久诊断，而不是编造接受或删除 Task 的理由。
仅有一个预分配的 ID 不证明一段对话存在。Codex 在一次失败的原生 Turn 之后可能保留
`systemError`。仅凭那个标签既不证明活动也不授权清理：Yui 在替换 Session 之前会检查
最新原生 Turn 的终态元数据并排空后台执行。未知或仍在运行的原生工作仍受保护。

已释放的 Leader 保留对自己 Task 和上下文的范围受限诊断读取，但不能修改它或读取另一个
Task。Operator 诊断和 Controller 重启不先要求一个健康的 Controller；当 RPC 不可用时，
显式重启只能用 PID/start 身份停止同一 Home 的那个确切进程。Operator 的存储诊断/升级
也能到达专用的迁移入口，而不先要求 Home 已经处于目标存储版本。完成、取消和归档具有
彼此不同的权限和资源边界。存储变更使用唯一的
[升级合同](sqlite-control-plane-design.zh-CN.md)。
