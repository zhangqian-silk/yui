# Task 80 入口装配验证记录

日期：2026-10-04。基线：`ff0b12cfe6c521ea3087d8dcd4d47f6d9a6b4f10`。
工作单元：task-80/work-item-1，隔离Develop工作区；仅修改project-1。
本记录是Worker实现/自审证据，不是Task接受或最终联合验收。
前文记录run-3原始入口；run-5替换其预绑定tools路径，run-6接入84真实项目指导，
run-7接入81真实持久目录与历史，run-8接入原子Session位置，
run-12修复独立Review的非阻塞回执与当前模型运行事实问题。
分别见后文消费证据。旧段落中的“尚未提供”是该轮历史事实，不代表当前状态。

## 已实现边界

轻量`dist/cli.js`按`agent`/`help agent`（含全局`--json`前缀）动态分流，
原控制面移至`controlPlaneCli`，保留公开cli.js入口身份。Agent侧无控制面导入；
显式配置与独立Session库，没有账号/Home回退。
新增配置/装配/自有HTTP transport，未修改唯一kernel、网关、执行所有者、
工具、上下文、SQLite格式或生产者权威类型。

已具备启动、单次JSON输入、行式输入/取消/关闭、明确Session ID续聊、真实回执，
以及每次调用显式工具选择；默认只读，写入/命令需当前调用opt-in，
命令环境为空。凭据仅内存解析；已知凭据不得经模型响应、必要记录或错误落盘。

## 实际验证

命令均使用Node `v24.20.0`的显式PATH。开发CLI使用checkout绝对
`output/dev/bin/yui`与独立fixture `YUI_HOME`。

- `make install-local`：本地构建/launcher成功。首次目录shell意外使用Node18，
  随后明确切换Node24；原生依赖重建，最终以Node24 `npm ci`清理首次安装残留。
  未修改全局安装或管理Home。
- `npm run build`及`npm test`：最后核心运行563项，556通过、7跳过、0失败；
  测试阶段7.92秒。`npm run test:core`是相同脚本，未重复执行。
- `node --test test/core/native-agent-product.test.js`：四项持续回归，覆盖
  配置优先级/非法值/凭据引用、全局JSON入口隔离、真实body取消和持久终态、
  读取→编辑→空环境本地检查→保存→新进程指定ID续聊、默认拒绝副作用。
  单独运行约1.21秒（后续JSON修正也由完整核心套件覆盖）。
- 临时离线故障矩阵：通过真实CLI与local HTTP，认证401、断网、
  一步预算耗尽、模型完整/分片回显dummy secret、必要存储失败均符合预期；
  每个失败只有一次模型请求，无未知请求重放，输出/数据库中dummy secret缺席。
  存储故障在fixture库中故意删除表，仅返回lastConfirmedReceipt，无完整receipt。
  SIGINT、输入EOF、输出pipe断开+EOF均保存真实cancelled终态并允许ready读取，
  子进程结束、连接/body/订阅/计时器由所有者释放；坏数据库零模型请求。
  临时矩阵仅保留本记录，不进入永久测试套件。
- `node docs/examples/agent-offline.mjs`：源码本地入口示例通过。
  同一脚本从组装安装包运行也通过，核对编辑内容、实际命令exitCode=0、
  processGroup=absent、持久receipt/同ID增长、秘密缺席及未创建控制面Home。
- `node scripts/assemble-runtime-package.mjs --output output/task80-runtime-package`、
  `npm pack ./output/task80-runtime-package --dry-run --ignore-scripts --json`、
  `node scripts/check-runtime-package-structure.mjs <inventory>`、
  `node scripts/smoke-runtime-package.mjs --assembled output/task80-runtime-package`：
  组装、结构、真实CLI/Controller/Host/tmux包装启动路径通过。
  初次组装被Node18安装遗留的node-gyp python symlink拒绝；用Node24重新安装
  checkout依赖后通过，未放宽manifest完整性检查。

开发过程中首次全量检查发现新可执行叶子的discovery声明不完整，已修正。
最终自审另发现全局`--json`前缀漏分流，先确认回归失败，再修正并重跑完整核心。
以上失败未作为成功证据，也未扩展至管理环境。

## 自审与清理

检查完整新增文件及rename-aware diff：分流与原CLI身份、配置来源/字段界限、
秘密数据出口、实际工具选择、必要保存/可丢观察分离、回执复核、
失败不重放、取消/EOF/输出错误及finally逆序释放、安装包文件闭包。
未新增第二循环/runner、调度器、持久索引、动态插件或强沙箱声明。
`git diff --check`无空白错误。

所有测试在首次CLI调用前注册teardown，fixture进程、HTTP server、SQLite、
自有连接/body/订阅/计时器和临时目录均关闭/删除。
包装smoke通过其原有finally停止精确fixture Controller并释放自己的tmux namespace；
未对管理Controller或其他Task空间清理。保留checkout构建产物/本地包作为可重建产物；
临时故障矩阵已移除，没有push/PR/merge/tag/npm发布或归档。

## 未完成与未验证

run-3授权上下文当时尚未提供81/82真实固定成果：

- 81：持久catalog/命名/分页、cwd元数据绑定、open/create/rename及恢复诊断，
  对接InteractionSessionPort与真实SessionStore。当前只有明确ID恢复；
  `/sessions`仅列本进程选择，不是持久发现，不能校验原会话cwd。
- 82：真实ToolPermission/ToolEnvironment及有效授权视图、运行时授权变化、
  root/env实际一致性。当前只是已有公开的预绑定tools合同，不复制生产者策略。

