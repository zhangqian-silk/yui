<p align="right"><a href="./release-workflow.md">English</a> | <strong>简体中文</strong></p>

# 获授权的发布操作

发布工作流是一段被显式选择、获授权的外部发布效果序列——pull request、CI 确认、
合并、版本 tag、npm 发布、全新安装冒烟、CLI 更新、Controller 替换、Project 迁移和
后置验证。它是一个专用的外部效果设施，而不是 Yui 的 Task 规划或 Agent 执行模型。
Agent 选择一个预先声明的计划，设施从持久状态驱动该计划：每次转换都在下一次外部调用
之前持久化，因此崩溃、超时或被撤销的 grant 都不会让发布陷入猜测。

两个 Task 级记录族支撑它：

- **CapabilityGrant**（`capability-grant-N`）——权威。一个具名的授权者把 grant
  限定到若干动作、参数边界、一个过期时间、一个使用次数和一个不可逆上限。
- **ReleaseWorkflow**（`release-workflow-N`）——计划及其进展：一个确切来源（仓库 +
  钉住的 commit，可选一个 artifact）、一份不可变的有序步骤计划，以及每步一条持久记录。

引擎（`src/release/releaseWorkflowEngine.ts`）负责持久状态转换和工作流锁；`yui task workflow` 和
`yui task grant` 命令驱动它。每个外部系统都位于 `ReleaseWorkflowPorts`
（`src/release/releaseWorkflowPorts.ts`）之后。可用临时 SQLite 和确定性的外部端口测试
恢复逻辑，无需真实 GitHub、npm、git、Controller 或模型效果。

## Yui 的默认发版边界

开发 Yui 本身时，发版规则以仓库中的 `AGENTS.md` 为准：默认不发布新版本。
开发、测试、验收、创建 PR 和合并不包含修改版本号、创建发布 tag 或 GitHub Release、
发布 npm；每项外部效果仍需 Task 的实际授权。仅包含 PR、CI 和合并步骤也是合法的交付
计划，`ReleaseWorkflow` 这个名称不授予包发布、全局 CLI 更新或 Controller 替换权限。

用户明确要求「发布新版本」时，新功能或接口／行为不兼容变更使用 minor（中版本），
纯兼容修复可使用 patch（小版本）。不兼容本身不要求 major 或再次确认版本级别；
只有用户明确要求 major（大版本）时才发布 major。

这是 Yui 项目专属的编号约定，不是通常 SemVer 的向后兼容承诺：minor 也可能不兼容。
用户升级前应阅读兼容性及迁移说明；发布说明必须列明受影响的契约与新接口用法，
不能将不兼容冒称为兼容，也不为回避版本选择新增历史兼容机制。包版本与协议、
持久存储契约仍然独立：兼容性检查和必要迁移要求不变，下文存储规则不授予发版权限。

### 2.19.0 兼容性及迁移说明

本 minor 新增消息积压、投递阻塞监测及 Operator 告警（PR #492）。观测区分正常执行、
暂停、有界重试与投递停滞，保留原始证据，并跨 Controller 重启去重告警。
告警包含按证据匹配的管理恢复引导：先检查精确输入和执行状态，区分明确拒绝后的
retry 与未知结果的 resolve，并在需要时要求精确停止证明或显式替换授权。
监测不会自动重试、停止或替换执行；告警本身不是恢复授权，也不证明唯一根因。

存储仍为 **1.24**，Controller/Host 协议仍为 v1。已有消息与事件保留，本版本
不新增存储迁移；较早受支持 Home 仍通过集中式连续迁移链升级。
另行获得更新授权后，由 Operator 核验实际发布包，再执行
`yui update --version 2.19.0`。兼容的存活 Session 保留；发布本身不更新运行安装，
也不恢复其他 Task。精确 merge commit 的 Core CI 与同一 tarball 的全新安装
平台／Node 矩阵仍为发布门禁，这些验证不代表真实模型行为验证。

### 2.18.0 兼容性及迁移说明

本 minor 包含已合入的独立 Jobs 工作区和全局 Shell 脚本 Job（PR #490），以及
Controller 可靠性与诊断改进。精确 Session 停止／替换不再等待无关全局调度排空；
停止证明、单写者和未知输入防重放仍受保护。Session 健康区分历史故障与当前权限，
明确拒绝的过期输入可以合法退役，原始证据保留。

Task 局部惰性缓存、索引查询和持久化耗时观测减少投影开销，并区分请求、worker
和数据库成本。默认持久化 worker 承担周期维护事务的锁等待；空闲 Global 恢复和
已处分重试检查只读。实际启动准入和其他业务写入仍可能竞争。异步脱敏诊断保存到
`runtime/controller-diagnostics.jsonl` 及两个有界轮转文件。这些改进解决已复现机制，
不代表已证明每次历史超时的唯一根因。参见[托管运行时](managed-turn-and-session-runtime.zh-CN.md)。

存储从 **1.22 经 1.23 升至 1.24**：1.23 声明全局 Shell 脚本定义及精确 Run 快照；
1.24 增加 Task 读取修订号与触发器，不改写历史载荷。生产 1.21 Home 会先执行已有的
1.22 Role/Profile 启停字段迁移。必须使用集中式同 major 连续迁移，不手工修改数据库。
Controller RPC、Host control/event 协议仍为 v1；兼容的存活 Host 和 Session 保留，
而非热更新。Host 未报告能力及未知结果仍明确保留。

另行获得生产授权后，由 Operator 核验实际发布包，再执行
`yui update --version 2.18.0`。迁移前刷新一致的维护备份，记录当时程序与 Controller
身份。较早的在线数据库快照不是完整回滚点，不可覆盖后续已接受输入。
旧二进制不能打开 1.24 Home；回滚需要匹配的旧程序和升级前一致 Home 备份，
并核对期间发生的效果。

发布门禁要求精确 merge commit 的 Core CI，以及同一运行包的全新安装平台／Node
矩阵通过后才能发布 npm。本地确定性测试与既有 smoke 不替代这些门禁，也不证明
真实模型行为。发布本身不更新生产 Home，不代表其他 Task 执行问题已解决。

### 2.17.0 兼容性及迁移说明

本 minor 在 CLI 和 Web 设置中新增持久化的 Role/Profile 启用、停用控制。
可使用 `yui config role enable|disable`、`yui config profile enable|disable`
及 `yui task role enable|disable`，并指定对应身份。停用的模板不可用于新绑定；
已复制到 Task 的 Role 保持独立。停用 Role 会阻止新的执行并暂停符合条件的待执行工作，
但不杀死正在运行的 Turn、不丢弃待处理输入、不阻止精确终态补录，也不移除查看、
claim 和 ACK 权限。重新启用后，符合条件的工作按原有权限和重试预算继续，
不会重放已接受或结果未知的输入。

存储通过集中式增量迁移从 **1.21 升至 1.22**，加入可选的 `enabled` 字段。
没有该字段的已有记录仍视为启用，历史载荷保持不变。另行获得升级授权后，可使用
`yui update --version 2.17.0`；updater 负责预检、备份、迁移与 Controller 交接。
不得使用旧二进制打开升级后的 Home。

