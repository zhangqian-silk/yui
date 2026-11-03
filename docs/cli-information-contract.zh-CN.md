# CLI 信息契约

Yui 将命令的效果、发现和完整证据读取分开。查询不会消费 Message，也不启动后续工作。
变更回执说明 saved/requested/accepted/unknown 等真实事实；`ok: true` 只说明这次
CLI 调用成功，不代表 Task、原生 Turn 或远端投递完成。

这是当前通信契约，不是兼容模式。已保存的 Task、Message、结果、Snapshot 和 Session
历史保持不变；读取投影没有新增快照或缓存存储。新激活事件的来源字段使用已声明的
存储 1.10 → 1.11 迁移，不补造历史来源。

## 日常读取路径

| 问题 | 入口 | 默认信息与下一步 |
| --- | --- | --- |
| 找哪个 Task？ | `task list` | 既有有界目录、过滤器、attention 与游标 |
| 当前有什么？ | `task context <task>` | 当前事实、活跃工作、开放输入、有效决策、未解决 Job、未确认处理的 Message 引用；不倾倒事件或终态 Run |
| 有哪些记录？ | `task context list <task> --store <family>` | 一种获授权的记录、摘要与带 digest 的确切引用 |
| 原文是什么？ | `task context inspect <task> --store <family> --ref <id> --digest <digest>` | 确切当前记录，含原始结果展开；长文档分页 |
| 发生了什么变化？ | `task context delta <task> --after <cursor>` | 固定上界内的不可变事件，不是可变当前状态的快照 |
| Global 收到了什么？ | `session context <role>` | 身份、Profile 读取指针、权限、当前 Turn/retry 事实与小窗口 pending 页；历史按需读取 |
| 读取 Global 输入 | `role message list <role> [--pending]`、`role message show <role> <id>` | 在自身范围内发现，再读完整原文；队列接受不删除历史 |
| 本次唤醒带来什么？ | `task wake show <task> <wake>` | 固定窗口的输入/结果、有界完整普通输入和确切原文入口；`--history` 展开诊断历史 |
| 分配了什么？ | `task run context <task>/<run>` | 冻结授权与有限 `pointers` 窗口，变化身份和活跃观察附总数；`--view refs/full` 按需扩展 |
| 实际配置是什么？ | `task role session inspect <task> <role>` | Task/Role 身份、期望绑定、冻结 Session、当前 Provider 绑定、retry 与显式 Host 观察；不复制整个 Task/Role 或 Provider 会话历史 |

Task Message、事件、WorkItem、Run、决策、里程碑、publication 和 InputRequest 列表
共用摘要/引用分页。Role 状态与 wake 历史列表也分页，并给出详情命令。
Role 发现返回 `recordedHealth` 与 `hostObservation: "not-requested"`，不是实时 Host
健康度。记录状态正常也不能排除 Host 失败或终态未确认；需沿条目的 `task role status`
读取指针检查。
`task role status <task> <role>` 默认 `--view current`：保留同一计算结果的
健康度、Host、投递/重试、清理与配置漂移观察，以 Run/WorkItem 身份和准确详情命令
替代输入、报告及历史正文。重试诊断仍通过当前 retry 详情读取；期望配置与实际配置
仍可见，未知证据不升级为成功。这是默认嵌套 JSON 契约变化；需要原有完整记录的
调用者使用 `--view full`，分页续读保留该选项。底层状态投影及 Web 数据不变。
Context 列表还暴露候选、Review、Job、Project Knowledge、工作区等获授权的记录。
`--status`、`--after`、`--work-item` 缩小发现范围；续读必须保留过滤条件。
Run 列表接受 Task 或 `task/work` 目标。

