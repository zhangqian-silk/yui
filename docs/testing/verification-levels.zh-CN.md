<p align="right"><a href="./verification-levels.md">English</a> | <strong>简体中文</strong></p>

# 验证策略

Yui 是一个单用户本地产品。永久验证保护关键的 happy path 和少数几个高影响、易被改动
的正确性边界。它不是一份把每个缺陷或边界情况都收录在案的历史目录。

## 本地开发

使用当前变更所需的最小证据。仅当以下全部成立时才保留一个聚焦的回归测试：

- 失败会丢失持久意图、越过权限/隔离边界，或阻止 Agent/Operator 取得正当进展。
- 该边界被频繁改动的代码共享，或已经在一次真实执行中失败过。
- 该检查是确定性的、使用一次性本地夹具、在毫秒级运行，并断言可观察行为而非附带布局。
- 尚不存在等价覆盖；优先用一个连贯的场景，而不是为每个历史症状分开建用例。

把宽泛的故障矩阵、真实模型演练、畸形数据组合和针对具体事故的脚本保持为临时的。变更
完成后移除它们的 harness，并保留有用的报告。真实资源结果不替代快速回归，快速回归也
不确立真实模型行为。

## 关注覆盖，而不是测试数量

保留三类互补证据：经过真实入口和组件组装的少量正常链路；保护持久意图、幂等、权限、
隔离和历史存储的关键回归；覆盖有意义分支的低成本纯逻辑检查。全绿证明断言成立，
不证明不存在任何缺陷。

持久化或公开契约中的常量值得固定，例如事件名、协议标识和历史编码；保留独立字面值
期望，并尽量证明当前读取逻辑能理解迁移后的数据。不要让预期值和实际值都来自同一个
常量，也不因内部默认值是常量就锁死它。

合并测试前，明确每项断言由哪个保留场景继续保护。相同常量检查和重复初始化可以合并，
但名称相似不代表 Task 与 Global 权限边界可互相替代。不以数量为目标，也不为耗时
预算删除安全检查。可临时引入明确错误来确认关键检查能拦截对应回归，无需永久变异
测试服务或宽泛故障矩阵。

## 永久 core smoke

`npm test` 和 `npm run test:core` 构建当前 checkout 并运行维护中的套件。
两者均包含 `test/core` 和 `test/platform`。已构建的 checkout 可分别运行
`npm run test:business` 与 `npm run test:platform`，它们不会再次构建。
CI 每个作业只显式构建一次。
稳定套件维护当前存储 1.20 和明确声明的 1.0 至 1.19 连续小版本迁移，
不包含未声明的历史格式兼容路径。

当前覆盖包括：

1. 新建存储 1.20、精确结构与记录校验、禁止覆盖未知数据库、无修改拒绝旧整数格式。
2. 精确版本暂存、目标不匹配拒绝、同主版本连续小版本预检、交接锁显式所有者，
   以及恢复时核对捕获的协议和存储身份，不接受缺失字段。
3. 持久 Task／Message／Decision 上下文、Draft 激活权威、mailbox 认领、
   通知幂等、Session 替换及精确晚到结果。
4. Integration／Job 请求身份、冻结候选证据、冲突延续、Review scope 和最终验收。
5. Runtime／Host 隔离、假生产者的 Provider 协议和有界重试、配置来源与账号边界。
6. 工作区／GC 权威、归档清理、资源 CAS、telemetry、Web 投影与无真实外部效果的发布恢复。
7. checkout 隔离启动器的幂等安装、参数与 Home 精确传递、禁止覆盖无关文件，
   以及已移除的全局链接命令在任何副作用前拒绝。开发 Home 重置保留独立的身份检查
   和备份行为。
8. Controller 可选维护、各个重试 Session、Task continuation 观察的失败隔离，
   诊断包含所属对象，不伪造投递、取消或静默状态。
9. 无重放的激活来源交接、同时间戳新输入使 Brief 写入校验失效、绑定 Home 与基线的
   固定事件窗口，以及含移除项的完整冻结引用增量。这些确定性测试验证契约，
   不代表已验证真实模型的语义冲突判断效果。

测试阶段保持秒级，构建单独计时。真实 CLI／Controller／Host／tmux 接线复用现有
组装包冒烟，不新增守护进程矩阵；稳定套件不重建任何已退役的存储路径。
真实模型或真实 Home 检查需要显式授权。
当前记录按声明的字段集合拒绝未知字段，不维护退役字段名称黑名单。

## Skill 与指令变更

