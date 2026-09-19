<p align="right"><a href="./sqlite-control-plane-design.md">English</a> | <strong>简体中文</strong></p>

# SQLite 控制面存储

Yui 唯一的权威产品 Store 是 WAL 模式的 `YUI_HOME/yui.db`。
`storage_schema` 单行记录唯一的**主版本.小版本**与 Schema 摘要；
1.0.0-alpha 软件包引入的纯净基线为 **1.0**。

## 权威

SQLite 拥有 Task、WorkItem、AgentRun、Message、Decision、结果、Project
Knowledge、工作区、运行绑定、mailbox、事件及配置。Provider Session、
transcript、进程、缓存和 telemetry 服务于执行诊断，不替代持久 Task 真相。
记录的 `schemaVersion` 仅校验当前格式，不构成独立升级轴。
`storage_migration_archive` 保留不透明原始负载和二进制审计证据，
不是旧格式读取器、调度器或缓存。

## 准入

普通打开要求精确的当前格式、版本、摘要、物理结构与类型化记录。
非空 Home 缺少数据库或版本身份时拒绝初始化。新 Home 一次创建最终 DDL，
不重放旧迁移。写入、普通读取、Context 分页及全 Home 诊断共享当前校验器；
无效记录只报错，不规范化修复；失败写入不推进 revision。
已打开的写连接在每次修改前重查它捕获的 Schema 身份。

## 写入与并发合同

每次修改是 SQLite 事务，WAL 和 `synchronous=FULL` 保护持久提交。
`home_meta.revision` 是 Home 范围的 CAS/revision，不是格式版本。
索引列支持精确查询，完整且经过校验的负载仍是领域表示。
mailbox 认领、精确 Run 终结、活动指针移除、结果持久化及下游通知，
在构成同一产品事实时一并提交。幂等键和唯一约束保护外部效果，
不另建规划协议。

## AgentRun 与 Session 边界

AgentRun 记录显式执行请求、可见输入和原始结果，不记录隐藏推理。
一个原生 Session 可以包含多个 Run 和普通对话。通知本身不创建 Run，
只有精确原生证据才能结算；WorkItem、Task 的验收仍由 Agent 判断。

## 更新行为

版本 API 返回 `"1.0"` 字符串，不用浮点数。默认 `upgrade/update`
只接受同一存储主版本内完整且连续的小版本路径；初始基线尚无升级步骤。
跨主版本和旧整数格式只由独立显式转换器处理，运行包没有回退。
updater 先检查精确暂存包，再在维护锁内重查；未知所有权始终阻塞。

独立旧 v37 转换、备份恢复、产物边界和冷启动流程见
[存储基线 1.0](./storage-baseline.zh-CN.md)。

## Home 布局

自管理数据位于规范 Home 内：Task worktree 在
`workspaces/tasks/<task>/<owner>/<project>`，Global scratch 在
`workspaces/global`，运行数据在 `runtime`，备份在 `backups`。
显式外部 Project 保留外部资源语义；只有受限长度的 IPC socket 可位于 Home 外。
一次性转换不搬迁工作区，也不改写 Git 身份。