`task run show <task>/<run> --view status` 返回身份、记录状态、delivery/retry
观察、退役与结果可用性，不复制输入、启动配置或报告正文。重试观察使用与 Task Context
相同的当前摘要，并提供准确 Session retry 命令取回原始诊断与历史，不直接携带其正文。
它与默认 `--view full`
共用授权检查；完整视图仍保留全部审计证据和文档分页。
`--view result` 返回完整原始结果（包含失败与 Provider 字段）、Run 身份/状态、
退役与执行观察，不携带提交输入和启动配置。没有结果时为 `null`，不代表成功。
长报告仍需按同一视图续页；`reads.full` 提供完整审计入口，默认仍为 full。
处置前须通过 Message、result 或
完整 Run 视图读取原始结果；status 不是报告或验收。精确原文仍在当前上下文时，
用 status 补充执行事实，避免再读一份报告；不引入读取回执或模型记忆缓存。

当前 Context 的 `attention.messages` 排除明确 ack 或退役的 Message；投递成功不代表
处理完成。精确 wake 回执必须覆盖最新原文版本。用 `--view current` 续读当前视图，
默认分类列表仍保留完整历史。`collections` 计数与 `omitted` 明确表达发现不完整。抽样不能证明没有更早的待处理
或相关输入。读取相关固定 wake 与原始 Message；更广的需求/历史审计使用分类发现。

当前 Context 是工作索引，不是每轮重复的配置或需求全文。Task/Brief、Role、
Project policy、工作区、交付和决策记录即使很小，也只返回摘要与确切引用；
生命周期、执行权限、待处理数量和活跃执行／重试观察仍直接显示。
在依据需求或权限行动前，用 `context inspect` 读取相关原件；
`omitted: true` 不代表原件为空。每次读取仍重新计算当前身份并校验范围，
没有增加模型记忆缓存、推断 ACK 或陈旧状态自动复用。
当前工作区样本优先显示获授权的准确 Run 工作区投影，再显示 Task 主工作区，
然后才是其他工作区，避免历史集成目录挤掉主工作区。显式完整家族查询保留原有
排序、数量和记录；显示优先级不改变工作区权限，也不授予其他 Assignment 的访问权。

## 预算与续读

- 发现页默认 20 条，可选 1–100，紧凑 JSON 预算 32 KiB，计入成功 envelope、
  转义身份、游标和嵌套结构。摘要至多 512 UTF-8 字节，不含完整报告正文。
- 当前 Task Context 至多 64 条，记录与 attention 共 24 KiB，响应预算 32 KiB。
  单个内联值至多 2 KiB；大值及 Message/Run/WorkItem/Knowledge 正文用引用。
  入口每个集合最多抽样八条。
- Global 入口最多八条本轮/可用输入，保留效果未知项；历史缺回执单独计数，
  通过 `inbox list --view history` 显式发现，不把缺 ACK 当作未执行。
  pending 页用 `role message list <role> --current --cursor` 续读。
  托管自身读取另含 `currentOriginals`：本页中与精确当前 Turn 关联的完整记录，
  每项至多 4 KiB、合计 8 KiB。未来队列、历史和超限记录仍只提供发现信息与
  原有精确读取入口；检查调用不内联原文。读取不 claim、投递或 ACK。不重复 recent、
  Profile 正文、历史 Skill 包和累计 retry 详情。Profile 由 Manifest 精确指向。
- `inbox list --view current|history|all` 优先展示精确本轮输入，与自动投递共用原始记录。
  `claim`、`ack` 接受 1–16 个精确 ID，分别返回结果。ACK 表示语义处置，
  包括合法转交或被后续要求替代，不等于 Task 完成。
  精确终态只生成一次有界检查通知，不自动 ACK 或重放业务；纯提醒不会无限自唤醒。
  `inbox retire` 仅显式退役已过时且可证明未提交的 Global 输入，保留原始目标和理由；
  Task 输入继续使用 Leader 的 `task message retire`。