Leader需取得真实公开成果，授权后续接线，再做仅替换模型网络的最终用户路径：
发现→选择→目录一致→动态授权→实际效果→保存→关闭→续聊。
当前实现和例子不能冒充这一路径已验收。

没有运行真实模型/付费API/生产账号/共享资源验证；不证明真实规划质量、
厂商完整协议兼容性、强OS沙箱、敌对并发文件系统、硬件掉电/SIGKILL，
也未在macOS或其他Node版本运行。多进程同Session执行仍不受支持。

## run-5：采用82真实源码与入口消费

交接通过task-80/message-16，完整13页的source digest为
`9ad61890dcfe85e7ed540e60eaaeaed6828d1db3295062d5782064ce4ff9dc5f`。
基线`ff0b12cfe6c521ea3087d8dcd4d47f6d9a6b4f10`，
生产者最终Project代码`2703931ec49675214a129f9c6e69587e13c308a9`。
合同14965 UTF-8 bytes、SHA256
`70a87c8eddc5144f0618d5f4b25c63d5c185b14d3596b093182286a279911812`；
完整补丁43155 bytes、SHA256
`6abe588ec2aef100c5b4925dc0aa180d53e89ac2be70455a73b4ca4d6fbf99ad`。
合同Artifact commit为`6b5f6f54e647e202083d40e0a3cf8d20fe3fa97f`，
补丁Artifact commit为`de86b06e403041ac391ee0cafbdde902008a4154`；
两者均不是Project代码commit，也不是消费端commit。

逐页核对相同digest/offset，拼接后JSON.parse一次，按原始字节核验两个payload。
在自身干净`0532ab9`上检查五文件完整增量，`git apply --check`通过后采用真实补丁，
没有读取82私有区、跨Task fetch或假定源Git对象可达。
`localSafety.ts`与82生产补丁相同；消费端配置/装配独立修改并提交自己的身份。

入口现在只通过同一`createLocalToolBinding`产生tools/permission/environment，
再过滤本次工具选择并交给`createToolExecutor`，移除prebound-tools简写。
显式root=cwd、命令精确规格和完整白名单env、已知秘密outcome脱敏；
每次恢复创建新binding/executor，不从历史恢复权限。
公开配置不显示command规格/argv/env值；实际调用事实仍按原必要记录合同保存。
没有更改Session布局/核心循环/生产者安全策略，未混用工厂或实现第二执行器。

新增回归先在旧入口因不支持command-config失败，接线后通过。
一次中间失败来自fixture跨恢复重复调用ID，已使用唯一ID修正；
默认未声明command的响应由现有网关前置拒绝，未放宽协议来迎合fixture。
聚焦三个文件共14项全部通过，约2.01秒；新增连贯CLI场景验证写规格独立opt-in、
精确命令实际写入/exitCode/白名单env、已知文件秘密脱敏、同ID重开默认只读、
模型改变argv前置拒绝、当前SQLite回执与ready历史一致及无控制面Home。
旧取消/body结算和配置隔离回归仍通过。
真实源码入口离线样例通过，完成读取/编辑/精确检查及重开不继承权限。

最终`npm test`（含build）569项，562通过、7跳过、0失败，测试阶段8.03秒；
`npm run test:core`是相同脚本，未重复。组装/dry-pack/结构检查551文件通过，
实际包含`dist/nativeAgent/localSafety.js`；原有runtime package smoke通过，
Doctor原生SQLite/PTY通过，重开/跟进7.56秒、handover 2.66秒。
包内`node output/task80-runtime-package/docs/examples/agent-offline.mjs`通过；
它使用组装包真实公开入口及生产依赖，没有开发launcher回退。
原始日志留在运行时TMPDIR的`task80-core-run5.log`、`task80-package-run5.log`，
清单为`task80-package-inventory-run5.json`。

完整源码/消费增量自审、`git diff --check`及补丁反向`--check`通过；
原生产安全模块blob为`79927fba8b0423535836866ba2979d0db376d703`，
生产回归blob为`a86bb8b062f1b49db148b92d40786303542fb218`，均与交接补丁匹配。
所有自有fixture进程/HTTP/SQLite已结束，指定fixture目录前缀残留检查为空；
原有package smoke以finally停止精确fixture Controller/tmux。
未对其他Task/管理环境做清理，无新daemon；保留可重建本地包/构建产物和验证日志。

81已由其Leader本地验收，但message-13明确还没有消费端合法源码/完整合同；
不再等待81Review，也不以完成通知冒充代码采用。84的message-14是实际合同而非
源码payload，未制造空接线或宣称已消费。最终发现/选择/原会话目录核对仍未验收。
82工厂要求结算关闭后重新组装授权；没有运行时热更新lease/UI、强OS沙箱或全通道DLP。

## run-6：采用84真实源码并与82公开能力组合

日期：2026-10-05。消费基线为既有
`ba8f67ba28787f79a432e0a97389409f851cbcd7`，保留82原源码及binding。
本轮按manifest加载task-80/run-6，核对snapshot-6及其完整digest，
读取message-21派工、message-19背景和message-20的实际交接，不使用旧Run代替。
message-20共15页，同一source digest为
`049a05525a0b547a56ba95105eade7cb0b3d868bc112d0366e87592b03e0449d`。
原始HANDOFF为19429 UTF-8 bytes、SHA256
`eca86b4a92b924084d405dba796183da6635aa3e6730879b6cf9022d70df9142`；
PATCH为48656 bytes、SHA256
`352b2e6259ebe7359819229c23327709b911faafcf7abc581f43205a1f4e6a90`。
84实际Project commit为`18de6ac8ea55d11b3c51c8c5b9eb60d3de5c9d49`，
基线ff0b12c；补丁Artifact为`79dd7d7f7de5b1ff964a03cb58eac1549a7a3458`，
合同Artifact为`a5e534fb4ef4327d9224876ad8d9a6b679e8c5d6`，
这些身份不等于消费端commit。

