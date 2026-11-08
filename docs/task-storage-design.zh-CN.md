# 数据模型、存储归属与任务分级清理

Task：task-169。需求原文：`task-169/message-1`。源码基线：
`5caf5d2c3a4f8e2d3361f088b55da5bf8544b5f1`（软件 2.28.0，Storage 1.32）。

本文面向后续实施者和审阅者。它区分源码已证实的事实、采用的设计和仍未交付的工作；
不是执行真实 Home 清理的授权。所有迁移与销毁验证只允许使用隔离 Home。

## 结论与实施状态

不按“Agent 喜欢文件”统一迁移存储。保留 SQLite 的控制状态、查询和事务边界；
将不需要 SQL 内容查询的冻结正文移出反复复制的聚合；长篇资料保留版本化 Artifact。
Agent 的正常入口仍是有界 CLI Context，而不是扫描 Home 文件树。

已实施并通过本地完整回归的第一部分：

- Storage 1.33：冻结 Context 元数据留在 SQLite，resource 的精确 JSON 值进入
  `task-data/<task-id>/context-values/<sha256>.json`，任务内去重，不跨任务共享。
- 既有 scope/sequence 索引用于选取候选/最近快照，不再为了选择一个快照而加载全部历史正文。
- 当前 Project policy 与本机注册/审批状态分开投影；当前 Knowledge 不重复携带 history。
  显式 Project 读取及旧冻结快照仍保留完整记录。
- 集中迁移、源数据库备份、失败回滚、内容缺失/损坏及符号链接拒绝、任务间隔离已有回归。

第二部分已新增显式的 `task process-cleanup`，当前范围仅为已归档任务的 telemetry
明细；保留汇总、事件、文件和所有历史。预览摘要绑定 Home、任务内容及明细，
执行在写事务内复查并同事务记录回执；重复 request ID 返回原回执，不能改换确认范围。
公共入口还验证当前身份及物理运行已释放，未决业务/运行/队列阻挡操作。
归档后迟到的在线 telemetry 写入被忽略，但归档本身不会删除已经保存的明细。

**尚未交付，不能据本文宣称任务完成：**完整三档清理范围、删除防重用回执与写入栅栏、
跨任务/历史文件依赖预检、可恢复物理删除、公开能力接口及端到端清理验收。
下述清理章节除明确标注的 telemetry 明细入口外，仍是目标契约。

## 1. 实际消费与格式选择

### 1.1 已确认的消费路径

`src/storage/sqliteStore.ts` 是同步领域记录的写入/读取实现；
`storeRpc.ts`、`persistenceWorker.ts` 在独立连接上提供同一合同，不是另一份权威。
`contextRecords.ts` 先限定 Task，再按 status、消息处理回执、事件身份及序号过滤，
最后仅反序列化当前页。`taskCatalog.ts` 跨任务组合状态、活动运行和未决操作；
`taskSearch.ts` 在 Brief、Message、Decision、Run result 和 completion 正文中查询片段。

这意味着移动这些正文后必须同时解决 SQL 消费，而不是留下可编辑 JSON 文件和数据库镜像。
当前保留其单一数据库权威；没有为每个表增加文件版本或另一套索引服务。

`runContextPack.ts` 原先通过 `listContextSnapshots` 读取全部快照后选择最近序号。
快照 resource 是已经授权、冻结且按 digest 引用的值，运行时不能从可变源重新读取。
它的 SQL 消费是身份/scope/sequence，而不是 resource 正文搜索，适合拆成不可变对象。
现在生产者写对象后提交元数据，读取者先选择快照再按固定摘要读取。

`taskArtifactRepository.ts` 已提供本地 Git、expected-HEAD、短锁、固定 commit 和逐文件读取；
`iteration/iteration.ts` 的 direction/plan/experiment/execution/analysis 已使用该权威。
文档无需再放进数据库或普通代码仓库。一个 Task 绑定多个 Project，不存在默认的
“把任务资料放进第一个 Project”规则。

### 1.2 比较