本次发布还包含已合入的 Draft 规划 Session 替换修复，以及强化行为约束和真实调用路径的
审查交接说明。验证依据为确定性测试与精确 tarball 的全新安装矩阵，不代表真实模型行为验证。
发布本身不会更新全局 CLI、迁移生产 Home、重启其 Controller 或部署生产 Web listener。

### 2.16.0 兼容性及迁移说明

本 minor 更新 Web 工作台（PR #484）：工作台与管理页共用一条全局导航栏
（工作台 / 模型 / 设置），任务侧栏可折叠。弹窗、菜单、按压与分栏布局变化使用统一动效来源；
开启减少动态效果、窄屏布局或页面不可见时直接更新。品牌标志由「結」改为矢量大写 Y，
颜色取自当前主题令牌；每个主题配有对应的 SVG favicon，随主题切换。

以上仅为界面变化。Web API、登录会话、`--auth-file`、CLI 命令以及 Controller/Host 协议均不变。
依赖旧品牌字形或旧导航结构的脚本、浏览器自动化需改用当前页面结构。存储仍为 **1.21**，无迁移。

另行获得升级授权后，使用 `yui update --version 2.16.0`；更新器负责预检、备份与 Controller 交接。
正在运行的 Web 监听器需重启后才会提供新资源。发布门禁复用同一提交的 Core CI 与既有全新安装矩阵
（Linux x64、macOS x64/arm64，Node 20/22/24/26）。发布不会更新全局 CLI、迁移生产 Home、
重启其 Controller 或部署生产 Web 监听器。

### 2.15.0 兼容性及迁移说明

本 minor 以独立中英文登录页替代浏览器 HTTP Basic 弹窗，支持页内错误提示及安全回跳。
凭证文件格式和 `--auth-file` 不变，但不再接受 HTTP Basic `Authorization` 请求头。
脚本须通过同源 JSON `POST /auth/login` 获取会话并保留 Cookie；状态中的认证方式改为
`local`/`password`，不再是 `local`/`basic`。详见 [Web 访问](web-access.md)。

会话仅保存在当前监听器内存中，闲置上限为 8 小时，绝对上限为 24 小时。
界面不提供登出按钮，但保留后端注销与会话撤销能力；终端每个数据转发边界均检查会话。
停止或重启 Web 会结束所有会话。HTTP 仍未加密，只用于可信网络；
本功能不是多用户认证或公网 TLS 托管。

本版本也包含按时区时钟对齐的默认 Project 同步（PR #481）：
新默认规则使用 `0 */6 * * *`，保存明确的时区。存储通过集中迁移从 **1.20 升至 1.21**。
仅转换可证明未编辑过的 revision-1 内置默认规则，并保留原始字节；
更高修订以及自定义、禁用计划保持不变。显式切换计划的方法见
[Project 同步](project-sync.zh-CN.md)。更早的受支持 Home 使用既有同 major 连续迁移链。

获得独立升级授权后可执行 `yui update --version 2.15.0`，由 updater 负责备份、
迁移及 Controller 交接。不要手工修改存储或以旧二进制打开已升级 Home；
minor 编号不是一般性的向后兼容承诺。

发布门禁复用精确 commit 的 Core CI，并在 Linux x64、macOS x64/arm64 与
Node 20/22/24/26 的组合上全新安装同一份带校验和的运行时包，全部通过后发布 npm。
这些是隔离、确定性验证，不是真实模型验证。发布不会更新全局 CLI、迁移生产 Home、
重启其 Controller 或部署生产 Web 监听器。

### 2.14.0 兼容性及迁移说明

保留 `v2.13.0` 标签作为失败发布证据：其发布门禁在 npm 发布前失败。
本次替代 minor 保留下述功能，并修正包 smoke 的接续观察方式：使用一次 Controller
快照和有界的 60 秒多回合等待，保留输入、Host 身份、终态及不重放断言。
生产运行时超时和发布门禁不变；发布前仍须通过完整的全新安装矩阵。

本 minor 新增 Settings → Permissions：命令×角色的只读发现矩阵与内置能力契约，
支持有界搜索、筛选和详情。视图派生自现有 command catalog、discovery 投影及
capability registry，不维护第二份 ACL，也不是新的授权引擎。

角色模板的可见性不代表某次具体调用已获授权。Task、Project、Assignment、生命周期、
资源和 Grant 边界仍在执行时检查。查看角色不会冒充该角色、执行命令、签发或撤销授权，
也不会消费被查看操作的 Grant。新增 GET 接口沿用现有 Web 访问及请求保护。
既有 CLI 授权、命令发现和默认权限不变。参见[授权说明](authorization.md)。

存储保持 **1.20**；本功能不新增存储迁移或协议变更。更早的受支持 Home 仍通过现有
连续同 major 迁移链升级。另获更新授权后使用 `yui update --version 2.14.0`；
更新器负责预检、备份、必要迁移及 Controller 接续。不要用旧二进制打开已升级的 Home，
也不要手改存储。minor 编号不是通用的兼容性承诺。

发布门禁要求精确提交的 Core CI，并在 Linux x64、macOS x64/arm64 与
Node 20/22/24/26 上全新安装同一个 runtime tarball。这些是确定性隔离检查，
不是真实模型验证。发布不会更新全局 CLI、迁移生产 Home、替换其 Controller，
也不会部署或启动生产 Web。

### 2.12.0 兼容性及迁移说明

本 minor 完成作用域明确的 Job 平台：显式业务结果及固定产物、Schedule 目标与服务
授权、受控 Project 刷新、Task 委派、可选 Agent 执行，以及共用的 Task／全局 Web
管理。Task 的 Jobs 页签和 Settings → Jobs & schedules 展示准确的历史 Run、
不可变配置、执行证据及获授权的产物预览。

调用方须区分定义归属、执行目标、进程／原生终态证据和显式 `businessResult`；
投递或进程退出本身不代表业务成功。按执行器种类处理 Run，不再假设每个 Run 都是
shell 进程。固定产物引用保留准确来源身份和作用域；可以预览不等于允许执行。
Task 委派保留不可变来源，不隐式激活 Draft Task。Agent Session 替换保留 Run
要求及结果，不重放输入；投递未知或旧写入者尚未证明停止时仍拒绝替换。
详见 [Jobs 与 Runs](job-runs.md)。

Schedule 继续复用已有准入路径，不引入第二套执行状态。服务授权必须明确授予，
不继承旧 Session 权限，也不授权 Agent 执行。受控 `project.refresh` 绑定当前
受管 Project 目标，复用工作区干净、准确核验后的 fast-forward 路径；发布不会为
任何已注册 Project 启用同步。详见 [Schedules](schedules.md)。