逐页核对digest/offset，原始正文拼接后只JSON.parse一次，验证字节数与SHA，
阅读完整合同/实现/回归后`git apply --check`通过，采用五文件真实增量。
README/index与82新增段落无冲突；未强制覆盖、跨Task读取私有区或跨Task Git fetch。
84的实现、模块README、回归保持原始源码：

- `src/nativeAgent/projectGuidance/index.ts`：SHA256
  `fde0c513356279848ff7fa7dd9b0b1a5f74dc8a012347fa4bc7b26169d6bff5e`，
  blob `aa974c9c8bb6946fc407e58f9cd9bfbeee18bb8e`。
- `src/nativeAgent/projectGuidance/README.md`：SHA256
  `144280608441abe6d304c992edf9aa881f84a3151542a120d38db9ac8726eed1`，
  blob `2d3d725b0920c6885abdc1f26c2d37ecf11385dc`。
- `test/core/native-agent-guidance.test.js`：SHA256
  `a3b73983e25a9c0371de4cd3af189b607b3fe413949e0b888e7527be351c0377`，
  blob `f6e13b95384a0e6bad743683f7d28e760269ecd9`。

消费端每次ExecutionOwner录制工厂取`recording.lastReceipt.sessionId`，
为本Turn创建guidance及唯一ToolExecutor；不从可变UI选择绑定身份。
84的source实际进入ContextBuilder，required/source/revision保留：
内建coding-guidance进入system，项目材料进入user，Skill按需完整加载，
每Turn重新创建激活状态；MEMORY始终是`.agents/MEMORY.md`，不是历史副本。
普通项目工具通过现有ToolEnvironment/ToolPermission公共能力组合；
它们的资源value为空，不获得编码lease。编码调用原样转交同一82工厂的
acquire/permission/execute/release，不注入其私有定义，不复制或弱化其策略。
project_memory的read与replace/delete分别授权；写操作只认本次
`--allow-memory-write`，不认通用allow-write、工具名、配置、环境或保存历史。
普通编码工具独立授权仍可编辑root下文件，这不是MEMORY文件的ACL或OS沙箱。

先加入真实CLI回归，在旧入口因未声明project_context得到provider_error而失败；
真实接线后聚焦三个文件16项全部通过，约3.09秒。
新场景经本地HTTP+真实ModelGateway/Agent/上下文/工具/SQLite/入口验证：
初始Skill只有metadata、请求后完整正文进入下一步user材料、项目伪造role及
allowed-tools不提升system/command、required来源与revision可查；
通用allow-write不能写MEMORY，明确授权实际写入、读取取得指纹，
同ID新进程恢复默认拒绝delete，重新明确授权才实际删除；
100字节预算阻止模型请求，失败终态仍有真实ready回执。
82原读/edit/精确command/env/脱敏/保存/close/resume回归仍通过。
生产者自身回归另覆盖Session/Turn隔离、子目录覆盖、完整reference、记忆刷新与
陈旧指纹、路径/软链/大小和损坏失败；没有用其直接调用例子替代消费端接线。

最终`npm test`（含build）575项，568通过、7跳过、0失败，
测试阶段8.13秒；test:core同脚本未重复执行。组装/dry-pack/结构检查553文件通过，
实际包含`dist/nativeAgent/projectGuidance/index.js`和`dist/nativeAgent/product/tools.js`。
原有runtime package smoke通过：Doctor原生依赖检查409ms，
重开/跟进7.65秒，handover 2.68秒。源码与包内新版离线样例都通过，
仅模型网络替换为本地HTTP；样例采用真实模块完成82原路径，再验证完整Skill、
MEMORY默认拒绝/明确写入/恢复授权归零，不创建控制面Home。
日志为运行时TMPDIR的`task80-core-run6.log`、`task80-package-run6.log`，
清单为`task80-package-inventory-run6.json`。

完整消费增量和生产模块自审、`git diff --check`及原补丁反向`--check`通过；
82原实现和回归blob仍分别为`79927fba8b0423535836866ba2979d0db376d703`、
`a86bb8b062f1b49db148b92d40786303542fb218`。
fixture teardown在首次CLI之前注册，进程/HTTP/SQLite/资源均结算，
本轮相关fixture目录前缀残留为空；包装smoke只停止其精确fixture Controller/tmux。
删除可由message-20重取的临时原始交接文件；本轮自有npm cache从checkout移入
运行时TMPDIR的`task80-npm-cache-run6`保留供回收，未强制删除。
保留可重建本地包、构建产物和日志；无远端写入或发布，message-15条件未触发。

当前81仍只有验收/已请求交接的通知，没有合法完整源码payload；
不伪造catalog或cwd元数据，不重等其Review。新进程持久发现/选择和原会话目录核对
仍不能声明完成；需合法81交接后做真实接线及最后联合路径。
本轮是Worker消费实现与自审，不是Task接受或最终联合完成。
未运行真实模型/付费API/共享或生产资源，不证明真实规划质量、强OS沙箱、
敌对并发文件系统或其他平台行为。

