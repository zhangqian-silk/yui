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
| 本次唤醒带来什么？ | `task wake show <task> <wake>` | 固定窗口的输入/结果、标明来源的可选摘要和确切原文入口；`--history` 展开诊断历史 |
| 分配了什么？ | `task run context <task>/<run>` | 冻结授权与有限 `pointers` 窗口，变化身份和活跃观察附总数；`--view refs/full` 按需扩展 |
| 实际配置是什么？ | `task role session inspect <task> <role>` | Task/Role 身份、期望绑定、冻结 Session、当前 Provider 绑定、retry 与显式 Host 观察；不复制整个 Task/Role 或 Provider 会话历史 |

Task Message、事件、WorkItem、Run、决策、里程碑、publication 和 InputRequest 列表
共用摘要/引用分页。Role 状态与 wake 历史列表也分页，并给出详情命令。
Role 发现返回 `recordedHealth` 与 `hostObservation: "not-requested"`，不是实时 Host
健康度。记录状态正常也不能排除 Host 失败或终态未确认；需沿条目的 `task role status`
读取指针检查。
Context 列表还暴露候选、Review、Job、Project Knowledge、工作区等获授权的记录。
`--status`、`--after`、`--work-item` 缩小发现范围；续读必须保留过滤条件。
Run 列表接受 Task 或 `task/work` 目标。

当前 Context 的 `attention.messages` 排除明确 ack 或退役的 Message；投递成功不代表
处理完成。精确 wake 回执必须覆盖最新原文版本。用 `--view current` 续读当前视图，
默认分类列表仍保留完整历史。`collections` 计数与 `omitted` 明确表达发现不完整。抽样不能证明没有更早的待处理
或相关输入。读取相关固定 wake 与原始 Message；更广的需求/历史审计使用分类发现。

## 预算与续读

- 发现页默认 20 条，可选 1–100，紧凑 JSON 预算 32 KiB，计入成功 envelope、
  转义身份、游标和嵌套结构。摘要至多 512 UTF-8 字节，不含完整报告正文。
- 当前 Task Context 至多 64 条，记录与 attention 共 24 KiB，响应预算 32 KiB。
  单个内联值至多 2 KiB；大值及 Message/Run/WorkItem/Knowledge 正文用引用。
  入口每个集合最多抽样八条。
- Global 入口最多八条本轮/可用输入，保留效果未知项；历史缺回执单独计数，
  通过 `inbox list --view history` 显式发现，不把缺 ACK 当作未执行。
  pending 页用 `role message list <role> --current --cursor` 续读；不重复 recent、
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
- `session skills [--cursor ...]` 只检查当前元信息和可读性，不读技能正文；
  配置元信息过大时使用相同文档分页。
- 不超过 16 KiB 的详情保持普通 JSON。更大详情返回 `contentPage`：确切来源、
  SHA-256 digest、JSON 字符偏移、总字节数/字符数、文本、完整性与下一游标。
  每块最多 4096 个 UTF-16 单元，不拆代理对，转义后的输出低于 32 KiB。
  不再因 4 MiB 上限而永久无法读取合法原文。
- Task 元信息/next-action/remote-delivery、Brief、WorkItem、Message、Run、
  决策/里程碑/事件、Role show/status/Session 检查、wake 详情、InputRequest、
  Run Context 与冻结展开使用有界详情读取。

使用 `--json` 读取顶层 `data`；Run Context 和展开使用 `data.context`，Run Context delta 使用 `data.contextDelta`。
长详情用同一读取命令加 `--cursor <contentPage.nextCursor>` 继续。按 offset 顺序拼接
`text`，校验相同 source 与 digest，最后一次性解析 JSON。不要分别解析块，也不要把
第一块当成完整报告。

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
状态，不回显正文。Brief 更新返回 saved 引用。没有新增等待、重试、确认或审批阶段。
重复读游标绝不能重放变更。

激活、完成、集成和输入控制仍是完整事务业务操作，即使内部有多步工程机制。
其特定状态回执与已有未知效果诊断保留，不压平成通用“已执行”标志。

本次覆盖日常 Agent Context、协作发现和原始证据读取，并非产品全部诊断或导出。
既有日志尾部/artifact 限制、Task 目录分页、有界错误诊断保留各自契约。
配置目录、Project/config 管理、资源清单、归档诊断、发布操作和专用集成/change-set
读取仍有自己的用途契约；不宣称它们全部受 32 KiB 限制。Web 全详情投影是独立消费者，
不会被 CLI 摘要悄悄替代。大 Project Knowledge 与 Task 证据用定向 Context 发现。

典型通知读取一次当前 Context、一次固定 wake，再逐条读取相关原文（或其全部文档页）。
不要为了入口故意省略的详情重复读聚合。只有原文超过内联预算才增加原文分页调用；
摘要不能代替完整原文。