存储通过集中连续迁移链从 **1.14 升至 1.20**：**1.15** 业务结果；
**1.16** Schedule 目标／服务授权；**1.17** 固定 Run 产物；
**1.18** 受控 Project 刷新；**1.19** Task 委派／来源；**1.20** Agent Run／Session
证据。支持的 **1.0–1.19** Home 使用已声明的同 major 迁移，保留历史证据，
不编造结果或授权。另获更新授权后可使用 `yui update --version 2.12.0`；
updater 负责预检、备份、迁移和 Controller 交接。不要用旧二进制打开升级后的 Home，
也不要手改存储。minor 编号不是 SemVer 向后兼容承诺。

发布门禁要求准确提交的 Core CI，以及同一运行包在 Linux x64、macOS x64/arm64
和 Node 20/22/24/26 上的全新安装验证。这些是确定性的隔离检查，不是真实模型验证。
发布不会更新全局 CLI、迁移生产 Home、替换其 Controller 或运行真实 Project 同步。

### 2.11.0 兼容性及迁移说明

本 minor 允许普通非受管原生 Agent 会话使用与本地终端相同的公共操作，包括一般
信息查询和创建 Draft Task。原生线程 ID 本身只是查询线索，不代表受管 Role。
Draft 创建保留已有 Agent、模型、权限和 Profile 配置继承，不启动讨论或开发。

当前仅有原生 ID 的受管 Desktop 会话继续校验 Role、Task、Assignment 和 Grant。
已知历史、停止、冲突或不完整的受管身份保持拒绝，不降级为公共权限。解绑 Session
或删除 Role 后保留停止的身份历史。帮助与补全共用调用方发现；离线 Role 模板只是
指引，不是授权。精确能力评估与执行继续采用当前资源和 Grant 边界。
详见[授权职责和权限矩阵](authorization.md)。

身份查询仅限所选 Home。仅在其他 Home 登记、或已被旧版本删除历史且没有 Yui
提示的裸 ID，无法与普通线程区分。受管会话必须保留正确 Home/Manifest；
本版本不扫描其他 Home，也不重建已删除历史。

存储通过显式集中迁移从 **1.13 升至 1.14**，允许全局 Session 历史在 Role 删除后
保留，同时保留已有 payload。受支持的 **1.0–1.13** Home 使用连续同 major 升级
路径。另行获得更新授权后，可使用 `yui update --version 2.11.0`，由 updater 负责
预检、备份、迁移与 Controller 交接。不要用旧二进制打开升级后的 Home，也不要
手工修改存储。包 minor 编号不构成兼容性承诺。

发布复用精确提交的 Core CI，并在 Linux x64、macOS x64/arm64 和
Node 20/22/24/26 上验证同一运行包后发布 npm。这些是确定性隔离验证，
不是实际模型验证。包发布不更新全局 CLI、不迁移生产 Home、不替换生产 Session，
也不启动 Web 监听。

### 2.10.0 兼容性及迁移说明

本稳定 minor 包含精确 Turn 收件箱处理与继任恢复（Task131 / PR #463、
Task134 / PR #464），以及受认证保护的可信内网 Web 和当前 Operator 生命周期
控制（Task135 / PR #465）。同时纳入显式 Task Project 交付范围与安全普通归档
（PR #462），以及部署特定 GitLab 发布 URL 支持（PR #461）。

Web 默认仍为 loopback。显式私网／通配监听要求
`--auth-file <absolute-path>` 指向仅本用户可访问的密码文件，浏览器用户名为 `yui`。
工作台页面、API 和 Terminal 之前必须认证；沙箱预览保留仅授权当前监听内特定
服务读取的窄票据。HTTP 仍不加密，只应在可信网络使用，不用于公网部署。
当前 Operator、`--detach` 和 `--json` 启动返回 Controller 持有的回执；
通过 `yui web --status` 查询、`yui web --stop` 停止。轮换密码需停止后重启，
Controller 恢复不会自动重新开放 Web。详见[受控 Web 访问](web-access.md)。

收件箱调用者应使用 current/history 视图及返回的精确身份；缺少 ACK 不代表
工作未执行。继任 Session 先检查原始输入和既有效果，再处理保留的 claim，
不重放输入，也不借用另一 Session 的权限。精确 terminal 的处理检查保持有界。
Project 交付排除须有原始范围授权，不删除 binding，也不证明代码已合并。
详见 [CLI 信息契约](cli-information-contract.zh-CN.md)和
[Project 交付范围](project-delivery-scope.md)。

存储经集中式连续迁移从 **1.11 升至 1.13**：**1.12** 声明 Project 交付决策；
**1.13** 声明精确 inbox attempt/target 身份、Global 输入退役及 terminal 处理检查。
历史消息、claim 和验收证据保留，不猜造旧 Turn 归属或 ACK。受支持的
**1.0–1.12** Home 沿用同 major 更新路径。另获更新授权后使用
`yui update --version 2.10.0`，由更新器负责预检、备份、迁移与 Controller 交接；
不要用旧程序打开升级后的 Home，也不要手工编辑存储。包 minor 编号不代表
对所有接口作向后兼容承诺。

发布门禁复用精确提交的 Core CI，并在 npm 发布前对同一 runtime tarball 执行
Linux x64、macOS x64/arm64 与 Node 20/22/24/26 的全新安装验证。
这是确定性和隔离运行时证据，不是真实模型验证。发布不会更新全局 CLI、
迁移生产 Home、替换 Agent Session 或启动生产 Web。

### 2.9.0 兼容性及迁移说明

本稳定 minor 包含分作用域的 Job 定义与精确执行 Run、持久 Schedule、受控 Project
刷新，以及 Task／设置页中的管理界面。同时纳入 Task124 的激活来源与有界时序
上下文改动（PR #458）和 Task130 的工具中立交付验证（PR #459）。

本版包含明确的接口变化：Job 定义与 Run 使用不同身份；原有
`job start/get/cancel/acknowledge` 仍针对单次 Task 执行，新
`job define/run/runs/run-get` 管理定义／Run 模型。Schedule 引用同作用域的 Job，
不替代执行结果。`task brief update` 现在必须把 `task brief show` 返回的
`writeGuard` 作为 `--if-current` 提交；旧 guard 被拒绝后需重读并协调修改。
Leader 的激活请求必须提供明确来源。上下文消费者须遵循有界分页、冻结引用、
Home／Task 绑定的事件续读契约。详见 [Jobs](job-runs.md)、
[Schedules](schedules.md) 和 [CLI 信息契约](cli-information-contract.zh-CN.md)。

Leader 可通过任意已获授权的 CLI/API 核验 PR/MR，再用
`task publication verify --observation` 保存精确结构化证据；内置 gh/glab
适配器仍为可选路径。`publication upsert --verified` 不再允许无证据声明验证，
应改用正式验证入口。已有历史证据保留；候选／对象绑定、不可变历史、观察时效和
普通归档安全边界继续执行，工具输出的语义判断仍由获授权 Leader 负责。