一并审阅共享的 Runtime 合同和受影响的 Role/Project Skill。用几个相关场景检查指令
边界：分析保持只读、复用既有机制、Session 丢失保留 Task 意图，以及执行失败不阻止获
授权的监督。这是一次有界审阅，而不是一套新的永久矩阵，也不是使用真实模型的许可。

package-start 检查跟随已安装树中的本地 Skill 引用，包括跨 Role 链接。入口点及其引用
的 Markdown 必须一起发布。文件/格式检查确立可用性，而不是 Agent 行为；不要添加基于
散文匹配的测试，也不要从静态检查中宣称模型验证。

审查材料交接与小型原创开发集见[审查评测](review-evaluation.zh-CN.md)。
其中离线契约探针和裁定汇总属于确定性检查，不运行或测量模型。

## CI 与发布

`ci.yml` 在 PR 和 master 上执行。业务契约与完整业务链路仅在 Linux x64/Node 24
运行一次；平台测试在 Linux Node 24/26、Intel/Apple Silicon Mac Node 24 上运行。
每个作业只构建一次，不重复 lint 或隐含 pretest 构建。保留现有作业名称；发布仍要求
精确 master SHA 的整个 Core CI 成功，不复用另一源码的结果。

| 证据 | PR/master | 精确发布 tarball |
| --- | --- | --- |
| 业务、状态、授权契约（`test/core`） | Linux 24 一次 | 复用精确 SHA 的成功 Core CI |
| OS/helper/PTY/Git/SQLite（`test/platform`） | Linux 24/26、双 Mac 24 | 12 组真实 SQL/GC；其余安装边界见下 |
| `full`：Jobs/Schedules 业务链路 + lifecycle + compatibility | Linux 24 一次 | 复用精确 SHA 业务证据 |
| `lifecycle`：重启、Session/Host 交接、归档 + compatibility | 双 Mac 24，Linux 已在 full 内 | 三平台 Node 24 |
| `compatibility`：setup、CLI/bin、helper、Doctor/PTY/SQLite | Linux 26，其余已包含 | 三平台 × Node 20/22/24/26，24 已包含在 lifecycle 内 |

`node scripts/smoke-runtime-package.mjs --assembled .release-stage` 经过真实
CLI/Controller/Host/SQLite 与隔离 tmux，仅用确定性夹具替换外部 Provider。它验证
setup、输入跨重启持久化及幂等、scratch 激活、原生结果入库、完成后保留会话、
显式重开后的一条幂等 Operator 请求及其精确原生结果，以及
归档释放活/死 pane 和附属查看 session，且不影响相似名称的相邻 session。
夹具拥有新建 Home 和独立 PATH，在 setup 前建立清理责任，不调用安装的真实模型 Agent。

默认 `full` 还覆盖公共 Job、两种 service Schedule 目标、本地 Project 快进、
Task 委派和 Agent Job 路由。Project sync 已验证真实 `existing-job` 调度，
另外保留一条显式 `new-job` Schedule，不再额外跑一条 existing-job 空操作。
这些是业务组装证据，不是 ABI 矩阵。

操作和最终外部可见结果仍通过真实 CLI 验证。就绪轮询可以用安装包的只读 Store
观察夹具自己的准确 Run／Task ID 和事件，再通过 CLI 确认成功。观察器不能写状态、
驱动 reconcile、替代权限或 CLI 输出契约检查，也不能把记录缺失当作成功；
每次读取后关闭连接。Controller 接管仍使用一致的 Session Context／backlog 快照。

避免同一断言在多个层次重复付费：

| 删除的重复工作 | 保留的覆盖 |
| --- | --- |
| 额外 existing-job 空操作 Schedule | 真实 Project-sync 调度→runner→Git 快进；`test/core/schedule.test.js` 的规则和权限断言 |
| Artifact 预览／列表及重复 Run-result 投影 | 安装包保存→固定版本读取；`test/core/job-artifact.test.js` 的投影、版本和隔离断言 |
| 清理时对已终结 Job 再取消并查询 | 仍取消并等待真正活动的 Run；保留 Task 委派取消验证 |
| 假 Provider 两个处理器重复读取原文；Task Job 未使用的 evidence 查询 | 一次原文读取供两个处理器使用；Global delivery 或 Task wake 的准确接收证据以及 claim/report/ACK 仍走 CLI |

Agent Job 各目标接线、复用／替换、准确 inbox 身份、权限拒绝和原生进程归属继续通过
真实安装包验证。不能因为组件测试名称相似就删除不同接线路径，也不为观察器辅助函数
另建一套长期测试矩阵。

