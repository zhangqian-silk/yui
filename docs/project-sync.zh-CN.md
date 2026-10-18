# 内置 Project 定时同步

Controller 在启动和既有 Schedule 核对周期中，为每个注册 Project 幂等维护
`project-sync-<project-id>` Job/Schedule。没有第二定时器；正常执行不创建
Task、Session，也不要求 Operator 在线。

只有 active、managed、具备远端、稳定分支与开发分支一致且路径为 Home
规范 checkout 的 Project 才可自动同步。执行前及维护锁等待后重新检查目标和授权，
拒绝符号链接、链接 worktree 和不合格目标。复用无交互 fetch、远端核验、
fast-forward-only 与并发预算，不 reset/rebase，不覆盖 dirty 或分叉提交。

## 使用

设置 → Job 与时间计划提供内置标识、Project、自动同步偏好、有效状态与阻止原因、
时间编辑、立即运行、最近检查、最近成功、准确 Run 历史及业务结果。
全局管理使用 Web 本地用户 token/origin 权限，不借用 Operator Session。
Task shell 管理仍保留原会话边界。

默认每 6 小时一次，首次到期在安装后 6 小时；已有合格 Project 首次运行新版
Controller 时也适用。错过的周期合并为最多一次准入，之后选择时间边界之后的
下一次到期，不批量补跑。可以修改为至少 1 分钟的 interval 或带时区的五字段 cron，
不能改为 once，也不能重定向内置 Job/Schedule。

CLI 复用 `schedule show/update/disable/enable/revoke --global --schedule <id>`，
写入前读取准确 `--revision`。即时执行使用
`job run --global --job <id> --request-id <stable-id>`；历史与结果使用
`job runs`、`job run-result --run <exact-run-id>`。完整命令示例见
[英文接口文档](project-sync.md)。

关闭记录与有效可执行状态分开保存，重启、目标变化、重新核对不恢复开启，也不覆盖
时间配置。revoke 同时关闭偏好；enable 明确检查当前前提并签发新授权。
关闭会阻止尚未开始及仍在等待维护锁的自动 Run，不能撤销已经发生的 Git 效果。
自动关闭时仍可明确“立即运行”，但目标必须合格；这不改变下一次到期。

## 冲突、失败和迁移

同 Project 的手建 `project.refresh` Job 保留原配置和授权；内置计划展示其 ID，
不接管、不重复触发。如需切回内置，通过明确 Job update 将手建定义改为其他目标或
动作，再管理内置计划。保留的准确 Run 历史不会迁移归属。预占内置 ID 的自定义记录
不会被收编，Controller 报告冲突。

内置来源不是执行权限；编译期注册服务只对当前合格 Project 签发绑定
Home/Schedule/Job 版本及输入的授权。目标变化替换当前定义和授权，旧 Run 不能因此
执行新目标。停用/移除/失去前提时停止自动执行并保留历史；前提恢复后仍尊重原偏好。
派发异常不会自动猜测修复或重新授权；业务失败保持准确结果，后续正常周期是新的检查。
本次失败和上次成功分别展示。

1.16 → 1.17 为集中追加迁移，已有自定义 Job、服务授权、时间覆盖和 Run payload
原字节不变；迁移本身不执行 Git。生产 Home 升级/启用不由开发测试授权。本次验证仅用
隔离 Home 与可丢弃本地 Git。