| 方案 | 适用对象 | 关键收益 | 本任务不采用它替代哪些责任 |
| --- | --- | --- | --- |
| SQLite 行 + 查询列/JSON 表达式索引 | 状态、授权、队列、回执、排序分页、跨实体提交 | 单事务、CAS、唯一键、稳定选择；无需 Agent 扫描文件 | 不继续内嵌重复的冻结 resource 正文 |
| 普通结构化 JSON 文件 | 不可变机器数据、精确内容引用 | 精确解析、任务归属、摘要校验、独立读取 | 不承担 Schedule due/generation、消息 ACK、授权或多实体事务 |
| Markdown + Artifact Git | 方案、报告、长篇知识说明 | 人审阅、固定历史版本、逐文档修改 | 不承担机器运行状态、查询索引或可执行授权 |
| 不可变内容 + DB 元数据 | 冻结 Context 值 | 元数据查询与正文增长分开；任务内复用 | 不做跨任务共享对象池；不把文件存在视作已提交快照 |
| 可重建 Context 投影 | 当前 policy/knowledge 摘要与引用 | 小上下文、按需展开、无额外写入 | 不成为历史权威，不覆盖旧 Snapshot |
| 每任务 SQLite 分库 | 本轮不选择 | 物理删除边界直观 | 跨任务目录、Global Job/消息与资源事务会变成跨库提交；WAL 下不能假装原子 |

选择依据是消费模式和一致性，不是某种格式普遍更快。用户给出的旧 Home 内容统计不是
磁盘占用或性能基准，本任务没有对真实 Home 跑压力测试。不能据此声称固定节省比例。
冻结内容去重消除同一任务相同值的重复正文，但会增加文件数量和按摘要读取开销。
SQL 查询列、页上限和历史序号不因正文分离改变。

## 2. SQLite 清单：53 表逐项归属

下列是基线实际 schema（`baselineSchema.ts` 及增量 schema）的完整表集合。
“保留”指普通归档和过程清理，不代表彻底删除时永久保留 Task 正文。
除专门列出的权威外，JSON payload 是领域记录；重复的 SQL 查询列由同一 Store 写事务维护，
不是另一个可编辑来源。`home_meta.revision` CAS、`BEGIN IMMEDIATE`、WAL/FULL 和领域校验
适用于现有 Store 写入；特殊约束逐项列出。读取入口简称：
Context=task context / run context；控制器=调度与运行折叠；显式命令=对应领域 CLI。

### 2.1 Home 配置与身份

| 表 | 字段/聚合与归属 | 写入者 → 读取者/查询 | 增长、引用、目标决定 |
| --- | --- | --- | --- |
| storage_schema | format、major/minor、checksum 单例；Home | setup/集中迁移 → admission/maintenance | 常量；永不随 Task 删除；已发布版本定义不可改写 |
| home_meta | home_identity、revision、时间；Home | 初始化/事务提交 → CAS、资源身份 | 常量；revision 是并发凭证，不是 Task 业务版本 |
| config | 配置 payload 单例；Home | config/setup → 启动、调度、默认值 | 小；currentTaskId/lastTaskId 是可清空的选择指针，不拥有 Task 正文 |
| configured_agents | Agent 命令、环境与配置；Home | Agent 管理 → Role 配置解析 | 按 Agent 增长；不因某 Task 使用该 Agent 而归 Task |
| agent_profiles | 可复用 Profile；Home | Profile 管理 → Role 模板解析 | 按 Profile 增长；Task 采用值与全局模板分开 |
| global_sequences | 名称/high_water；Home | 分配 ID → 创建实体 | 小；删除 Task 后仍必须防止 ID 重用 |

### 2.2 Project 与共享资料