冒烟日志分别报告每阶段实际耗时，以及父测试脚本 `runCli` 的调用次数和累计耗时。
CLI 耗时包含命令执行与 Controller 等待，已计入阶段总时间；不含假 Provider 或
其他 helper 发起的 CLI 调用，不能解释为纯启动耗时，也不能再次加到总时间上。
通知轮询找到新通知后保留其准确 wake ID，并持续刷新终态事件，不反复展开历史通知详情。

安装、version/help 和首次 setup 不使用编译缓存。setup 后，`full` 和 `lifecycle`
为重复的真实 CLI 进程设置夹具内的 `NODE_COMPILE_CACHE`；`compatibility` 全程不启用。
它只复用 Node 编译的 JavaScript，不缓存命令结果、原生二进制或 Home 状态。
每次 smoke 都从空缓存开始，随夹具一起删除；不跨作业、安装包或 Node 版本恢复，
也不改变产品默认行为。V8 覆盖率采集不要启用该缓存，以免降低统计精度。

`publish.yml` 通过 `YUI_INSTALLED_ROOT` 对刚安装的包执行上表 profile，增加真实
npm bin、依赖、受支持 Node 版本、产物和 provenance 边界。这证明运行时集成，不证明
真实模型行为。纯契约与安全检查保留在 `test/core`，生产组件组装在这里验证，
不只依赖模拟端口。
同一发布矩阵还针对消费者安装包运行 `test/platform/sqlite-native.test.js`，验证所选
驱动的分配/GC，并对每个可用的可选 SQLite 候选执行真实 SQL、事务、JSON/RETURNING、
WAL 和备份检查。不可用候选会明确标记跳过，不视为兼容；正常选择路径仍必须通过。
Doctor 冒烟报告选中的驱动、引擎和回退原因。该矩阵不能证明旧 glibc 环境兼容。
纯选择/错误分类分支留在 `test/core/sqlite-driver.test.js`，执行一次。安装包 Doctor
和原生 SQL 已证明的探针不在它们前面重复执行；仓库原生缓存仍在构建后验证，
不跨 ABI 复用消费者的二进制。
原生依赖检查必须通过 PTY 启动固定本地程序，确认输出和正常退出。安装包 smoke
明确断言默认 Doctor 的 PTY 检查成功，并从消费者安装目录解析依赖。macOS 还会
在可丢弃的依赖副本中移除 spawn-helper 执行权限，验证 Doctor 报出实际 helper
路径和权限原因且不自动修复。Doctor 的隔离 PTY 探针等待输出／退出最多 750 ms，
外层原生进程限制为 1.5 秒，并报告耗时；原有 Agent／Controller 检查另有成本，
这不是整个 Doctor 一秒内返回的保证。
组装包检查还验证固定身份输出，以及升级侧通过组装包采集资源和精确 Controller 身份，
并在父进程持有交接锁时，通过真实生命周期子进程停止精确 Controller、恢复其已捕获的
启动身份。无关调用仍被锁阻止，锁保持由父进程持有，持久输入不变。
同一个存活 Operator Host 跨越交接：在 Controller 停机期间持久保存 Desktop
直接回合的终态，随后由新 Controller 推进排队的用户输入和工程通知，保留原始输入身份，
不替换 Host。这是当前契约下的进程交接回归，不证明所有历史 Host 实现都兼容；
这些检查不执行安装或发布效果。

smoke 输出各阶段和总计（含清理）的 `TIMING`。分别测量构建、依赖安装/缓存恢复、
纯测试与 npm install；Actions 总历时中的排队与重跑单列，不算作测试执行时间。
保留现有 npm/原生缓存及精确 tarball 的校验和、provenance 门禁。registry 安装、
Release 资产逐字节比较和 updater 验证证明不同边界，不能无等价身份绑定证据就删除。

作为开发者或审查者的已配置 Agent 是普通执行资源。把一个真实 provider 或模型作为验证
对象则不同：付费 API、共享 Home、生产系统、真实账号额度以及其他不可丢弃的外部效果，
绝不由一个测试或验证请求隐含。它们需要用户就确切的资源和效果边界提出显式请求。

获授权的真实模型检查应区分原生接受、精确 Turn 完成，以及独立核验的文件、测试、
提交和 Task 事实。缺少固定回显标记不是功能失败。Session 替换后，核验新会话读取
原输入，并关联它自己的终态，不要求每个历史 wake 都收到该终态。正常完成与归档
应在停止执行之前检查，stop/cancel 清理是另一条路径。报告须保留这些证据区别。