## run-7：采用81真实持久目录、命名与有界历史

日期：2026-10-05。消费基线为
`ad2bd9e064460862fa9cde3619360e823a621c1b`，保留82/84已有接线。
按manifest加载并核对task-80/run-7、snapshot-7 digest
`dcec2973292acad17a063f7a79b67ac4b9876c4a78f51ec66159511c63ae2e8b`；
原work-item-1、worker写域project-1和Develop工作区未改变。
实际派工message-23授权消费message-22的完整交接，并明确原root/cwd由81后续扩展，
不得由80造字段/sidecar/第二账本，不扩大远端或真实资源权限。

message-22共24页，source digest
`afd0d281d66c327e7b47bb65f61cd5b5a6b2e314dc7b01b3a0d92dd28ef69e22`。
逐页核对source/digest/offset、完整拼接96488字符后JSON.parse一次，
保留原始LF及终结换行；三个payload验证：

- GUIDE：9024 UTF-8 bytes，SHA256
  `f7afdaaca0c055753c616854605322399d3f3bafaff88197ea48ace04fbfc865`。
- CONTRACT：27860 bytes，SHA256
  `dcbe6990e5060a79517849fcd966bba42329ad51d27fd6071adb70185c3f868e`。
- PATCH：71656 bytes，SHA256
  `b696ff8c457b458d46f8dd3fe1b4ea1d1170dfbce0bfd02fefcb0075baf424ac`。

81实际Project commit为`288f46714921d94c5c4b5b4683f46737fec3659d`，
基线`ff0b12cfe6c521ea3087d8dcd4d47f6d9a6b4f10`。
GUIDE Artifact为`1a18e7c7f76f5bfb51aebf210764142010feef2f`，
CONTRACT Artifact为`17391d307a108bce2c2f977f37b41d1ecc499af8`，
PATCH Artifact为`5d8b6d506fec03fc27807610c695385f3ee226e2`；
均不同于消费者提交身份。完整读合同、相关源码和回归；
在自身干净HEAD执行`git apply --check`通过后采用十二文件增量，
相邻index/README保留82/84。没有跨读私有目录、跨Task fetch或强制覆盖。
消费者另纠正README中“81提供cwd事实”的旧描述，没有修改81存储/API来抢做位置扩展。

采用的生产模块blob（与完整补丁对应，不是消费者补写实现）：

| 路径（相对src/nativeAgent/session） | blob |
| --- | --- |
| contracts.ts | `be43da95d04511b9c2475012e4c0435b66b6f29e` |
| backends.ts | `b01dabf22d254f745d28f9db7f35d97bdec45484` |
| catalog.ts | `02b75bcfc6aedcf1c7472734fc3a0d372e034bc7` |
| sqliteFormat.ts | `8b86e28d8703e4db9919265578f1191b5d0ec181` |
| store.ts | `00d5742d34a5c0fd5897717827034b68bf540b88` |
| index.ts | `78e28a3c08489fe822cd7397fac0ab22b73121b5` |
| catalogDemo.ts | `3804ff99e770a4002aece45ea56285668b5f2c53` |

生产目录回归blob为`3b23095f4ffa045bfa88c018b0f93bcef1fbd927`，
更新的session回归blob为`e43c0245a4c32c51b4a1c0bf0a07c49554ca3a15`。
82 localSafety和84 projectGuidance实现blob仍分别为
`79927fba8b0423535836866ba2979d0db376d703`、
`aa974c9c8bb6946fc407e58f9cd9bfbeee18bb8e`。

入口增加`sessions/session-info/rename/history`四个独立目录命令，
只打开明确现有状态库，无模型/cwd/工具配置依赖，不创建Agent或owner。
missing不会新建库，读失败不伪造空页；合法旧库仍走81真实NAS1布局迁移，
不声称目录打开绝不写数据库。命名严格使用metadataRevision CAS；
元数据异常保留unknown、精确Session ID和不盲重试的对账建议，原始cause不输出。
当前已知凭据保护可通过显式引用启用，不猜测任意历史秘密。

行式UI显式注入公共SessionCatalog，`/sessions`与`/history`使用opaque cursor，
`/info`读取详情，`/rename REV JSON_TITLE_OR_NULL`改名；
未注入catalog的既有消费者仍沿用其原offset显示合同。`/new`沿用owner创建事实，
再由同一store保存标题；命名失败保留已创建事实，不重复创建。
同一个store同时供catalog与唯一owner；submit仍load完整历史和recorder admission，
历史页不作为执行上下文，查询/标题/游标不改变恢复限制或本次权限。
没有改写唯一kernel/ExecutionOwner/82策略/84指导或引入第二执行器与账本。

先加真实CLI回归，旧入口因不认识rename而失败。接线后一次中间失败是fixture
遗漏Step前user消息，真实存储按既有合同拒绝；补齐正确事实顺序，未放宽生产协议。
聚焦product/catalog/migration/guidance/local-safety/interaction六文件29项全通过，
约4.94秒，其中新增目录场景约1.75秒。场景创建两个真实Session后关闭进程，
新进程同名标题按不同ID发现、详情/有界历史/命名CAS、目录和历史游标分别失效、
明确刷新首屏、UI实际目录/详情/历史/改名及指定ID续聊。
只替换模型网络；目录/改名/UI没有增加模型请求，命名不改历史digest，
真正续聊传入原完整历史、回执增长并保持只读及MEMORY授权归零；
未知效果历史可读，执行前拒绝且没有请求模型，不伪造live状态或重放。
82原读/edit/精确command/save/close/resume与84 required/Skill/权限回归保留。
临时检查另确认missing目录不创建state/Home、元数据unknown诊断保留精确目标
而不输出原始cause；这是诊断映射检查，不冒称实际I/O丢确认的CLI验证。