| 表 | 字段/聚合与归属 | 写入者 → 读取者/查询 | 增长、引用、目标决定 |
| --- | --- | --- | --- |
| projects | id/name/path 查询列；声明、注册、knowledge、proposals 聚合；Project/Home | project/knowledge 命令 → 项目解析、Context、Web、审批 | id/name/path 查找；knowledge history 随修订增长。保留 SQLite 原子审批；从 Context 拆出本机路径、资源绑定、提案和历史 |
| local_resources | id/canonical_identity 唯一；本机共享资源 | 资源注册 → preparation/plugin 解析 | 按资源增长；不能以使用者 taskId 删除共享资源本体 |
| gate_artifacts | project/commit/plan/toolchain/target + outcome；Project 级可复用证据 | 验证执行 → Gate 检索/最后使用清理 | identity/key 去重，project/commit/last_used 索引；引用它的 Task 不获得删除权 |
| gate_artifact_logs | artifact_key/step_name、log BLOB/digest/bytes | 验证保存 → 精确 Gate log 读取 | 大；随 Gate artifact 外键级联，不随任一 Task 删除 |

Project 内部必须区分三种字段责任：可移植声明（name、aliases、branches、remote）；
本机注册/能力资源（path、ownership、resourceRefs、defaultCapabilityProviders）；
已采纳知识与审批证据。当前选择保留其数据库事务，拆实际消费投影，不把整个 Project
写到某代码仓库，也不增加小文件双写。后续若知识修改/分页规模确有证据，再拆独立修订行；
这不是本轮清理 Task 的前置条件。

### 2.3 Global 运行与消息

| 表 | 字段/聚合与归属 | 写入者 → 读取者/查询 | 增长、引用、目标决定 |
| --- | --- | --- | --- |
| global_roles | name、Role 配置/可能的 jobOwner；Global | Role/Job 管理 → 启动/身份认证 | 数量小；Task-owned Agent Job 的 Global Role 必须按 jobOwner 判属 |
| global_role_session_sets | name/agent_id、Session 历史/providerBinding | Controller/Host 折叠 → caller、retry/native lookup | 历史增长；终态≠无物理进程；不得按 Role 名称前缀清理 |
| global_role_messages | name/message_id/seq、输入及 receipt | Global 输入/通知 → inbox、分页、ACK | 线性增长；通知引用 Task 不等于 Task 拥有全局用户输入 |
| global_job_runs | run_id/status、全局 Job 执行及结果 | Job Controller → Job 状态/调度 | status 索引；可能引用 Task Artifact，删除源 Task 需依赖预检 |

### 2.4 Task 自有业务与运行数据

