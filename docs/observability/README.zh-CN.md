<p align="right"><a href="./README.md">English</a> | <strong>简体中文</strong></p>

# 运行时观察与诊断

只读投影帮助 Agent 区分持久意图、实际运行时活动和未知效果。它们不引入第二套
调度或验收权威。

## 检查

```sh
yui controller status
yui execution audit --task <task-id> --json
yui task next-action <task-id>
yui task role session inspect <task-id> <role>
yui task run show <task-id>/<run-id> --json
```

Controller status 暴露当前进程与 Home 身份。Session inspect 区分期望绑定、
生效启动、实际连接以及 Agent 自报配置。Run 检查暴露原始输入、处置、精确结果
和诊断。读取状态不会启动另一个 Agent，也不确认工作。

## 证据的含义

- Task 与 WorkItem 生命周期描述意图和验收。
- AgentRun 生命周期描述明确请求的一次执行。
- Provider 接受与原生活动描述实际的输入/连接。
- Host PID、tmux 与资源清单描述进程观察。
- 运行时配置区分请求值与自报值。
- token、时长与编排成本是仅供参考的观察。

对于专用 Claude 流，一次主 assistant 响应会在终态结果之前确认当前这一条本地
输入已被处理。因此该响应到达后，Controller 与 Role 读取才显示 accepted/running。
启动、回显的用户输入、子响应以及重复的旧消息都不建立新的接受；message UUID
永远不作为原生 Turn ID。

普通 Leader 通知是 TaskWake/mailbox 投递，不是 Leader Run。即使没有打开
AgentRun，Role 状态也包含其原生准入/活动；当某个 WorkItem 处于终态时，它显示
保留 Session 的实际工作区，而不是用 Task main 顶替。未知证据仍为未知；进程退出
不证明共享 Provider 已停止，传输成功也不证明原生已接受。

工程控制证据可以比附着的 Session 缓存活得更久。这样的 Role 会把保留的原生输入
报告为需要关注，而不因缓存为空就当作空闲。范围受限的 Task/Session 检查仍可用于
诊断。替换与原生清理失败是持久事件，路由给 supervisor；替换后待处理的输入引用
仍然可读。

精确的工具 start/result 事件投影为 `tool-active`，模型活动投影为 `model-active`；
安静间隔并不意味着 Agent 卡住或已完成。工具失败是操作结果，不是自动的 Run 失败。
被拥有的 Claude 执行进程若死亡，会关闭其精确输入并把 Session 标记为 failed，即使
监督它的 Host 仍存活。一个已被有意停止、且原生输入已结算的 Session 是空闲状态，
而不是虚假的运行时失败。

## 执行审计

`execution audit` 汇总既有的 Task、Run、wake、Session、Review、Integration、
Publication、事件、WorkItem、存储和编排证据。`--since` 与 `--until` 界定时间窗。
各部分各自报告自己的读取错误，不为缺失数据编造值。

故障分类使用 Core 拥有的失败原因或明确标识的 Core 诊断证据。Agent 撰写的报告
散文不会被解析为判定或严重级别。原生 Agent 错误保留其原始负载和标准类别，供
Agent 结合当前 Task 上下文解读。

成本与重复劳动提示不会阻止一个合法动作、设定 Review 预算或选择恢复拓扑。
`task next-action` 是决策支持，不是自动执行的计划。

## 隐私与资源边界

Telemetry 和缓存是诊断材料，不是 Task 真相，也不是 transcript 备份。不要仅为
解释某个状态就采集或发布凭据、私有环境值或原始 Provider 历史。

从精确的只读记录开始。进程变更、取消、grant 更新和资源清理都需要相应的显式动作
与范围。一个笼统的诊断请求不授权真实模型、共享或生产环境的测试。