存储经集中式连续迁移从 **1.8 升至 1.11**：**1.9** 新增 Job 定义／全局 Run，
保留每个旧 Task 执行身份及原始 payload；**1.10** 新增 Schedule；**1.11**
声明激活来源事件属性，不猜造历史来源或改写冻结摘要。受支持的 **1.0–1.10**
Home 沿用同 major 更新路径。获更新授权后执行 `yui update --version 2.9.0`，
由更新器负责预检、备份、迁移与 Controller 交接；不要用旧程序打开已升级 Home，
也不要手工编辑存储。缺失的历史来源仍明确报告为诊断。

发布验证使用精确提交的 Core CI，以及针对同一 runtime tarball 的既有全新安装
矩阵，覆盖 Linux x64、macOS x64/arm64 和 Node 20/22/24/26，并保留校验和及 npm
来源证明；不冒称真实模型或公司 API 验证。包发布本身不会更新任何全局 CLI、
Home 或 Controller，这由另行获授权的 Operator 操作负责。

### 2.8.1 兼容性及迁移说明

本 patch 修复已有 Operator 会话仅携带 native 身份（包括 Codex Desktop）时的
维护启动循环。`doctor`、`upgrade`、`update` 先在受支持的旧 Home 上验证调用者，
不再要求存储已经升级才能进入只读预检。结构化预检失败保留原始诊断与恢复指引；
普通业务命令仍要求当前存储格式和有效权限。

存储仍为 **1.8**，已有 **1.0 至 1.8** 连续迁移链、备份、维护锁和精确 Controller
交接保持不变。可使用 `yui update --version 2.8.1`；受支持的 Home 不需要手工先做
中间升级或更换 native 会话。1.0 之前／0.x Home 格式不在本次迁移支持范围内，
本版本不引入旧格式转换或历史授权例外。

隔离验证使用真实已发布的 2.7.1 CLI、1.7 Home 和运行中的 Controller/Host：
一次 native-only update 保留原 Host 与 native 会话，完成存储迁移并继续处理新输入。
仅外部 Provider 使用确定性模拟。发布不会更新用户真实全局 CLI、Home 或生产 Controller。

### 2.8.0 兼容性及迁移说明

本 minor 新增原生 metabridge 模型管理：提供商配置、模型目录缓存，以及经受支持
CPA 扩展手动查询的订阅额度。模型和设置共用导航、规范分区 URL、浏览器前后退、
语言和主题处理；带内容版本的静态资源改善重复访问，HTML 与账号 API 仍不缓存。
同时包含 2.7.1 之后合入的聊天式 Conversation 面板、有界运行诊断、原生调用者／
收件箱修正，以及评审上下文改进。

存储通过集中式增量迁移从 **1.7 升至 1.8**，新增可选、非密钥的模型连接引用；
已有 Home 保持未配置。另行授权升级时可使用 `yui update --version 2.8.0`，
由更新器负责预检、备份、迁移与 Controller 替换。不要使用旧程序打开升级后的
Home，也不要手工修改存储。

metabridge 与 CPA 仍为单独运维的服务，安装 Yui 不会启动、重载或自动接管它们，
需显式配置连接引用。保存提供商配置不代表已生效，也不验证推理；CPA 继续负责其
上游 OAuth／账号池。额度刷新可能查询计费服务，但不续期凭据、不重置额度、
不执行推理；未知、部分成功和过期观测保持区分。

发布证据为确定性核心 CI 与受支持 Linux／macOS、Node 版本上的隔离全新安装冒烟，
不代表真实模型验证。仅发布本包不授予全局 CLI 更新、实际 Home 迁移或生产服务重启权限。

### 2.7.1 兼容性及迁移说明

本版交付原定的 2.7 功能。`v2.7.0` 的运行包冒烟将 macOS 临时路径与其物理别名
直接比较，在 npm 发布前停止；现改用物理包根路径，原有断言和跨平台发布门禁
保持不变。

本 minor 增加 GlobalRole 及 Task Leader、Worker、Reviewer 自身作用域的 Agent
收件箱发现、全文读取、领取与确认。在当前受管理 Session 中使用
`yui inbox list/show/claim/ack`；读取不消费输入，claim 不增加权限，ack 不是执行结果
验收。持久回执与自动投递仲裁，不重放结果未知的原生输入。

存储通过集中式增量迁移从 **1.6 升至 1.7**，为 Message 和 Leader wake 增加收件箱
回执。确切升级使用 `yui update --version 2.7.1`；更新器预检目标 Home，在需要迁移
时备份，并协调确切 Controller 的替换。不要手工编辑存储记录，Task、Session
及原始输入历史仍为权威。

Runtime/Role Skill 使用稳定源入口和独立的整数 `VERSION` 文件。每轮执行
`yui session skills --json`；只有版本未变且全文仍在当前上下文时才复用，版本变化、
恢复或上下文缺失／不确定时全文重读。自定义 Skill 须在 `SKILL.md` 旁提供 `VERSION`。

冻结包仅作历史审计，不再是 Session 准入条件；合法 1.5 以前的 Session 可在缺少
该证据时恢复，不补造已读、原生接受或输入消费回执。身份、作用域、writer、
生命周期、协议／存储兼容与未知输入不重放边界保持不变。Skill 加载变更本身不增加
存储迁移。

本版还恢复 Controller 替换期间积压的 Operator 通知和 Desktop 直连终态事实，
保留精确输入与 Turn 身份。SQLite 优先使用固定版本的现代 N-API 驱动，在可选原生
候选不可用时有界回退至兼容候选，修复已复现的 Node 24 原生 GC 崩溃。

发版证据为确定性核心检查及隔离的组装／全新安装运行包冒烟，不代表真实模型行为
验证。仅发布本包不授予全局 CLI 更新、Home 迁移或 Controller 替换权限。

### 2.6.0 兼容性及迁移说明

本 minor 包含 Task111 的当前活动分页与并行执行摘要。任务运行列表可发现超出
紧凑样本的全部当前 Role、Run、Review、Job 及 open InputRequest，精确记录
仍按需展开。`task context list --view current` 筛选当前事项，默认 `all`
保留历史。集合变化后须刷新，不可继续使用旧分页游标拼接结果。

执行摘要的消费者须支持新增的派生状态 `waiting-on-jobs`、动作
`wait-for-jobs` 及并行 `activity` 分类。这些不是 Task 生命周期状态，
也不增加调度权限。等待用户输入不再隐藏并行工作；未知结果仍为未知，
不能据此重放执行。

紧凑原生观测现在返回分类总数及有界会话样本，使用
`operationCount`/`backgroundCount`，不再内嵌子活动列表。需要这些记录的
消费者须分页读取 `/api/tasks/<id>/activity`。覆盖范围明确为 partial：
选中的原生会话及身份明确的保留子活动观测，不是实时进程清单。原生事实
可能描述同一个 AgentRun，不可相加为独立执行者数量。

没有新增存储迁移，存储版本仍为 **1.6**。既有验收证据来自确定性测试和
隔离浏览器夹具，不代表真实模型验证。发布此包不升级全局 CLI、不迁移 Home，
也不重启 Controller。