| 表 | 字段/聚合与归属 | 写入者 → 读取者/查询 | 增长、引用、目标决定 |
| --- | --- | --- | --- |
| task_records | Task payload + brief；Task | 任务生命周期/Brief → Context、search、completion | 每任务一行；Brief CAS 不能变成自由编辑 Markdown；保留，最终删除清除正文 |
| tasks_catalog | status/lifecycle/is_active/时间；Task 派生目录 | saveTask 同事务 → 调度、目录 keyset 分页 | 每任务一行；删除后不保留标题/摘要作为“索引” |
| decisions | task/id、标题/理由/状态/替代关系 | Decision 命令 → Context、search、知识提案 | 按决定增长；保留历史，不把 superseded 当垃圾 |
| milestones | task/id、结果摘要/证据 | Milestone 命令 → Context、知识提案 | 按里程碑增长；长期资料，保留 |
| messages | task/id/seq、body、recipient、inputControl、inbox | 输入/续作/结果路径 → Context、inbox、search | 按序号分页；ACK 与原输入需同一事务语义；保留 |
| events | task/event/type/time、业务事件和运行观测 payload | 所有领域命令/运行折叠 → delta、授权来源、去重、usage、历史原文 | 线性且可能最大；type/time 与观测身份表达式索引。不能把 runtime.observation 一律当可丢日志，因为仍参与身份去重和成本证据；完整删除清除 Task 事件 |
| input_requests | task/id/status/blocks、推荐/期限/答案 | Leader/用户/到期规则 → open 索引、调度 | 未决项是清理阻挡；历史答案保留 |
| task_roles | task/role、配置/继承/归属 | Role 管理 → launch/caller | 运行权威；彻底删除必须阻止任何晚到写恢复 Role |
| work_items | task/id/status、依赖/assignment/candidates/acceptance | Leader/执行/验收 → Context、依赖门 | candidate 是内嵌聚合，查询用 json_each；冻结承诺保留 |
| turns | task/run/role/status、input/effective/workspace/result | Run 派发与精确终态 → Context、search、usage | 大；result 和配置证据不是可随意清理的日志 |
| context_snapshots | task/id/scope/scope_ref/sequence/digest、固定 refs | freeze → Run/Review 精确历史读取 | scope/sequence 唯一索引；1.33 拆正文到任务内对象，digest 不变 |
| review_rounds | task/id/status、candidate/contract/executions/result | Review 路径 → 验收/Context | 冻结候选和结论保留；pending/running 阻挡清理 |
| change_sets | task/id/project/head、变更证据 | 工作区采集 → review/integration | project 是被修改目标，不改变 Task 所有权 |
| integration_attempts | task/id/status、输入/结果/冲突 | Integration → completion/recovery | 未决冲突/验证阻挡；终态历史保留 |
| publication_references | task/id/project/provider/repository/external key/commits/supersedes | 明确发布追踪 → delivery/验证 | external root 唯一、Task 查询索引；删除本地跟踪不得删除 PR、分支或远端制品 |
| release_workflows | task/id、授权步骤与外部效果 | 授权工作流 → 执行/恢复 | 未知效果不能重放；完整删除需 settled，不扩大发布权限 |
| capability_grants | task/id、scope/operation/authority/source | 授权路径 → capability admission | 保留直至 Task 删除；删除后晚到调用不得继续授权 |
| environment_preparations | task/id、local resource 绑定/准备结果 | preparation → launch/plugin | 外键到 Task；引用 local_resources 不是拥有资源 |
| plugin_intents | task/plugin、期望修订与失败 | plugin 配置 → capability activation | 修订/CAS；彻底删除同时取消可执行入口 |
| plugin_validations | task/id、package 内容验证/准备身份 | package validation → intent/launch | 文件包可能共享；仅删除验证记录不推断包所有权 |
| id_sequences | task/kind/high_water | Task 记录分配 → 写入 | 每种记录一行；随完整 Task 清除，Task ID 的防重用仍归 Home |
| durable_jobs | task/job/status、operation/idempotency/process/result | Job Controller → 状态查询/恢复/调度 | actor/request 和 idempotency 唯一；queued/running/未知效果阻挡 |
| task_wakes | task/id/seq/status/cursors/reasons/inbox | 通知聚合 → receiving originals/ACK | window 与 receipt 是输入证据，不按 consumed 删除 |
| role_session_sets | task/role、Session 历史/providerBinding/retry | Controller/Host → 身份/caller/retry | 全局 retry 表达式索引；未终态与保留 claim 都须检查 |
| active_turns | task/pointer/run、活动指针 | Run 管理 → admission/运行观察 | 常量级派生执行指针；“没有 active pointer”不是进程停止证明 |
| task_projections | task/kind，leader failure/notification | 控制器投影 → next action/通知 | 每任务有限；当前失败不可被清理静默消除 |
| telemetry | task/role/run/progress/sequence、进度 JSON | telemetry 批量写 → UI/诊断 | 高频、已有 cap/prune；可清终态过程数据，非授权来源 |
| telemetry_aggregate | task/role/run、计数/时间/错误数 | telemetry 同事务 → usage/展示 | 较小；过程清理合同必须说明保留聚合还是一并移除 |
| task_read_revisions | task/revision | 9 类来源触发器 → 缓存 token | 派生；不是业务 CAS。删除末尾清除，避免删除触发器重新留行 |

### 2.5 混合归属与持久协议

