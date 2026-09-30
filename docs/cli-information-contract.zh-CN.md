# CLI 信息契约

Yui 将命令的效果、发现和完整证据读取分开。查询不会消费 Message，也不启动后续工作。
变更回执说明 saved/requested/accepted/unknown 等真实事实；`ok: true` 只说明这次
CLI 调用成功，不代表 Task、原生 Turn 或远端投递完成。

这是当前通信契约，不是兼容模式。已保存的 Task、Message、结果、Snapshot 和 Session
历史保持不变；没有持久 schema 迁移，也没有新增快照或缓存存储。

## 日常读取路径

| 问题 | 入口 | 默认信息与下一步 |
| --- | --- | --- |
| 找哪个 Task？ | `task list` | 既有有界目录、过滤器、attention 与游标 |
| 当前有什么？ | `task context <task>` | 当前 Task/Brief/Role/Project/工作区事实、活跃工作与 Run、开放输入、有效决策、未解决 Job、近期 Message 引用；不倾倒事件或终态 Run |
| 有哪些记录？ | `task context list <task> --store <family>` | 一种获授权的记录、摘要与带 digest 的确切引用 |
| 原文是什么？ | `task context inspect <task> --store <family> --ref <id> --digest <digest>` | 确切当前记录，含原始结果展开；长文档分页 |
| 发生了什么变化？ | `task context delta <task> --after <cursor>` | 固定上界内的不可变事件，不是可变当前状态的快照 |
| Global 收到了什么？ | `session context <role>` | 身份、Profile、权限、当前原生 Turn/retry，以及分别有界的 pending/recent Message 页 |
| 读取 Global 输入 | `role message list <role> [--pending]`、`role message show <role> <id>` | 在自身范围内发现，再读完整原文；队列接受不删除历史 |
| 本次唤醒带来什么？ | `task wake show <task> <wake>` | 固定窗口与 Message/Run/Event 读取指针，不重复正文 |
| 分配了什么？ | `task run context <task>/<run>` | 冻结授权与一份带摘要的 `pointers` 目录；`deltaRefs` 表示变化身份；当前观察独立 |
| 实际配置是什么？ | `task role session inspect <task> <role>` | Task/Role 身份、期望绑定、冻结 Session、当前 Provider 绑定、retry 与显式 Host 观察；不复制整个 Task/Role 或 Provider 会话历史 |

Task Message、事件、WorkItem、Run、决策、里程碑、publication 和 InputRequest 列表
共用摘要/引用分页。Role 状态与 wake 历史列表也分页，并给出详情命令。
Context 列表还暴露候选、Review、Job、Project Knowledge、工作区等获授权的记录。
`--status`、`--after`、`--work-item` 缩小发现范围；续读必须保留过滤条件。
Run 列表接受 Task 或 `task/work` 目标。

当前 Context 的 `attention.messages` 统计全部获授权 Message，不仅是未投递输入。
`collections` 计数与 `omitted` 明确表达发现不完整。近期抽样不能证明没有更早的待处理
或相关输入。读取相关固定 wake 与原始 Message；更广的需求/历史审计使用分类发现。

## 预算与续读

- 发现页默认 20 条，可选 1–100，紧凑 JSON 预算 32 KiB。条目包含摘要，不含完整报告正文。
- 当前 Task Context 至多 64 条，记录与 attention 共 24 KiB，响应预算 32 KiB。
  单个内联值至多 2 KiB；大值及 Message/Run/WorkItem/Knowledge 正文用引用。
  入口每个集合最多抽样八条。
- Global 入口分别抽样八条 pending 与八条 recent；独立续读，历史不能挤掉待处理输入。
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
