<p align="right"><a href="./task-local-identity.md">English</a> | <strong>简体中文</strong></p>

# Task 局部身份

Yui 把 Task 作为持久工作流记录的聚合边界。每个 Task 为下面每一类记录族维护
一条独立、单调递增的序列：

- WorkItem
- AgentRun
- ReviewRound
- ChangeSet
- IntegrationAttempt
- Message
- InputRequest
- Decision
- Milestone
- Event

序列从 1 开始，因此每个 Task 内某个族的第一条记录本地编号都以 `-1` 结尾
（例如 `work-item-1`）。删除、取消、完成、重开和归档都不会降低已持久化的
高水位，所以本地 ID 在同一个 Task 内永不复用。每次分配都在 Store 事务内推进
该聚合高水位。

Candidate 身份的范围更窄：`candidate-N` 是 WorkItem 内的局部序列。每个
Candidate 都保存自己的 `taskId` 和 `workItemId`，在有来源 AgentRun 时再附带
其引用。

## 引用合同

Task 所属引用的可移植形式为：

```text
<task-id>/<local-id>
```

例如 `task-7/work-item-1` 和 `task-9/work-item-1` 是不同的。CLI、JSON、mailbox、
Controller、Hook、回执、Web 以及错误路径都保留 Task 范围。无上下文的命令会
拒绝裸的本地 ID，而不是在所有 Task 中搜索，即使该 ID 当前恰好唯一。

受管的 Task 会话可以直接用 `work-item-1` 或 `run-1`，因为它的 `YUI_TASK_ID`
是明确的。已经通过其他参数收到 Task 的命令也可以使用从属的本地 ID。除这两种
情形外，一律使用限定形式。投递回执沿用同样的来源标注，例如：

```text
run:task-7/run-1
input-request:task-7/input-1
```

不存在兼容查找、跨 Task 猜测或裸 ID 回退。

## 当前 schema 边界

运行时只打开当前 Home 存储版本和当前记录形态，普通工作中既不双读也不推断
历史记录。历史解码与改写只发生在显式的 `yui upgrade` 边界和 `yui update` 的
迁移阶段；凡是不低于 CLI 最低支持存储版本的有效 Home 都能直接推进到当前版本。

这条边界让 Task 局部引用、Role 期望配置以及不可变的 AgentRun/RoleSession
生效快照都处在同一份无歧义的运行时合同下，而只追加的迁移链保留受支持的历史。