### 2.5.0 兼容性及迁移说明

本 minor 包含 Task110 的通知和上下文加载优化。正常与恢复通知共用有界事实、
可选且注明来源的作者摘要及精确行动入口。摘要不是验收或授权：相关需求、
用户消息和执行结果仍须全文读取。

会话说明显式列出所需 Skill。只有完整的同版本说明仍在可用上下文中时才能复用；
首次进入、说明变更或内容缺失／被压缩时，须重新加载精确 Manifest 及其引用文件。
没有新增持久已读回执、说明缓存或专用模型摘要调用。

`task wake show` 默认聚焦相关消息、结果及引用证据；如需更完整的固定窗口诊断，
使用 `--history`，有分页时继续读取。调用方不能将聚焦视图当作全部历史。
原始记录、精确旧引用、去重、快照边界及未知输入不得重放的规则保持不变。

本版不新增存储迁移，存储仍为 **1.6**。确定性测试及安装包冒烟不证明真实模型
会复用说明或在压缩后正确补读；字节测量不是 token 节省，简单首次进入的开销
可能增加。发布本包不会升级全局 CLI、迁移 Home 或重启 Controller。

### 2.4.0 兼容性及迁移说明

本 minor 发布统一 Web Task／Operator 对话及同 Thread Codex 终端、任务工作台、
设置、文本材料、固定版本 Markdown／图片预览、有界检索与精确选区引用、
Task-owned HTTP 预览、当前 Session 模型／Slash 操作，以及 Skill 浏览和显式绑定。
同时包含 Knowledge 适用范围、完整冻结 Skill 包、具来源的用量／费用证据、
Git 2.29+ 支持，以及 Task109 的模型校验、终端读者隔离和未知发送恢复修复。
Task110 尚未合入的工作不属于本版本。

存储版本现为 **1.6**。旧的受支持 Home 应走集中、连续的同主版本升级路径，
不要手工修改存储记录。历史缺失费用仍为未知；旧 Skill 来源不会从今天的文件
补造。2.4 原有“恢复需要冻结包”的限制已由上述当前加载契约取代；
保留旧历史，不再将缺少冻结包作为 Session 准入门槛。
当前模型操作只作用于本次连接，不修改未来默认值；切换模型前须退出 Host 持有的
原生 TUI，关闭浏览器查看器仅断开查看。未知发送必须查询原 request-id，
不能通过新标签页重放。这些是明确的行为边界，不是一般向后兼容承诺。

[Task109 报告](testing/web-coverage-final.md) 保留 Linux 浏览器和真实模型证据，
以及原平台／沙箱限制。正式 CI／安装包冒烟是独立证据，不代表 macOS 浏览器或
真实模型覆盖。真实模型测试保持 opt-in。发布本包不会升级全局 CLI、迁移用户
Home 或重启其 Controller。

### 2.3.0 兼容性及迁移说明

本次 minor 将 Task 验收与已核验的远端交付、不可变 Integration 历史、
临时工作区清理分开。释放工作区后，Integration 历史仍可读取。

此前把残留工作区一律视为归档阻塞的自动化，现在应分别检查业务结算、
精确交付与运行时静默，以及物理清理结果。普通归档按子资源优先释放安全资源，
保留脏、未知或仍存活的资源及其所有权、诊断。`--force` 需要单独明确授权；
它不证明交付或静默，也不允许丢弃被保留的数据。

普通 Integration 冲突应在原 attempt 的工作区解决并 stage，然后执行
`yui task integration continue <task>/<integration>`。不要仅因普通 Git 冲突
另建 attempt 或要求 manual-resolution 决策。清理依赖精确所有权与 Git 登记；
路径缺失本身不代表清理完成。

这些是 Yui minor 编号约定下的行为变化。2.3.0 没有新的持久 schema 或存储迁移，
保留现有 Task 与 Integration 证据。发布包本身不会安装全局 CLI、激活运行时
或重启 Controller。从 2.1.0 升级的用户还需遵循下文 2.2.0 API 指引。

### 2.2.0 兼容性及迁移说明

本 minor 增加独立 `yui agent` 入口、显式模型／工具配置、持久本地会话、上下文压缩、
离线评估，以及 Task 交接／Leader 写域修复和 Web 布局改善。

2.1.0 独立 Agent 的公开 `createAgent({ onEvent })` 已被替换。
JavaScript 调用方继续传入 `onEvent` 时不会再触发该回调，Turn 仍可能完成，
但事实仅保留在内存中。升级前必须调整调用方；虽然编号为 minor，这仍是不兼容变化。

必要的有序记录使用 `recorder.record`：内核等待记录确认，拒绝会停止新增效果。
可选展示／遥测使用同步 `observer.observe`：失败写入 `observerErrors`，不停止 Turn。
Observer 必须自行排队异步工作，不能返回 Promise。旧异步持久化回调应改为：

```js
const agent = createAgent({
  provider,
  tools,
  recorder: { record: persistEvent }, // async (event) => { await durableWrite(event); }
  observer: { observe: renderEvent }, // 可选，同步
});
```

检查 `result.recording` 的记录证据及 `result.error`；记录失败代码由
`event_sink_failed` 改为 `recording_failed`。不要把必要持久化放入 Observer。
已有 Task 和历史报告仍可读取，但新 Review 必须有冻结 Candidate／原报告证据，
缺少的历史证据不会自动补造。上下文超预算时，压缩需要显式 compressor。
上述说明不授予全局 CLI 安装、Home 迁移或 Controller 重启权限。

下文操作及示例说明如何执行已经获授权的效果，不是 Task 完成或合并后默认运行的步骤。

## 稳定的 1.0 基线与发布证据

1.0.0 软件包直接定义存储 **1.0** 契约。运行包和当前源码不携带任何历史
迁移链、旧格式读取器、转换工具、样本或兼容测试。新 Home 直接初始化当前
结构；任何不受支持的存储身份都会在不修改 Home 的前提下被拒绝。

存储采用主版本、小版本两级编号，默认更新只允许同主版本内连续的小版本升级。
指定软件版本不代表授权跨存储主版本。当前 Yui 自有格式和协议从 1 开始，
但不重置业务 revision、epoch 或审计证据。
后续如需改变持久化契约，必须声明新的小版本迁移，不能静默改写已发布基线。
有界自动恢复、锁等待、事务、重放保护和精确身份匹配的有效缓存
都是当前运行能力，不作为历史兼容删除。

正式版使用 npm `latest`，预发布版使用 `next`，不能覆盖默认稳定版本。
发布流水线只构建一个运行包，在受支持 Node 版本上验证后，将同一产物发布到
npm，并创建对应 GitHub Release。每个 Release 都包含运行包、校验和与来源记录；
正式 tag 成为 GitHub latest，预发布 tag 不会。

恢复 Controller 时，status 和 live identity 都必须匹配此前捕获的执行文件、
参数、软件版本、Controller 协议和存储版本上下界。缺少字段直接报错，
不再为较早的 Controller 放宽校验。