- Run 入口最多 16 个冻结引用和每类八条活跃观察，附总数。`--view refs` 配合
  `pointerPage.nextCursor` 发现更多引用；`--view full` 显式读取完整冻结包。
  若 `input.directiveOmitted` 为 true，行动前用 `--view input` 全文读取分配指令；
  默认入口的指令摘要不是指令正文。
  新冻结的 Task 消息指针在原有 summary 中提供 `Excerpt:` 原文摘录，
  最多160 UTF-8字节，保留原 revision 和 digest。摘录只辅助选择相关原文，
  不代表完整正文或授权；后续消息修改不会改变该 Run 已冻结的摘录，
  也不重新生成既有 Snapshot。
  有指针时，`reads.expand` 直接展示已有的批量原文展开语法。用相关冻结
  指针替换占位符，并非默认读全量；既有1–8项选择上限、准确Snapshot
  校验、完整原文及分页预算不变。
- `session skills [--cursor ...]` 只检查当前元信息和可读性，不读技能正文；
  配置元信息过大时使用相同文档分页。
- 不超过 16 KiB 的详情保持普通 JSON。更大详情返回 `contentPage`：确切来源、
  SHA-256 digest、JSON 字符偏移、总字节数/字符数、文本、完整性与下一游标。
  每块长度按完整编码后的 32 KiB 响应预算调整，计入身份与游标，并为小型命令包装
  预留 256 字节。不拆代理对，偏移仍以 UTF-16 单元计，已发出的旧游标仍可续读。
  不再因 4 MiB 上限而永久无法读取合法原文。
- Task 元信息/next-action/remote-delivery、Brief、WorkItem、Message、Run、
  决策/里程碑/事件、Role show/status/Session 检查、wake 详情、InputRequest、
  Run Context 与冻结展开使用有界详情读取。

普通 Task 读取验证原调用者身份，但不按 Task 或 Assignment ID 隔离数据。Yui 是单用户本地产品，
资源边界由本地文件权限和已认证服务传输承担，Task 归属不是租户边界。跨 Task 当前 Context
保留调用者自己的 Task 身份，并标记 `reference-only`。搜索、记录、artifact 和原生会话证据
不切换身份，不继承其他 Run 的指令，也不授予写入、inbox 处理、派工或外部效果权限。
明确资源限制和 Job-owned Role 限制仍有效。原生会话读取无需 Yui 网关或 Task 映射；
应使用实际合法可用的读取工具，并保持工作相关范围。

completed 结果仍可读。简单问答无需重开；同结果请求或明确未履行承诺需要持续诊断、
证据交接、必要权限协调或已授权交付时，当前 Leader 可自行重开自己的未归档结果。
诊断仍只读；重开保留历史完成证据，不解除停止、不恢复取消意图、不升级 planning
Session，也不授予外部效果权限。

使用 `--json` 读取顶层 `data`；Run Context 和展开使用 `data.context`，Run Context delta 使用 `data.contextDelta`。
长详情用同一读取命令加 `--cursor <contentPage.nextCursor>` 继续。按 offset 顺序拼接
`text`，校验相同 source 与 digest，最后一次性解析 JSON。不要分别解析块，也不要把
第一块当成完整报告。

