<p align="right"><a href="./capabilities-and-resources.md">English</a> | <strong>简体中文</strong></p>

# 能力、资源与 Surface

## 唯一入口与原始事实

Controller 承载 CapabilityRegistry 和 InstanceHost。`capability search`、
`describe`、`call` 使用同一认证入口，先解析当前 Session 身份和 Task 范围，
再检查能力与资源权限。输入中的 actor 或自称的 user scope 不能授予权限。

描述符包含名称、合同版本、Provider、scope、输入输出 schema、effect 和
requiredPermissions。查询只展示获授权的目录；同名 Provider 或版本有歧义时，
调用者明确选择，不按加载顺序决定。Schema 是有界方言，未知关键词拒绝。

当前目录覆盖 context、message、artifact、environment、resource、project、
plugin 和部分 task/job 操作。Task 生命周期与部分 CLI/Web 写入直接共享
领域命令；这些不是另一份业务状态，也不假称已经通过 Registry 执行。

## 效果与操作事实

能力返回值与真实效果分开。一次调用即使输出校验失败，也可能已产生确认的
子操作；返回结果必须保留原 owner 的 operationRef 和 receipt。Unknown
不能解释为未执行，不进行自动 fallback。

嵌套调用重新检查当前权限，不能扩大父调用声明的权限与效果。requestId 标识
调用，不自动提供所有业务的通用幂等性；Job 等 owner 执行自己的精确幂等合同。
错误后先读取原操作事实再决定下一步。

## 实现实例

InstanceHost 管理 attach、acquire、release、detach 与实际引用。替换发布后，
新调用选择新实现；已有引用继续绑定原实现，排空后才能 dispose。查询是观察，
不启动或恢复代码。清理失败保留诊断，不把新发布反转为失败，也不伪造排空。

Session 的长引用由实际 AgentHost 固定到所加载实现。Controller 传递已有 pin，
不把活 Session 静默搬到另一份代码。结束客户端与共享 Provider 物理静止分别判断。

## Project 与工作区

Project 保存参考 checkout、Knowledge 与资源引用。稳定 checkout 只读；Task
交付发生在受管 worktree。多 Project Task 使用独立 Git 根和明确写范围。
工作区 owner 属于 Task、WorkItem、ReviewRound 或 IntegrationAttempt。
Role 仅选择执行配置，不独立拥有另一份工作区状态。

Git 集成捕获精确 ChangeSet，在候选 worktree 检查后 CAS 推进目标。
冲突、检查失败、目标移动与拒绝都不更新目标，Agent 决定下一次操作。

## Artifact 与环境

- `artifact.save/read/list` 在 Task 自有的本地专用 Git 仓库中维护文件/目录交付物
  （完整方案、原型、图表、报告）。`save` 写入 `relativePath` 并只提交该路径，
  返回自证的 `commit + relativePath` 引用；`read` 解析 HEAD 或固定 commit 以取冻结证据；
  `list` 为普通当前读取。Reference 不等于固定交付成果；最终结果不能选择缺失或跨 Task Artifact。
- `environment.prepare` 准备 empty、scratch 或获授权 local 目录，不自动采用。
- `environment.adopt` 复核身份、资源意图、权限与冲突后保存所有权。
- `environment.bind` 选择 Role 下一次原生执行环境；`null` 返回 managed workspace。
- `environment.release` 检查真实引用和静止证据，不删除用户目录。

Adopted native launch 保留目录身份、access、isolation 与 preparation 引用，
在 launch、resume 和 Yui 输入边界复核。撤权不能靠新 grant 静默重新采用旧环境。
Read-only 环境的支持取决于实现；不能将目录 access 标签视为通用 OS 沙箱。

## 插件与自扩展

Task Leader 或 global Operator 可以管理该 Task 的插件；Worker/Reviewer 不能
自行管理或授信。声明式插件不执行任意代码；trusted-local 插件执行还需要精确
源码或产物摘要、环境和阶段的 grant。

Store 保存 enabled 意图及验证产物，Host 保存实际实例。重启后 enabled 仍可读，
actual 可以为空，必须显式激活。原 Task 可以发现并调用新能力，不必修改自身
原生工具 schema。业务结果应保存为 Artifact，而不是依赖插件继续存活。

完整作者、授权及失败合同见[插件 SDK](../plugin-sdk.zh-CN.md)。

## CLI 与 Web

Surface contribution 由 Registry 当前获授权目录派生，没有第二份目录或 Host。
CLI contribution 使用能力原名称。Web panel 只接受受控 text、HTTP(S) link 或
JSON query 描述，不接受作者脚本或任意 HTML。

Web listener 由 Controller 启停，仅允许 loopback。浏览器写入通过现有领域
事务，错误区分确定未提交与提交结果未知。查询面板不能借浏览器身份执行 mutation
或插件管理。终端连接只 attach 客户端，不接管原生对话的持久所有权。