GitHub Release job 只向草稿上传缺少的附件，逐个下载并与测试产物比较，
不覆盖已经公开的资产。重试只接受字节一致的已有证据。若 npm 已发布而
Release job 失败，只用保留的同一产物重跑失败 job，不重新构建或再次发布。
运行 tarball 不得包含 tools/ 或历史存储迁移。

`yui update --version <exact-version>` 选择精确发布包，实际暂存版本必须匹配。
激活前及维护锁内分别执行目标包的存储预检。不支持的 Home 保持不变。
当前交接子进程必须显式提供锁持有者身份。

## 授权模型

每一次（再）提交一个步骤，都在外部调用**之前**通过 `checkGrant(grant, request, now)`
（`src/grant/capabilityGrant.ts`）。步骤 kind 就是 grant 动作：一个 grant 列出它授权的
步骤 kind，例如 `--action npm-publish --action version-tag`。该判定是 fail-closed
的——每个拒绝都带一个机器可读原因并停止这次运行：

| 原因 | 含义 |
| --- | --- |
| `grant-missing` | 没有 grant 记录绑定到该工作流（引擎级）。 |
| `grant-revoked` | 该 grant 已被 operator 撤销。 |
| `grant-expired` | 墙钟已过该 grant 的 `expiresAt`。 |
| `grant-uses-exhausted` | 该 grant 的 `maxUses` 已被消耗。 |
| `grant-action-not-allowed` | 步骤 kind 不在该 grant 的动作中。 |
| `grant-parameter-missing` | 步骤缺少一个受约束参数。 |
| `grant-parameter-value-not-allowed` | 一个受约束参数的取值越界。 |
| `grant-irreversibility-exceeds-ceiling` | 该步骤比 grant 的上限更不可逆。 |

附加规则：

- **每次获授权提交消耗一次。** 引擎在成功判定与外部调用之间记录一次 grant 使用，
  因此一个 `maxUses` grant 会在那次将要超额的尝试上 fail closed。
- **不可逆步骤需要一个已确认的前缀。** 一个标记为 `irreversible` 的步骤额外要求此前
  每个步骤都是 `succeeded`；否则该步骤以 `prerequisite-not-confirmed` 失败并停止运行。
  这正是让 `npm-publish` 不会跟在一个失败的 PR 之后运行的机制。
- **拒绝会被记录。** 当一个待处理步骤被拒绝时，引擎会启动并把该步骤失败，日志里带上
  这次拒绝，因此 `workflow status` 能准确显示授权在哪里停下。
- **重新绑定。** 一个被撤销、过期或过窄的 grant 不会让工作流走进死胡同。签发一个新
  grant 并用 `yui task workflow resume <task> <workflow> --grant <new-grant>` 恢复；
  跨越这次重新绑定，计划、来源和所有已确认的步骤证据都不可变。

## 稳定的 Task-final Review 合同

兼容的 CLI 包更新和 Controller 替换不改变一个活动 Task 的 final-review 能力。受管
Session 使用普通的 `yui` 命令，兼容性由协议和存储身份检查，一个替换 Leader 呈现由
持久 Task 证据已确立的合同。不需要任何版本感知的 Operator 动作。Candidate 和
Task-final 的 ReviewRound 记录必须全部携带那唯一的合同。冲突的记录 fail closed；
不存在重新绑定事件、恢复命令或第二套合同状态机。

## 当前 Agent Host 边界

存活 Host 保持原 Endpoint 实现，先把准确的 Session/attempt/nativeTurn 事实写入现有
持久 Inbox，再联系 Controller。只有当前 Controller 解析 Run 归属、校验权限、工作区、
生命周期与历史关联并提交结果。Inbox 文件不代表接受；提交后才确认消费，断线或丢失
ACK 不会重放用户输入或模型工作。

启动事实从已兑现的 launch payload 取得准确 Run 身份，不把 Run 固定到长期 Session
环境。即使冻结的 Run 工作区不同于 Role 默认值，登记前的证据也能保留；后续活动和
终态仍只按各自的原生输入身份解析归属。

当前边界为控制协议 `yui-agent-host-control/v1`、事件来源协议 `yui-agent-host-events/v1`、
Controller RPC 版本 1。Host 不打开 Home 数据库，包括进程归属、原生账号位置和
执行环境校验。只有 Controller 拥有存储并解析持久事实；非法当前输入在正常协议
边界得到明确错误。

兼容升级保留逻辑 Session 和存活 Host。构建 generation 仅作历史诊断，不再作为
原生恢复门槛；通过已有获授权生命周期安全释放旧 Host 后，当前内置 adapter 可恢复
同一原生身份，不改变模型、账号、权限或工作区，也不热替换模块或安装旧实现。

支持范围明确为现有 control/event v1 与 RPC 版本 1，不承诺任意历史进程兼容。
Host status 用 `controlCapabilities` 声明控制能力，并用进程加载时捕获的
`hostImplementation` 区别于 Endpoint 构建。Controller 仅在明确声明时发送
`reconcile-turn`。没有能力字段的 v1 Host 仍可读取 status、消费原始 Inbox；
精确终态重发能力不可用，不根据包版本猜测。未知协议仍拒绝。

`update` 区分程序／存储完成与保留 Host 的状态，不打断兼容的忙碌 Host，也不自动
替换不支持的 Host。必要刷新沿用显式生命周期：先证明精确 Turn、后台执行与写入者
已释放，再重新附着。仅 idle 不足以证明安全；状态未知时保留现场，不能强杀、
重放输入或静默新建原生身份。Controller 交接锁、进程身份围栏与 Session 权限继续有效。

存储升级仅包含同主版本内明确的小版本步骤。跨主版本转换独立授权，
不构成运行时回退。
新 Session 使用启动环境中的普通 `yui` 入口；升级不生成或重定向会话 CLI 脚本。
Global Context 命令保持自足，供远端 TUI/Desktop 使用。必须正确选择 PATH 和 Home：
协议及存储校验不能区分所有同合约安装；开发使用显式隔离的 checkout 入口。
运行时诊断不解释 `schema.json`、`state.json` 或整表 release 幂等文件；
当前 SQLite 与逐 key release 回执仍是权威，无关文件保持原样。

`task role status`、`task role list` 和 `task role session inspect` 在持久 Run 状态旁
显示 Host 上报观测。原生结果待落库或已知上报故障需要关注，但不代表 Provider 失败、
Run 已结束或业务已验收。Host 诊断只检查自己已投递文件的身份是否存在，不解析或隔离
其他生产者的新格式事件。
缺少 eventDelivery 表示未报告而非健康。`unpersisted` 是 Inbox 写入失败后仍保留在
原 Host 内的原始事实数；协调先按观察顺序重试这些字节，再补发保留的精确终态，
不重新执行输入。必须保留该 Host 直至落盘，不能在文件系统故障又进程丢失后编造结果。
Task 与 Global 的完整协调都使用同一能力检查，包括没有后续排队输入的最后一个 Turn。