最终`npm test`（含build）579项，572通过、7跳过、0失败，
测试阶段8.06秒；test:core同脚本未重复。组装/dry-pack/结构检查558文件通过；
原有runtime package smoke通过：Doctor原生依赖413ms，重开/跟进7.67秒、
handover 2.70秒。源码和组装包内新版`docs/examples/agent-offline.mjs`都通过，
除82/84路径外新增真实持久分页发现、重复命名按ID选择、元数据改名、有界历史、
失效游标明确刷新。样例没有伪造root/cwd元数据或用单页历史续聊。
日志为运行时TMPDIR的`task80-core-run7.log`、`task80-package-run7.log`，
清单为`task80-package-inventory-run7.json`。

完整生产/消费差异自审、`git diff --check`和完整补丁反向`--check`通过。
各fixture在首次CLI前有teardown，所有自有进程/HTTP/SQLite结算；
相关目录前缀残留为空，package smoke只清理其精确Controller/tmux。
临时原文可由message-22恢复，验证后删除；npm cache保留在运行时TMPDIR的
`task80-npm-cache-run7`供回收，保留日志/清单/可重建本地包。
没有push/PR/merge/版本/tag/npm发布/全局安装/Home或模型设置变更/归档。

未满足的产品路径仍是原root/cwd持久化和新进程自动恢复正确位置。
Leader已将精确需求交Operator路由81；80不猜补、不改其合同抢做。
位置不是grant，未来收到实际增量后须验证显式位置冲突拒绝、legacy缺失不猜补，
并继续同一work-item-1做真实新进程联合路径。当前结果是Worker实现/自审，
还需独立Review，不接受WorkItem或声称整批最终完成。
未运行真实模型/付费/共享/生产资源，也不证明规划质量、硬件掉电或强OS沙箱。

## run-8：真实原子位置增量与最终产品恢复接线

2026-10-05继续同一work-item-1，消费Leader message-27及Operator message-26，
不重放run-7。精确AgentRun为task-80/run-8，snapshot=context-snapshot-8，
digest=0825e5255dbee9c1470d5a829f01e7cafd1865059c92f539f8139f243084433c。
本节更新前节历史上的位置缺口；旧验证记录及其当时的未覆盖声明不删除。
消费基线为自己的ccb32b3885b581b7fae85ca50afd3aff41cf9104；
生产者源为6dae2d3b84f88e6d39482e8e954d94b086884136，
位置增量基线288f46714921d94c5c4b5b4683f46737fec3659d，并非ff0完整包。

仅通过合法本Task CLI按contentPage顺序读取message-26：
source=task:task-80/message/message-26，
message digest=9ca465ccc15db45f5addf11b2dc91610a2ef09147f84d867cb1ad1cf367030e5。
每页校验source/digest/offset，拼接101350字符后只解析一次原JSON；
从BEGIN_TASK81_LOCATION_*到对应END提取原文，保留终结LF。
三份载荷全文核验如下，没有跨读或fetch生产者私有区：

- GUIDE：9463 UTF-8 bytes；
  SHA256=9dba44590061756d13ec3e9e8d58266b406a07acea4ee49102616fd3e66c56d1；
  git:f0c04106e501296e71fb2a23308bcc6262dbf790:handoff/task81-location-transfer-guide.md。
- CONTRACT：47107 UTF-8 bytes；
  SHA256=09f3a5c11629d8f4bfbbeaa50265f57c7163aaecf2a102eb93b567ad72b9831d；
  git:b1c07ef0914994f7146c990883e8fc44624f37a5:handoff/task81-location-public-contract.md。
- PATCH：56178 UTF-8 bytes；
  SHA256=b19b4c63ba7d12e41149da641eb272324fd3caf4f0d5b96488c2db8b85849553；
  git:9ecfa2649c61088ca68098cd93b8ad1c7fc5e446:handoff/task81-288f467-to-6dae2d3.patch。

干净ccb基线的完整增量git apply --check通过，实际采用12文件生产者变化，
并以反向--check确认采用后源改动完整保留。共享nativeAgent/index只扩充
SessionLocation/locationLimits导出，既有82/84导出不覆盖。
以下生产者文件与GUIDE逐文件SHA256一致，Git blob为：

```text
093d830f2d3d436f36d296606bf8b4afdb3aae45 src/nativeAgent/session/backends.ts
2702b35c23b5d1c22f6e6ccc5225436be1fc527e src/nativeAgent/session/contracts.ts
05ad12694f71ae4e3d7eb49d7a8170d3ceb528da src/nativeAgent/session/index.ts
114905fef3df3597d683cc6e4c137483b9a827f6 src/nativeAgent/session/location.ts
48045e7be6ad6cab095979557234390996ca4ed3 src/nativeAgent/session/sqliteFormat.ts
131fec80093497a3daa8a547ec8d63ed39cc01da src/nativeAgent/session/store.ts
efb28f4ea0912ce8f96547840c6e8122bc3110eb src/nativeAgent/session/catalogDemo.ts
82ba75e7c8abec4755f9c7991acc24f8ef0dda95 src/nativeAgent/session/README.md
415fcab0f507b1d00493eb74c064d09a6f47ea11 test/core/native-agent-session-catalog.test.js
60fa3afcc46f57ba56d14da942ae6865f50f3983 test/core/native-agent-session-location.test.js
185d1b793470afa447189fbc42151f0234992fa5 test/core/native-agent-session-migration.test.js
```