| 表 | 字段/聚合与归属 | 写入者 → 读取者/查询 | 增长、引用、目标决定 |
| --- | --- | --- | --- |
| job_definitions | scope_key/definition_id、executor/action/授权 | Job 定义 → scheduler/dispatch | Global 或 Task 精确 scope；不能按工作目录猜测 |
| schedules | scope_key/id/state/next_due、generation/processedThrough/授权 | Schedule 管理/调度 → due 索引 | 状态和时钟必须事务更新；文件变化不能触发执行 |
| agent_job_runs | run_id/scope_key/definition、attempts/businessResult | Agent Job 管理/终态折叠 → 会话/结果 | task scope 与实际 Global recipient 两维；二者都需释放 |
| mailboxes | target_key、sequence/processing/pending/dedupe | enqueue/claim/settle → ready 索引 | Task/Role/Global/operator 混合；pending/unknown 不能丢；目标键唯一 |
| managed_workspaces | owner kind/id/task/path、项目 entries/branch/base | coordinator → 精确 worktree 清理 | task/work-item/review/integration/lane；dirty/未知资源保留，不删除共享 checkout |
| resource_registry | id/kind/path/disposition/task、owner/basis/refs/receipt | discovery/GC → 分类/CAS/恢复 | 精确 ownership；naming-convention 不足以销毁；quarantine 仍是占有数据 |
| runtime_session_candidates | scope/task/role/agent/adapter/native ID/时间 | Session 写入投影 → native lookup | 可重建；Task 删除需清除 Task 及其 Job-owned Global 条目 |
| session_owners | process_key/scope/task/role/PID、generation/claims | 物理 Session 管理 → 进程/路径引用扫描 | 活动 claim 阻挡；不能仅据 PID 或 Task 终态删 |
| outbox | request_id 唯一、command/state/时间 | 持久事务/RPC → replay/dedupe | Home 协议但 command 可含 Task 正文；需按操作归属拆清，不能整表删除或保留全部正文 |
| storage_migration_archive | version/family/record_key、payload/content | 历史转换 → 诊断/迁移证据 | 需按真实 family/key 溯源；不能假设都是全局，也不能用字符串包含 taskId 决定删除 |

## 3. 文件与外部资源清单

| 命名空间/来源 | 权威与写入/消费 | 归属及清理判断 |
| --- | --- | --- |
| task-artifacts/Task | 本地 Git，artifact.save/list/read；iteration 结构化 JSON 与 Markdown | 持久 Task 资料；普通归档/过程清理保留全部固定历史；彻底删除须扫描跨任务硬引用并检查未提交更改 |
| task-data/Task/context-values | 1.33 Store/迁移写；Snapshot fixed-ref 读取 | 持久 Task 冻结证据；不是 worktree/cache；任务内去重，不跨任务借文件 |
| job-artifacts/global 或 task/Task/Job/Run | Job Artifact Git；owner/sourceRun/version/digest | 持久运行产物；以 scope/owner 判属，外部 Task Artifact 引用不转移所有权 |
| artifacts/jobs/Task/Job | runner spec/log/heartbeat/checkpoint/exit/ready/cancel fence | 过程文件与执行效果证据混合；仍用于不确定性恢复的部分必须保留 |
| workspaces/tasks/Task/main 等 | managed_workspaces + Git worktree inventory | 可回收执行区，不是 Task 资料容器；精确 owner、clean、delivery、进程引用检查 |
| projects/Project 或 external path | Project 注册和 Git 身份 | 共享 checkout；Task 清理不得触碰稳定树或用户外部路径 |
| runtime/task-runtimes 与 integration-runtimes | isolation descriptor/owner marker、启动配置 | 本机运行资源；marker+durable owner+physical absence，禁止单靠路径前缀 |
| runtime/session-contexts、session-manifests、role-profiles | 版本化启动材料/读取入口 | 有精确会话来源；共享/内容寻址文件需最后引用判定，不按最近修改时间猜归属 |
| runtime/skill-packages | 包 manifest、digest、只读文件；effective launch 固定引用 | 跨 Role/Task 共享历史证据；一个 Task 删除不能连带清理包 |
| runtime/agent-host-outbox、native-titles、退出观察 | 精确进程/调用意图与回执 | 未确认效果必须阻挡，不能以“日志”名义删除或重放 |
| runtime/resource-registry/quarantine | Resource GC receipt/原始路径/移动方法 | 仍需活引用扫描；清理失败与未知所有权要保留可恢复记录 |
| runtime/update-staging、release-workflow | 升级/发布产生的临时或证据资源 | Home/对应操作所有；不自动算某个最近 Task 所有 |
| locks 与短路径 IPC socket/tmux | 进程 generation/锁 owner/端点身份 | 机器本地协作资源；不能用删除锁/强停共享 Controller 推进业务清理 |
| backups | 迁移生成的全库备份 | 跨任务保留副本；彻底删除前必须明确其依赖和保留策略，不宣称删主库就抹除了历史正文 |
| Agent 原生配置、认证、transcript | 外部 Agent / nativeAgent 所属产品状态 | Home/账号或隔离运行环境；只删除确由 Task descriptor 拥有的副本，绝不扫用户主目录 |
| PR/MR、远端分支、包、发布资源 | 外部系统 | 本轮无外部删除/发布权限；本地跟踪记录不授予外部销毁权 |

