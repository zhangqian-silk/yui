# 存储基线 1.0

Yui 1.0.0-alpha 是纯净运行基线。软件版本 `1.0.0-alpha`、Home 存储版本 `1.0`、
记录格式版本 `1`、Controller 协议版本 `1` 各有职责。后续 `1.0.0` 软件包
复用最终已验证的预发布存储契约，不再重置。首个 alpha 发布后如需修改
持久化契约，必须声明显式的小版本迁移。

## 当前运行包

- `storage_schema` 的单行记录是唯一存储版本权威，包含格式、主版本、小版本、
  Schema 摘要与创建时间。JSON 中版本采用 `"1.0"` 字符串，不用浮点数。
- 新 Home 一次创建最终 DDL，不执行旧 v1→v37 链。普通读取只校验当前身份、
  物理结构和类型化记录，不转换数据。
- 显式 `upgrade/update` 默认也只允许同主版本内连续的小版本升级。
  首个 `1.0` 尚无小版本升级步骤。跨主版本、降级、未知格式、旧整数版本
  都会在激活前拒绝；指定软件版本不等于授权跨存储主版本。
- Yui 自有记录格式从 1 开始。Host 控制采用独立的
  `yui-agent-host-control/v1`，不会误认历史 `yui-agent-host/v1`。
  原本为 v1 的 Context、Run、Host 事件和 Driver 协议保持 v1。
  外部 Provider 协议和依赖版本不重置。
- 业务 revision、授权 epoch、ID、事件序号、原生数据和冻结 Context
  不是 Schema 版本，不能重置。
- `storage_migration_archive` 只保留不透明审计证据，不解释旧格式来执行工作。
  其中的旧版本数字与原始字节保持不变。
- Candidate 的当前权威只有所属 WorkItem 的候选数组。基线不再创建无用的
  `work_item_candidates`、`coordination_locks` 表或废弃的 `idx_input_open` 索引。

运行 tarball 不包含历史迁移模块，也不包含独立转换器。旧 tag 和发布包用于
显式诊断，不构成运行时回退。

## 从 0.16.2 一次性转换

独立 `yui-baseline-cutover` 压缩包只接受精确的 0.16.2 结构和完整 v37 账本。
更旧 Home 必须先通过 0.16.2 升级；转换器本身不执行整条旧迁移链。
准入依据是精确的存储结构与账本，不是当前安装的软件版本号；
已经满足该 v37 契约的 Home 不需要为了改软件编号而重写数据。

本次尚未发布的 v37 → 1.0 转换同时要求每个当前 Run 都有首个 Context Snapshot
引用。含有缺失该证据的历史 Run 的 Home 在预检时拒绝，即使 Run 已结束。
保留该 Home，通过 0.16.2 审计，或另建新 Home。转换器不补造 Snapshot，也不把
被引用的 Run 移出当前表，避免破坏 Candidate、Review 和 Session 的持久引用。
这是对尚未发布的 1.0 基线收紧，不是对已发布 1.0 合同的静默改写。

1. 使用 0.16.2 结算活动 Run、Job、已认领通知、在途重试和未知外部效果。
   保留排队意图，不伪造完成。停止受管 Session 和 Controller。
   `session stop --all` 会拒绝忙碌 Session，不是强停或丢弃工作的授权。
2. 将已发布的 1.0.0-alpha 暂存在独立安装前缀中，安装所需原生依赖。
   不先覆盖全局 CLI，不让新 Controller 打开旧 Home。
3. 核验转换包校验和并解压，调用入口。以下路径均为**占位示例**：

```sh
node /absolute/converter/cli.mjs \
  --home /absolute/home --runtime /absolute/staged/package

node /absolute/converter/cli.mjs \
  --home /absolute/home --runtime /absolute/staged/package \
  --apply --backup-dir /absolute/new-backup-directory
```

`--runtime` 指包含 `package.json`、`dist/` 和可用依赖的软件包目录，
不是 `bin/yui`。默认仅检查。`--apply` 要求 Home 外一个不存在的新备份目录，
其父目录必须存在且为规范物理路径。从外部 Operator shell 执行，不在受管
Task 或正在转换的 Session 内执行。

工具拒绝活动持久执行、待应用 outbox、活动 Session、仍存活的登记进程、
可观测到引用此 Home/数据库的进程、待消费的原生 Inbox 文件，以及未完成的
Controller 交接或发现记录。登记所有者身份不可验证时仍阻塞；不会接管或
终止无关用户进程。也应停止非受管写入者及外部工作区编辑器：普通文件复制
不是文件系统快照。维护锁和 SQL 写事务保护实际转换。

变更前复制整个 Home，并生成带校验和的独立 SQLite 备份。转换只处理明确的
Yui 记录封装及活动类型化验证计划，将每个改写前的原始负载和旧账本保存在审计中。
用户文本、原生负载、冻结 Context、Git 数据、未提交文件、ID、计数和 Task
结果保持原样。
删除两张旧表之前，每一行原始内容都写入审计的
`baseline-v37/retired-table/<table>` 分类，不把其中的负载当作活动记录规范化。
回执以 `retiredRows` 单独报告归档行数。

旧 `active-release.json` 和 `runtime-identity.json` 归档到
`retired-runtime/`，不改写成新运行事实。工具不恢复旧 Host、不改全局安装、
不启动 Controller、不提交模型输入。转换成功后，再由暂存的 1.0.0-alpha CLI
安装精确版本并启动新运行环境；通过正常显式生命周期创建新 Session，
历史记录不代表活动授权。

声明的运行资源目录中的隔离所有者标记也会先验证旧摘要，再转换格式并重算
相应指纹，原文件保存在归档中。资源路径、namespace 和端口分配不变。
未知标记或符号链接直接阻塞，不猜测接管。

## 证据与恢复

成功结果为 `outcome: converted`、目标 `1.0` 及精确备份路径。
对有效新 Home 重复运行返回 `already-current`，不再次备份或改写。

- `backup/home/` 保留 Home 树；`backup/yui.db` 是一致的独立数据库快照；
  `receipt.json` 记录来源、目标、摘要及转换结果；`retired-runtime/` 保存旧绑定。
- 校验失败时回滚 SQL，并恢复本次移动的运行绑定。若恢复无法确认，错误会指出
  保留文件；Home 应继续保持停止。
- 崩溃或回执写入失败不证明数据库仍是旧版。先检查实际格式与备份，再选择恢复；
  没有自动修复 worker 或猜测性重放。
- 回滚前停止新写入者、另存失败或新 Home，再将旧 Home 树和独立 `yui.db`
  恢复到**原来的同一路径**，不能混入新 WAL/SHM。只使用 0.16.2；
  按精确进程身份检查快照中转换器自己的维护锁。
- 一旦新版产生业务写入，恢复旧备份会丢失这些新写入，必须明确处理，不能自动恢复。

真实 Home 转换和发布需要另外获得用户授权。隔离样本通过不等于生产 Home
已经满足转换条件。