82 localSafety.ts blob仍为79927fba8b0423535836866ba2979d0db376d703，
84 projectGuidance/index.ts仍为aa974c9c8bb6946fc407e58f9cd9bfbeee18bb8e；
不复制生产者实现，不修改其安全/项目指导合同。NAS1布局4沿81集中迁移链，
独立Agent文档仍为2，Yui控制面存储没有变化。

80消费接线：root独立配置，CLI/env/file明确来源保留，新建默认root=cwd。
入口检查实际目录存在性、规范化、所有祖先无软链与cwd在root内。
恢复先读同ID有界location，省略值取原事实，显式冲突拒绝；
legacy null位置不能补猜或后写。唯一owner.create兼容贯通可选location，
继续由owner生成一个ID和调用同一store原子create；initial run/start与/new均接通。
每个Turn的异步agent工厂按recording.lastReceipt.sessionId读真实位置，
重新验证并创建真实82 binding及84 guidance；新异步边界在owner关闭后不承认执行。
UI同位置/use可执行，跨位置/use拒绝并保留当前选择，提示结算关闭后明确重开。
没有第二位置表、runner、执行调度器或新授权恢复机制。

创建确认丢失：原SessionSaveError的ID和unknown保留，产品一次性读取同ID
getSessionInfo和load核对位置/空文档/回执/ready；即使确认也停止本次尝试，
只指引明确重开该ID，不自动重建、换ID或执行。未确认或读取失败仍未知。
JSON错误和UI错误文字均保留恢复所需ID，不输出credential、标题或原始cause。
输入Session ID含已知凭据时在读取/诊断前拒绝。

验证全部使用Node v24.20.0 PATH与绝对本地launcher；模型只用loopback HTTP
假响应及dummy凭据，其余正常路径的存储、工具、权限、指导与owner均为实际实现。
风险驱动测试先证实旧入口不支持--root（预期配置失败），再修改消费接线。
两份新产品回归保护：
root!=cwd及跨launch目录恢复，原child AGENTS以user材料到模型；
CLI/env/file冲突、legacy缺失、目录不存在/非目录/越界/软链拒绝；
UI/new原子位置，跨位置/use不丢选择，同位置/use提交到准确所选ID而不修改启动ID；
未知创建确认仅注入真实SQLite事务提交后的异常，随后真实同ID详情/load，
一个create、两个有界对账操作、零Agent执行，真关闭重开仍只发现原一个Session。
该故障检查是产品使用的同一createProductSession/ExecutionOwner/Store路径，
不是人为给正常路径替代存储，也不是通过CLI注入一个测试专用生产开关。
取消、EOF关闭、目录零执行、CAS、bounded history、required/Skill/MEMORY、
unknown拒绝回归保留；unknown产品fixture现在带真实位置，避免只被legacy守卫挡住。

实际命令：

```sh
npm run build
node --test test/core/native-agent-product.test.js test/core/native-agent-session-location.test.js test/core/native-agent-session-catalog.test.js test/core/native-agent-composition.test.js
node --test --test-name-pattern='product restores immutable|product reconciles lost' test/core/native-agent-product.test.js
npm test
node docs/examples/agent-offline.mjs
node scripts/assemble-runtime-package.mjs --output output/task80-runtime-package
# 在output/task80-runtime-package目录执行dry-pack：
npm pack --dry-run --ignore-scripts --json --cache "$TMPDIR/task80-npm-cache-run8"
node scripts/check-runtime-package-structure.mjs "$TMPDIR/task80-package-inventory-run8-assembled.json"
node scripts/smoke-runtime-package.mjs --assembled output/task80-runtime-package
node output/task80-runtime-package/docs/examples/agent-offline.mjs
```

完整core包含build：584项，577通过、7平台条件跳过、0失败，测试阶段约8秒。
组合针对性18/18，新的位置/确认丢失针对性2/2；后续UI身份加强另跑针对性。
组装包结构560文件通过；package smoke为Doctor 413ms、
重开/跟进7.63秒、handover 2.70秒，最后Runtime package smoke passed。
第一次dry-pack误在源码目录执行：dist/cli.js模式0644使结构检查失败；
纠正在实际组装包目录检查0755入口后通过，未修改源码或包装规则掩盖此失败。
源码和包内离线样例都通过真实read→明确edit→精确授权command→answer→保存关闭，
新进程持久目录发现/ID选择、不同launch cwd下恢复原root!=cwd及新命令授权继续；
同时保留Skill完整加载、MEMORY独立授权、重复标题、分页、CAS和失效cursor检查。
样例输出originalRootCwdRestoredAcrossLaunchDirectories/rootDiffersFromCwd/
freshCommandAuthorizationAfterCatalogSelection均为true。

完整增量/受影响消费合同自审、源文件SHA/blob、git diff --check与反向补丁检查通过。
核心日志task80-core-run8.log及task80-core-run8-final.log、
包日志task80-package-run8.log、成功清单task80-package-inventory-run8-assembled.json
及失败源清单task80-package-inventory-run8.json保存在运行时TMPDIR。
fixture首次CLI前注册teardown，进程/HTTP/store全部关闭，
本轮相关fixture前缀检查无残留；package smoke负责自己的精确Controller/tmux。
临时三份载荷核验后删除，可由固定message-26重建；
task80-npm-cache-run8保留供回收，固定日志与可重建本地包保留。

