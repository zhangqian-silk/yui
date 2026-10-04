# Task 80 入口装配验证记录

日期：2026-10-04。基线：`ff0b12cfe6c521ea3087d8dcd4d47f6d9a6b4f10`。
工作单元：task-80/work-item-1，隔离Develop工作区；仅修改project-1。
本记录是Worker实现/自审证据，不是Task接受或最终联合验收。

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

授权上下文尚未提供81/82真实固定成果：

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