## 4. 内容更新、迁移与历史

1. 可变控制记录仍经 Store 的既有事务和校验写入。不得靠文件 watcher 调度。
2. Artifact 沿用 Git commit/expected-HEAD；不另设可编辑数据库正文。
3. Snapshot 保存先校验全部值/ref，再在 SQLite writer fence 内持久化不可变值，
   最后插入元数据。正文哈希来自原有 `contextContentDigest`，不替换历史摘要算法。
4. 同 Task/同摘要复用前先校验现有内容；损坏时失败，不覆盖。不同 Task 保存独立文件。
5. 文件发布先 fsync 文件和目录，数据库提交后才可见。SQL 回滚可能留下未引用对象，
   但读取不会通过目录扫描把它们当快照。过程清理可在 writer fence 内回收经证明无引用的对象。
6. 迁移逐条读取旧快照，避免一次加载全 Home；对象成功后才更新该行元数据，最后提交统一版本。
   旧数据库备份内嵌正文。失败恢复只删除该次创建的确切文件，已有对象不参与回滚删除。
7. 崩溃恢复重试复用校验成功的对象；没有后台“修复”历史。恢复失败不得宣告场景未变。
8. 1.33 以后备份不能只拷贝 DB 就宣称完整 Home 备份：必须保留被引用对象和 Artifact。
   将来修改物理布局时仍走集中版本迁移，不增加运行时旧形状双读。

## 5. 三档生命周期的目标契约（待实现部分）

清理能力随正常软件版本升级交付；需要改变持久布局时，仍通过唯一 Storage
版本链转换、备份和失败恢复。升级不隐式执行过程清理或彻底删除，不按任务年龄
自动销毁数据。当前 telemetry 清理使用已有表及通用事件回执，没有新增数据形状，
不增加空迁移；已有任务无需重新创建即可显式使用该能力。

当前可执行入口（不是全量过程文件清理）：

```sh
yui task process-cleanup <task> --preview
yui task process-cleanup <task> --confirm <preview-digest> --request-id <stable-id>
```

预览只返回数量、正文 UTF-8 字节数、摘要和保留范围；字节数不是可回收磁盘空间。
执行不 VACUUM、不删除日志/工作区/内容文件。SQL 删除与审计回执一起提交，失败一起回滚。
确认摘要不是授权令牌；执行仍需有效用户/Operator/同任务 Leader 身份及运行释放证据。
未知调用结果应保留 request ID 和摘要重试，不制造新操作身份。

| 操作 | 保留 | 允许移除 | 前置条件/不可逆性 |
| --- | --- | --- | --- |
| 普通归档 | 全部意图、结论、输入/ACK、冻结证据、Artifact、发布跟踪 | 已验证安全的执行 worktree 和运行资源 | 沿用 settlement/delivery/quiescence；unsafe 资源保留且可发现。逻辑归档不等于内容删除 |
| 清理过程数据 | 任务历史、稳定结果、所有固定引用对象、授权/效果/幂等证据 | 明确终态且无引用的 telemetry 明细、缓存/临时输出、无引用对象；日志只在不是唯一证据时 | 精确目标预览、重新校验、无活动 Run/Host/Job/队列 claim；物理文件删除不可逆，不能用缺失假装成功 |
| 彻底删除 | 最小防重用/操作回执；独立归属的已采纳 Project 知识和外部事实 | Task 自有 SQL 正文、引用索引、Artifact 全历史、受控运行资料及可证明拥有的资源 | 明确确认、跨任务依赖预检、执行栅栏、可恢复删除进度；不可逆，不操作外部 PR/分支/产物 |