本轮已补齐位置产品路径，没有因未获81成果继续等待。
这是Worker实现、自审和本地离线证据，之后仍需Leader Candidate/Integration和独立Review，
未声明WorkItem接受、Task或整批完成。没有远端push/PR/CI/merge、发布/tag/npm、
归档、全局安装/Home/Controller、角色模型/Profile或权限变更；
未跑真实模型/账号/付费/共享生产，不证明模型规划质量、硬件掉电、敌对路径替换、
跨OS搬迁、强沙箱或其他平台。生产者独立验收与80消费证据严格区分。

## Run-12：修复独立Review的两项P2

日期：2026-10-05；修复基线及reviewBaseCommit：
`7bd1df81b02c13217444ea2983d7abef15dd1a8c`。原candidate-1被
review-round-1拒绝，原提交已在Task main但不等于通过验收；本轮不回滚或改写它。
仍在同一隔离work-item-1分支工作，无新执行者或交付单元。

本轮先完整读取Session Manifest、yui-runtime/yui-worker Role Skills与worker
profile，再经Manifest的Node24全局CLI合法入口读取
`yui task run context task-80/run-12 --json`。task/run/worker/execution及工作区匹配，
固定snapshot为context-snapshot-12，digest：
`f8a4029b128cf32361f42b618475096207bd422f3acee07b7be061b545e3fb13`。
完整展开work-item-1 revision 5、message-35和message-30。
message-35把run-9/review-round-1原始审查完整合法转交（digest：
`867c74cc6d420bf5d70c79f7ab3f8edf1bc74473d1e5449a658dfde32dd1f859`），
并撤销原先必须直接读取message-29/run-9的前置要求。
run-10/run-11因这些旧引用无法合法展开而停止的事实保留；本轮按新授权解除阻塞，
不绕过CLI身份、读取已移除reviewer工作区或操作其他Home。

两项实质问题与修复：

- P2-1：旧turn_ended回放调用当前owner.settle，挂起模型时串行UI无法继续处理
  cancel/quit/EOF。沿用唯一owner已有completed证据，增加精确scope的非阻塞
  getSettledEvidence查询；回放不加入当前执行Promise。只有精确Turn已结算、
  记录成功且无failure，并与当前SQLite的digest/revision相符才展示回执。
  关闭路径仍由owner.close取消/drain后真正settle，核对digest/revision。
  无第二receipt账本、执行循环、重试或历史结果重构。
- P2-2：模型只有泛化command工具声明，不知道实际位置或已审查argv。
  每个Turn按实际recording Session位置与当前82绑定建立最小product-runtime
  ContextSource：root/cwd、当前所选工具、独立授权开关、当前可执行的精确
  executable/argv/effect。通过既有ContextBuilder作为required user数据材料，
  带内容revision与ContextReport；不足预算拒绝请求。没有环境值/凭据/权限token，
  不提升参数为system指令、不写回历史、不恢复旧授权，不改变82执行校验或84信任层。

按develop-yui、engineering-quality、test-driven-development先复现再修复。
新回归在旧实现上实际RED：历史refresh后的cancel超时；模型请求缺少运行事实。
修复后首次命令fixture错误地使用gateway不提供的tool.name识别结果，导致重复
调用耗尽步骤预算；按真实Chat Completions的tool_call_id及当前普通用户输入
识别结果后通过，没有修改网关或增加生产兼容逻辑来迁就fixture。
最终两项针对性GREEN约1.12秒；完整core中分别约914ms与867ms。

永久回归只替换模型HTTP响应，其余均走实际产品入口、owner、SQLite、ContextBuilder、
82精确命令执行与84指导。历史completed后再挂起真实HTTP body，分别验证refresh→
cancel/quit/EOF无需fixture完成响应即可关闭，真实库末尾cancelled且ready，
唯一显示回执与最终库digest/revision一致，没有旧/早回执或无匹配取消。
空合法root内的命令完全从实际模型请求选择，不在响应fixture预置executable/argv/cwd；
同ID从不同launch cwd恢复原root!=cwd，本次更换规格后真实执行新argv；
再次无授权重开时当前commands为空且三个开关均false。模型请求中没有dummy凭据
或命令环境值，仅有84的一个system材料，运行事实材料不在持久消息历史。

源码及包内离线样例同样改为从当前HTTP模型请求选择已审查命令；原本故意重放旧
命令的负例仍保留并确认本次没有command授权。位置、Skill完整按需加载、MEMORY
独立授权、持久目录/分页/重名ID/CAS/stale cursor路径没有缩减或被fixture替代。

实际验证（所有开发命令显式Node v24.20.0 PATH；CLI用绝对本地launcher及独立Home）：

```sh
npm run build
node --test --test-name-pattern='product historical refresh|product model receives' test/core/native-agent-product.test.js
npm test
node docs/examples/agent-offline.mjs
node scripts/assemble-runtime-package.mjs --output output/task80-runtime-package
# 以下dry-pack在实际output/task80-runtime-package目录执行：
npm pack --dry-run --ignore-scripts --json --cache "$TMPDIR/task80-npm-cache-run12"
node scripts/check-runtime-package-structure.mjs "$TMPDIR/task80-package-inventory-run12.json"
node scripts/smoke-runtime-package.mjs --assembled output/task80-runtime-package
node output/task80-runtime-package/docs/examples/agent-offline.mjs
git diff --check
```