## CLI 与 Controller 发布边界

全局 `yui` 命令是稳定的用户与受管 Session 接口。对普通命令，它不跟随
`runtime/active-release.json`：那个指针选择的是 Controller 发布，而不是 CLI 包。这让
CLI、Operator Session 和 Controller 替换保持兼容，而不必把每个命令钉在一个不可变构建上。

一个源码 checkout 或以其他方式未经验证的本地 CLI 不是这个已发布接口。当 `YUI_HOME`
已经命名了一个活动发布时，这样的 CLI 会在打开存储之前失败，并报告它的构建/来源、
持久的 Home 身份以及它的调用类别。`make install-local` 仍默认使用 checkout 隔离的
`output/dev/home`；把那个 launcher 显式指向一个发布拥有的 Home 会被拒绝。

一个显式的 `yui release activate <release-id|build-id>` 是唯一的例外。全局 CLI 校验
已安装的目标发布及其匹配的冒烟回执，然后把未改动的激活参数委派给那个目标的
`dist/cli.js`。因此目标发布拥有完整的交接协议和超时层级。一次无目标的激活、help、
`--json` 以及其他每个命令都留在全局 CLI 上。激活不新增另一条普通 CLI 路由路径。

## 步骤目录

计划是一个固定、预先声明的操作子集。每个计划条目有一个 id（工作流内唯一）、一个
kind、可选 params，以及一个可选的不可逆级别（`none` | `reversible` | `irreversible`）。

| Kind | 外部效果 | 权威身份 |
| --- | --- | --- |
| `pr-create-or-reuse` | 创建发布 PR，或复用一个针对该 head 的开放 PR。 | `pull-request` 号 |
| `ci-confirm` | 读取该来源 ref 的 CI 结论；仅在 `success` 时成功。 | — |
| `merge` | 合并具名 PR（默认 squash）。 | — |
| `version-tag` | 创建并推送带注释的版本 tag。 | `git-tag` 名 |
| `npm-publish` | 把 tarball 发布到 registry。 | `npm-package` 版本 |
| `fresh-install-smoke` | 从 registry 安装并运行已发布的包。 | — |
| `cli-update` | 通过既有更新编排器更新 Yui CLI/Controller home。 | `controller-home` |
| `controller-replace` | 停止并重启 file-task Controller。 | — |
| `project-migrate` | 通过既有的 project 命令运行 Project 迁移。 | — |
| `post-verify` | 运行一个任意的验证命令。 | — |

步骤可以引用更早的证据：一个 param 值为 `$externalId:<step-id>` 时，会在运行时解析为
被引用步骤已确认的 external id，因此一个 `merge` 步骤可以消费 `pr` 步骤产生的 PR 号，
而 operator 事先并不需要知道它。对一个未确认步骤的引用会让运行失败，而不是猜测。

## 恢复与 resume 语义

一次运行总是从 **resume 游标**开始：第一个状态非终态（`succeeded` 或 `skipped`）的
计划步骤。没有“从头再来”——已确认的步骤绝不重跑。

因为每次状态转换都在下一次外部调用之前持久化，所以任意一点的进程退出都是可恢复的：
重新调用 `run`（或 `resume`），引擎就从第一个未确认步骤继续。`--max-steps <n>` 限定
单次运行；一次在工作流中途耗尽预算的运行返回 `budget-exhausted`，下一次调用继续。

在途步骤通过**权威身份查询**解决，绝不盲目重新提交：

- 一个留在 `running` 或 `unknown` 的步骤，先按其记录的 `externalIdentity` 查询。
  - `exists` → 该步骤到达 `succeeded`，且**没有第二次提交**（`unknown` 被确认，
    `running` 被完成）。
  - `unknown` → 运行以结果 `unknown` 停止；在其命运不可知期间，该步骤绝不被重新提交。
  - `absent` → 效果从未落地，因此该步骤被重试（一个 `running` 步骤会记录这次恢复尝试）。
- 一个**没有** external identity 的 `running` 步骤在记录提交结果之前就崩溃了。一个
  不可逆步骤无论如何都通过端口查询（适配器咨询其持久幂等存储）:`exists` 不经第二次
  提交确认该步骤，`unknown` 以 `unconfirmed` 停止，只有权威的 `absent` 才恰好重试该
  步骤一次。一个可逆步骤总是落到重试，并沿用同一个幂等键。
- 一次**没有** external identity 的超时把该步骤标记为 `unknown`（unconfirmed），因此
  它绝不被盲目重新提交；在 resume 时它以 `unconfirmed` fail closed。
- 一个 `failed` 步骤在下一次运行时被重试；它的 `attempts` 计数和日志按尝试增长。

运行结果：`succeeded`、`failed`、`unknown`、`unauthorized`、`unconfirmed`、
`budget-exhausted`。每个都带一个机器可读的 `stopReason`（例如 `unknown:publish`、
`unauthorized:grant-revoked`、`budget-exhausted:verify`）以及该次运行尝试过的步骤 id
列表。

## 幂等键合同

每个步骤的幂等键在**创建时预先声明**且永不改变：

```text
<taskId>/<workflowId>/<stepId>
```

该键被传给该步骤的每一次 `executeStep` 调用，包括在一次确认为 absent 的超时之后的
重试。端口合同要求 `executeStep` 在同一键下是幂等的：一次重试尝试不得产生第二次
副作用。引擎不会盲目为 `unknown` 步骤调用 `executeStep`，而是先按记录的身份查询。
核心测试用真实 SQLite 和确定性端口检查不确定效果查询、已确认步骤复用和 grant 次数耗尽。
这证明这些引擎边界，不代表真实外部服务或所有发布适配器的幂等性已被验证。

## Operator 指南

Session 权威依据当前持久绑定检查。Telemetry 按 Role/AgentRun 分组，进程 owner 使用
PID/start 身份。存储变更遵循[唯一的显式升级边界](sqlite-control-plane-design.zh-CN.md);
普通命令绝不改写 Home schema。

Operator 的 grant 签发与撤销保留现有权威边界，需要当前已登记的全局 Operator 对话。它的
原生 session ID 必须与持久的活动 session 绑定匹配：Codex 命令在存在时使用
`CODEX_THREAD_ID`，否则使用 `YUI_NATIVE_SESSION_ID`;Claude 使用 `YUI_NATIVE_SESSION_ID`。
Host generation 和启动时的 Agent 标签不是调用者身份。通过另一个入口恢复同一段对话
不撤销其权威。未登记、被替换或已结束的对话没有这种权威。
本 Task 当前 delivery Leader 也可引用真实用户/Operator 原消息，以
`--source-message`、`--purpose`（逐字授权引文）、`--request-id` 签发有有效期及有限次数的
有界 Grant，并撤销本 Task 的 Leader Grant。语义判断仍由 Agent 负责：引文匹配只是来源
验证，开发指令不是发布许可。发布必须限定 Task Project/repository，包与版本操作另须明确
package/version 边界；全局升级、共享 Controller 替换、迁移仍不开放。
Worker/Reviewer、规划/失效 Session 和清空环境不获得授权；身份来自当前持久 Session，
不存在可伪造的 `--granter`/`--by` 标签。参见
[完整来源与普通归档契约](../skills/yui-leader/references/authorization.md)。