可复制的 Node.js 消费示例见
[详情读取示例](cli-information-contract.md#copyable-detail-reading-example)：
只对指定的 `task context inspect` 原文沿游标续读，验证 source/digest/连续 offset，
直到 `complete: true` 才拼接解析一次；不是“两页读完”，也不自动重试拒绝或源变化。
示例只读取，不代替 Agent 阅读、claim 或 ACK；大输出须保存在自有临时目录并分段读取。
不要把半页 `text` 传给 `jq fromjson`，其错误可能回显整段长文。
已获取页面的元数据可用
`.data.contentPage | {offset,len:(.text|length),complete,nextCursor}` 查看，不必重取正文。
此示例按需查阅，不是每次通知的新必读内容。

同一 Task 中已经确定的 1–8 条独立原文可一次读取：
`task context inspect <task> --refs '<发现结果中的 ref 对象 JSON 数组>'`。
手写命令可改用重复的 `--context-ref <store/refId@digest>`，复用 dispatch
的精确引用写法，避免 JSON 引号。两种选择格式不能混用，也不能混入单条选择参数。
每条必须含 `store`、`refId`、`digest`；可选 `revision` 仅为发现元数据，
不另作新鲜度校验。返回 `{taskId, items}`，每项与单条 inspect 相同。
整批共用原有 32 KiB 预算；出现 `contentPage` 时保留相同顺序的引用并沿
`--cursor` 续读。任一引用过期、重复、不可用或越权都拒绝整批读取。
各原文独立绑定 digest，不建立跨记录原子快照，不自动选材，不 claim/ACK，
也不扩大权限。只需一条时继续使用原有单条入口。

列表包含 `items`、`total`、`complete`、`nextCursor`。计数、条目和游标校验处于同一
授权范围。游标是不透明位置，不是通行令牌：每页重新授权。集合或文档改变时明确报错，
重新读取，不混合版本；无需持久分页 Session。可变集合不保证并发写入期间无中断遍历。
追加事件遍历使用固定上界 Context delta。目前分类发现扫描选定的授权集合来计算指纹；
有界的是输出，不是总存储读取成本。

## 意图、来源与时序一致性

Leader/公开 Task 当前视图的 `phase` 投影生命周期、执行开关、激活来源与 Brief
新鲜度；`caller` 单独展示当前 Session 的实际权限，不代替语义授权判断。
旧 Message 标明与激活请求的记录/修订先后关系，不自动判为整体失效。

激活请求接受 `--source-message <id>` 或 `--source-text <exact-input>`，Leader
必须提供其一。develop 提交自动关联已保存的 Message。直接原生输入原文保存在既有
不可变事件中，带调用者及 Leader Session 归属，不伪装成 Provider 验证过的用户
Message，也不再次入队。相同 request ID 重试不得更换来源。交接 wake 显式引用
原始事件/Message；缺失或变更来源有诊断和原文入口，不自动批准或拒绝开发。

`task brief show` 返回 `writeGuard`；更新必须携带 `--if-current <writeGuard>`。
新语义输入、结果、阶段变化或编辑在事务中使旧写入失效，不依赖墙钟时间。
Task Job 状态、结果、取消请求和确认处置在保存事务中追加语义事件；
心跳、checkpoint 和通知回执不使 guard 反复失效。
拒绝后重读并协调目标字段。Core 只提示 `refresh-needed`，
Leader 在关键节点维护实际摘要，不新增完成门禁或自动改写原文。

Task 事件游标绑定 Home 与 Task。增量返回 `kind: event-history`、`fromCursor`、
`complete`、`stateChanged` 和固定 `throughCursor`。续页保留最初的 `--after`，
用 `--continuation` 读完再推进游标；并发新输入留在下一窗口。空增量不清空基线，
共享状态也可能在没有 Task 事件时变化。失效游标须重新读取有界当前视图。
事件序号只表达单 Task 记录顺序，不混同发生、投递、消费或跨 Task 因果关系。

Run 增量基于精确父 Snapshot，返回完整变更 `refs` 与 `removedRefs`，长文档照常
分页；截断的 `deltaRefs` 仅作启动提示。可变 Task 事实不扩大冻结 Assignment。
带精确引用的 focused wake 不再仅因时间戳重叠纳入其他 Message；`--history`
仍可发现时间窗口历史。

## 重复运行时诊断

`role message list <role> --diagnostics` 从原始 record-only Message 派生故障组，
给出首次/最近时间、不同观察的数量及恢复证据；`--diagnostic <key>` 分页发现原文。
按明确的 Host/Session、来源、故障类别/代码及效果边界区分；未分类错误不猜测合并。
同一观察重复轮询不新增记录或计数，同组跨 Turn 不重复唤醒。新故障、影响变化、
精确成功恢复或恢复后再发生可产生通知。Operator 自身诊断保留但不自动唤醒自身。
恢复不等于消息 ack、Task 完成或撤销旧副作用。

聚合不持久化，也不累计受影响 ID 数组；不增加表、消息 envelope 字段或第二状态机。
旧证据仍由普通历史读取，不启发式重新分类。每页沿用现有 Role 权限边界。

## 效果与例外

Message send/queue/steer 回执保留身份、digest、正文字节数及原有提交/投递/control
状态，不回显正文。`operator submit --json`采用同一结构：
`data.taskId`、`data.message`（有界消息回执）、`data.submission`（保存时的
phase/planning/activation/delivery/next-step事实），不再只返回`output`字符串；
普通文本输出不变。同key重试复现原提交反馈，不用Task后来的状态重新解释。
回执不是原文，也不证明Leader已经完成。
`task decision record|supersede --json`返回有界保存回执：`data.taskId`、`effect: "saved"`、
`data.decision`（身份、状态、时间戳、整记录digest及rationale字节数）。
完整保存记录的JSON不超过2048 UTF-8字节时，
`decision`同时包含该记录全部字段，`contentOmitted: false`，可直接核对
实际短值，不再附带`read`后续读取指针；更大记录设`contentOmitted: true`，
附带准确`read`入口，省略标题、rationale及取代原因
正文而不截断。digest始终对应完整原始记录，不包含回执额外字段；
需要完整读取时仍用`decision show`。人类文本不变，
JSON调用方改读`data`而非旧`output`字符串。
这证明保存状态而非语义验收；丢失响应不授权重复record。
Brief 更新返回 saved 引用。
没有新增等待、重试、确认或审批阶段。
重复读游标绝不能重放变更。

激活、完成、集成和输入控制仍是完整事务业务操作，即使内部有多步工程机制。
其特定状态回执与已有未知效果诊断保留，不压平成通用“已执行”标志。

本次覆盖日常 Agent Context、协作发现和原始证据读取，并非产品全部诊断或导出。
既有日志尾部/artifact 限制、Task 目录分页、有界错误诊断保留各自契约。
配置目录、Project/config 管理、资源清单、归档诊断、发布操作和专用集成/change-set
读取仍有自己的用途契约；不宣称它们全部受 32 KiB 限制。Web 全详情投影是独立消费者，
不会被 CLI 摘要悄悄替代。大 Project Knowledge 与 Task 证据用定向 Context 发现。

典型通知读取当前 Context 和固定 wake，再补取尚未完整返回的相关原文及其全部文档页。
聚焦 wake 的 JSON 对普通 Message 直接返回完整 `value`：每条最多 4 KiB，
合计最多 8 KiB，标记 `contentOmitted: false` 并附当前版本的精确 `ref`。
已有完整值可直接使用；长消息与结果报告保留读取入口，完成通知不替代报告。
完整内联值的 `refreshRead` 仅用于按需刷新当前来源，不是必需的后续读取；
只有原文省略时才返回 `read`。原先无条件跟随 `messages[].read` 的消费者应先检查
`contentOmitted`，完整时使用 `value`。纯文本输出只展示摘要，因此仍保留原文链接。
当前 Leader 的 `inbox show <wake>` 在 `originalContext` 返回相同聚焦原文；
已有完整值无需再次 `wake show`。权限、外层分页、claim/ACK 边界不变。
对已有 `wake-*` 的变更回执，导航字段由 `originals` 改为 `refreshOriginals`：
仅在聚焦原文缺失、不完整或需要刷新时使用，不因 claim 本身重复读取。
对 `pending-*` 的 claim（含相同请求的幂等重试）仍返回 `originals`，
因为初次查看尚未提供固定窗口原文。这是 JSON 导航字段变化，消费者需区分两类入口；
不记录读取历史，也不免除完整读取相关原文的要求。
固定窗口选择的是身份，不是可变消息正文的历史快照；后来修改由精确引用区分。
`--history` 不附带这些正文，claim 与 ACK 语义不变。
不要为了入口故意省略的详情重复读聚合。只有原文超过内联预算才增加原文分页调用；
摘要不能代替完整原文。