完整core含build：586项，579通过、7项平台条件跳过、0失败；
测试阶段9042ms，新增两项回归约增加一秒的针对性成本。
组装包结构561文件通过；Doctor 414ms，重开/跟进7671ms、handover2695ms，
最终Runtime package smoke passed。源码与包内样例全部断言通过，
commandChosenFromCurrentModelRequest为true。不把假模型响应当作真实模型能力验证。

完整最终差异/公开owner接口/模型材料预算与信任层/关闭资源自审通过。
kernel、model、ToolManager、81 Session实现、82和84生产者文件均无修改；
82 blob仍为79927fba8b0423535836866ba2979d0db376d703，
84 blob仍为aa974c9c8bb6946fc407e58f9cd9bfbeee18bb8e，
81 location blob仍为114905fef3df3597d683cc6e4c137483b9a827f6。
没有持久schema/版本变化。已保存日志位于本Session运行时TMPDIR：
task80-core-run12.log、task80-package-run12.log、
task80-example-run12-source.log、task80-example-run12-package.log及
task80-package-inventory-run12.json；task80-npm-cache-run12和可重建组装包保留。
fixture teardown在首次CLI前登记，成功/失败均关闭自有子进程、HTTP/store；
package smoke完成自己的Controller/tmux清理。最终相关fixture目录与进程检查无残留，
未创建临时探索harness、未清理共享目录或其他Home。

本轮是Worker修复、自审和离线验证证据，待Leader冻结新Candidate/Integration及
独立Review；不声明WorkItem接受、Task/整批完成或外部交付。
未push/PR/CI/merge/publish/tag/npm、归档、全局安装/Home/Controller替换、
角色模型/Profile或权限变更；未跑真实模型、真实账号/付费/共享生产。

## 2026-10-08：同结果远端交付前的上游整合

原本地接受 `d9c671e6d7da38ab5da7d89690adc4948edff1ad` 及两轮独立
Review 保留。本轮依 Task80 message-38/message-15 续办同一结果，
不是新功能验收，也不代交付其他 Task。

通过正式 `task base status --refresh` 确认实际上游
`f3c4b1e9e781ccf43d01af286a89f9f4ef561e49`，再经
`task upstream integrate` / `integration-3` 的逐次冲突继续和 CAS，
生成 Task-main `25c7a6737654333db0d2e2a9b469d84174508feb`。
冲突解决保留上游 Context 容量/压缩导出、Session 布局4及原子位置、
ExecutionOwner 手动压缩，同时保留产品异步位置准入和精确 Turn
非阻塞结算查询。相对上游，Session、localSafety、context、model、
executor 和 commands 目录没有差异。controlPlaneCli 相对上游 cli
仅增加原公开 cli.js 入口身份并替换五处入口路径；不撤回上游修复。

明确使用 `/data00/home/zhangqian.0326/.nvm/versions/node/v24.20.0/bin`
选择 Node 24.20.0，实际执行：

```sh
make install-local
npm test
node scripts/assemble-runtime-package.mjs --output output/task80-package
node docs/examples/agent-offline.mjs
node scripts/smoke-runtime-package.mjs --assembled output/task80-package
node output/task80-package/docs/examples/agent-offline.mjs
git diff --check
```

结果：core 621项，614通过、7跳过、0失败，测试阶段9592ms。
源码及包内样例所有断言通过，包括跨启动目录恢复原root/cwd、按同ID
发现续聊、独立写入/MEMORY/精确命令授权、从实际请求选择命令和持久
回执核对；controlHomeCreated=false。包smoke通过：Doctor 413ms、
reopen/follow-up 7691ms、handover 2674ms。检查使用已有自有fixture
及其finally teardown，没有调用真实模型或全局Controller。

首次 `make install-local` 误选系统Node18，已按精确进程身份终止该次
依赖安装；首次Node24重装遇到缺失node-pty安装脚本，确认旧进程已结束
后重装和构建成功。这两次失败不计为通过。无全局安装或运行配置修改。

这是新整合树的Leader自检证据；新独立冻结Review及候选接受仍待完成，
不以旧树验证替代新树接受，不声明PR/CI/merge已完成。真实模型质量、
其他平台本地运行、硬件掉电和强沙箱仍未验证。

## 2026-10-08：PR403 干净检出测试入口修复

冻结 `14e3355d9d6b7afd35e9ab63620248c9a3ca4c2b` 的独立
Review（run-14/message-39）无实质 P1/P2，41项针对性测试通过。
但实际 CI run `37666104342` 在干净检出中失败：`test:core` 仅构建
dist，没有先生成 `output/dev/bin/yui`，10项产品测试均在 spawn
时 ENOENT。Linux Node24 为604通过、10失败、7跳过；macOS Intel
日志也确认同一原因。没有将本地通过等同于 CI 通过，没有执行合并。

修复仅在产品测试的 before hook 复用 `installDevLauncher()`，创建
同一个 checkout 正式 launcher；不初始化控制面 Home、不改产品行为、
不改 CI 门槛、超时或断言。移走原 launcher 后执行11项产品测试全部
通过（7838ms），生成文件与原文件 cmp 一致，移走的备份已删除；
各产品 fixture 继续显式独立 Home 和 teardown。
Node24.20.0 的 `npm run test:core`（含重新构建）621项中614通过、
7跳过、0失败（9563ms）。真实模型、全局安装和 Home 均未使用。
新候选的远端 CI 与正常合并仍待完成；原 PR403 保留，不创建重复 PR。