```sh
# 1. Operator session 为发布链签发权威。
yui task grant issue task-15 \
  --action pr-create-or-reuse --action npm-publish --action post-verify \
  --irreversibility-ceiling irreversible

# 2. 针对确切来源和预先声明的计划创建工作流。
#    npm-publish 步骤需要一个内容寻址的来源 artifact：不可变的工作流来源以后
#    永远无法再获得它，因此没有 --source-artifact 的计划在创建时即被拒绝。
yui task workflow create task-15 \
  --grant capability-grant-1 \
  --source-repo acme/widget --source-commit abc1234deadbeef0000000000000000000000000 \
  --source-artifact widget-1.0.0.tgz@sha512-<base64-integrity> \
  --step pr:pr-create-or-reuse \
  --step publish:npm-publish --step-irreversibility publish=irreversible \
  --step-param publish:tarball=./dist/widget-1.0.0.tgz \
  --step verify:post-verify --step-param verify:command='yui --version'

# 3. 运行（或 resume）并检查。
yui task workflow run    task-15 release-workflow-1
yui task workflow resume task-15 release-workflow-1 [--grant capability-grant-2] [--max-steps 1]
yui task workflow status task-15 release-workflow-1

# 4. 随时撤销权威；下一个步骤以 unauthorized 停止。
yui task grant revoke task-15 capability-grant-1
```

`workflow status` 渲染每个步骤的状态、尝试次数和已确认的 external id，因此 operator
能准确看到一次发布在哪里停下以及为什么。

## 真实资源边界

真实执行只通过 `yui` CLI 发生，它接上真实适配器（`createReleaseWorkflowPorts`）。该
适配器是既有原子操作——`gh`、`npm`、`git`、CLI 更新编排器、Controller stop/restart 和
`project migrate`——之上的一层薄壳，并且只在一个人类授权者签发了对每个步骤都通过
`checkGrant` 的显式 CapabilityGrant 时才运行。一个本地测试请求绝不替代那份权威。

由 tag 触发的 `publish.yml` 工作流是唯一维护的发布冒烟。它复用那个通过了 core CI 的
确切 commit，只增加发布所需的产物装配、全新安装和 provenance 检查。

业务契约与完整 Jobs/Schedules 链路仅在 Core CI 的 Linux Node 24 执行一次。
发布仍在三平台 × Node 20/22/24/26 全部安装同一个已校验 tarball：每组都验证
CLI/setup/原生 helper、Doctor/PTY 和真实 SQLite SQL/GC；各平台 Node 24 额外验证
真实进程生命周期。参见[分层覆盖表](testing/verification-levels.zh-CN.md#ci-与发布)。
依赖安装不再隐含构建，每个源码作业只构建一次，再验证原生依赖；smoke 输出分段耗时。
发布后的 registry 检查和 GitHub 资产逐字节核验是独立证据，不被发布前 smoke 替代。

该工作流通过 npm Trusted Publishing（OIDC）认证，因此发布身份存在于 tag 之外的两处：
`repository`、`bugs` 和 `homepage` 由 `assemble-runtime-package.mjs` 从源 `package.json`
逐字复制进已发布 manifest，而该包的 npm Trusted Publisher 条目点明 GitHub owner、
仓库、工作流文件和环境。npm 在接受 provenance 之前会区分大小写地将 `repository.url`
与正在构建的仓库比较。因此重命名或转移 GitHub 仓库时，必须连同重命名一起更新这些 URL
和 npm Trusted Publisher 条目；否则下一个 tag 会走到 `npm publish` 并在那里失败——此时
tag 和已过门的构建都已成功。

## 适配器安全加固

真实适配器（`createReleaseWorkflowPorts`）在引擎的 grant 检查之外再施加额外防护：

- **Tarball 选项注入。** 一个看起来像选项的 tarball 路径（以 `-` 开头）在任何子进程
  ——`tar -xOf` manifest 检视和 `npm publish`——看到它之前就被拒绝，因此一个精心构造的
  路径永远不会被当作 flag 解释。
- **Tarball TOCTOU。** 在校验冻结的 `source.artifact.integrity` 之后，被校验的字节被
  快照到一个工作流私有、只读的临时文件。`tar -xOf` manifest 检视和 `npm publish` 都
  读取该快照，而不是活的 tarball 路径，因此校验之后对原文件的替换不能改变所发布的内容。
  步骤完成时移除该快照。
- **钉住的外部命令。** 适配器在构造时通过 `resolveExecutable` 把它 shell 调用的外部
  命令（`gh`、`git`、`npm`、`tar`、`sh`）解析为绝对路径，只走一次调用者的 `PATH`。每次
  子进程调用都使用解析后的路径，因此之后的 `PATH` 变化（或被操纵的工作目录）不能把一次
  发布效果重定向到另一个二进制。一个无法解析的命令返回一个合成失败（exit 127），不调用
  任何二进制。
- **钉住的 cli-update 激活目标。** 在不可逆的更新效果之前，适配器把确切的激活目标——
  Home 加上全局 npm 前缀（`bin/yui`）——持久化到 Home 下的一个持久文件
  （`release/cli-update-identity/<idempotency-key>.json`）。一次硬退出的恢复查询（一个
  没有记录身份的步骤）读取这个文件并调用那个钉住的目标；如果该文件不存在（进程在预效果
  持久化之前退出），查询返回 `unknown`，而不是从 resume 调用者的 `npm prefix --global`
  或 `PATH` 推导目标，因此 resume 环境中的另一个安装不能替这个步骤背书。
- **Controller 生命周期校验。** 一次 `cli-update` 恢复查询会证明替换后的 Controller
  确实拥有目标 Home：它运行 `yui --json controller status`（`YUI_HOME` 钉在记录的 Home
  上），并要求一个 `current` controller 资源，其 `yuiHome` 解析到那个 Home，然后运行
  `yui --json controller identity`，并要求已认证的 Controller 身份与已激活的产物匹配：
  Node.js 可执行路径、由钉住的全局二进制派生的确切 Controller 入口点，以及包版本。仅有
  二进制健康（doctor、`--version`）绝不确认这次交接，任何不可证明的状态都返回 `unknown`。
  这适用于带身份的查询和硬退出查询（一个没有记录身份的步骤）两者。
- **npm integrity 比较。** 一次 `npm-publish` 恢复查询不止步于已发布版本：它通过
  `npm view <pkg>@<version> dist.integrity` 取 `dist.integrity`，并与冻结的
  `source.artifact.integrity` 逐字节比较。匹配则确认该步骤；同一版本但字节不同是一个
  冲突，返回 `unknown`（绝不确认，绝不重新发布）；一个缺失的版本是 `absent`。