最小终态回执只能包含 Task ID、操作 ID/请求摘要、完成时间及结果，不保留标题、
completionSummary、原始输入、授权正文或文件正文。清理中可以保留精确删除清单和失败状态；
完成后应收敛为最小回执。晚到回执、旧 Session、Schedule 和重复请求不能重新创建删除的 Task。

### 5.1 引用语义

- 直接引用另一个 Task 的固定 Artifact 是硬依赖。源 Task 删除前拒绝并报告引用者，
  或通过显式独立复制/转移得到新的自足引用；不得静默重写旧 snapshot 的 digest。
- Frozen Context 已内嵌/独立保存其授权值，不依赖原 Task 可变记录；本任务的任务内对象策略
  正是避免删除 A 时 B 的冻结内容丢失。
- Project Knowledge 的采纳是把自足 body 和 applicability 晋升给 Project，provenance 是出处。
  不能删除 Project 知识来“清干净”源 Task；读取出处缺失要如实显示，不重新授权或补写历史。
- iteration plan 的 `source` 与 Job Artifact 的 `owner` 不是同一语义：
  当前命令验证源 plan，但引用依赖是否已经独立复制必须逐字段确认，不能一概当弱引用。
- Global 用户输入/通知、备份、发布记录中的 Task 引用不能通过字符串包含匹配一刀切删除。
  操作归属和正文所有权需要结构化映射；无法证明的项应在预览中阻挡，不扩大删除范围。
- 同一 Project 的共享 Gate、Skill 包、资源 checkout 仍独立存在；Task 只解除自己的引用。

### 5.2 崩溃、并发与物理边界

删除 SQL 行和删除文件不是同一原子事务，不能吞掉文件失败后提交“已删除”。
实现必须在现有权限/资源模型上增加最小的删除意图与恢复证据：先固定范围并阻止新执行/
引用写入，再删除或隔离精确拥有的文件，最后清理 Task 正文并留下最小回执。
重试沿同一操作身份核对已发生效果，不重新猜路径或更换 request ID。

普通 worktree 回收不会删 Task 资料；dirty worktree 不是可丢弃过程数据。
符号链接、hard link、共享 ancestor、未确认 Host/Session、未结束 Job、处理中 mailbox
及未知 outbox 效果均需明确处理。数据库终态不是内核进程停止证据。
既有 `archiveExecutionChecks`、`jobCleanupBlocker`、Resource GC 精确引用扫描应复用；
不引入按年龄后台清理、泛化策略引擎或自动销毁其他任务的“修复器”。

## 6. 验收与剩余工作

第一部分验证：`npm test`，1087 项，1079 通过，8 跳过，0 失败；
包含 build、business 和 platform。不可用的 sqlite-compat 在本机 Node 24 被明确跳过，
不据此宣称该驱动已验证。没有真实模型/生产 Home/付费资源测试。

telemetry 明细清理增量验证：`npm test`，1090 项，1082 通过，8 跳过，0 失败。
新增隔离回归覆盖预览绑定、重复请求、事务回滚、跨任务隔离、保留汇总、晚到写入、
权限与运行/队列阻挡；升级回归确认过程数据不被自动清除。尚未验证下述未实现能力。

后续必须完成，不能用本文或第一部分的测试代替：

1. 把第 2、3 节所有权映射落实为删除范围，而不是仅导出清单。
2. 硬引用覆盖当前与固定历史版本、Global/Task Job、知识晋升及备份。
3. 三档操作的公共 CLI/能力入口、范围预览、确认与权限边界。
4. 隔离 Home 验证新建/升级、多项目、清理 A 后 B/Global 字节与功能不变。
5. 活动执行拒绝、dirty/symlink 拒绝、中断恢复、重复调用、晚到输入/权限失效。
6. 对最终完整 diff 与清理失败路径进行审查，再按实际交付权限验收。
