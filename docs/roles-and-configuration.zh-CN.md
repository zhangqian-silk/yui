<p align="right"><a href="./roles-and-configuration.md">English</a> | <strong>简体中文</strong></p>

# Role、Profile 与执行配置

## 职责

Agent 选择一个执行组件、连接方案和启动环境。Role 选择一个活动的 Agent 绑定和
可移植行为。每个绑定保留独立的运行时选项。一个 Role 可以持有多个绑定，而不产生
并行写者，也不把一个绑定的凭据/配置共享给另一个。

Task Role 是 Task 局部的；global Role 提供已配置的默认值和全局对话。Role
身份/配置不是可写的运行时状态。Session 与 Provider 观察描述实际活动。

一次显式的 Task-final Review 使用既有的 Task 局部 Reviewer Role，不要求存在同名
的 global Role。只有当请求的 Task Role 不存在时，global Role 才作为创建模板。
可用性、producer 分离和冻结的审查候选仍然适用。

## Profile

Agent Profile 把可移植行为（指令、Skill 和访问意图）与运行时意图组合在一起。
运行时要么沿用当前 Global Worker 绑定，要么显式选择一个 Agent 并可选 model 和
effort。`config profile reset` 提供 `worker`、`explorer`、`implementer` 和
`reviewer`。

从 Profile 创建 Task Role 会冻结其解析后的行为和绑定。之后对 Profile 或 Global
Worker 的编辑不会改写既有的 Task Role。重新套用一个 Profile 是一次显式配置变更。
所选 Agent 必须与目标绑定匹配；显式的 Role 选项覆盖对应的模板字段。Profile
不是 Session、工作区 owner 或资源 grant。

原生子代继承其父 Agent 和权限。Profile 可以引导它们的行为；model/effort 覆盖
需要真实的原生工具支持。它们不获得 Yui Role、独立 Assignment 或更大范围。

## 期望、生效与观察

期望设置是下一次启动的意图。AgentRun 和 Session 捕获生效启动：Agent/组件、
协议、model、effort、权限策略、工作区/环境、Role 上下文以及 planning/delivery
权限。

对运行中配置的检查单独报告 Agent 实际声明的内容。unsupported 和 unknown 都是
显式的；一个被接受的 setter 若没有回报当前值，并不算已观察到的匹配。读取配置
不会修改 Agent 以让观察与期望一致。

Worker 绑定变更保留活动 Assignment 的 Agent 和生效快照；之后的显式派发使用当前
选择。Leader 替换撤销上一条管理入口，但不改写 Worker Assignment。更改期望配置
不会热改原生 Session。一次显式的 `task role session new` 请求会在选择新 Session
之前处理旧运行时清理；它不要求先手动结算 Run 状态。一个有用的 Session 可以复用，
但它绝不是 Task 上下文的唯一持有者。

## 权限与 Project 上下文

Provider 权限策略、Profile 访问意图和 Project 写范围是不同的合同。Provider 旁路
不授予对另一个 Project 的写入。受管工作区 owner、精确 Assignment 和资源 grant
落实 Yui 操作；宽泛的原生权限不是 OS 沙箱。

Yui 提供其通用 Role Skill 和 Context 指针。Project Skill 仍是由 Agent 原生发现的
普通 Project 文件。Project Knowledge 维护在 `YUI_HOME` 下；把仓库材料复制进 prompt
并不使其成为权威 Knowledge。

## 原生认证

账号配置比 Session 活得更久。Yui 保留 `HOME` 和所选的 `CLAUDE_CONFIG_DIR`；
新建/恢复的 Session 不会复制、清除或伪造原生登录、key 批准或 onboarding 记录。

对 Claude Code，标准的 API-key、base-URL、bearer/OAuth、model-alias 以及原生
provider 选择相关环境变量只转发给 Claude。这些值留在 Controller 可替换的运行时
环境和子进程中，不进入 Task/Role 记录。取消某个来源并刷新 Controller 环境，即可
在后续启动中移除它。其他自定义凭据变量仍使用显式的 Agent 环境绑定或原生用户设置；
Yui 不继承整个 shell 环境，也不推断云凭据。

Claude 自身加载原生设置，并按其生效配置在 API key、既有 helper、登录凭据、profile
和云认证之间做选择。Yui 不注入 `apiKeyHelper`、不复制凭据文件，也不覆盖原生认证
优先级。显式的 `--settings` 路径和 settings 来源选择被原样透传。

全新的原生配置仍可能需要 Claude 的初始化、key、工作区和安全确认，包括访问初始化
服务。隔离 `YUI_HOME` 或替换 Session 都不要求一个全新的原生账号目录。受管的 Task
执行使用 Claude 的非交互 stream-json 路径，并沿用同样的原生配置归属。

## 命令

```sh
yui config agent capabilities <agent-id>
yui config role show <global-role>
yui config profile show <profile>
yui task role add <task> <role> --profile <profile>
yui task role show <task> <role>
yui task role update <task> <role> --environment <preparation-id>
yui task role update <task> <role> --managed-environment
yui task role session inspect <task> <role>
yui task role session new <task> <role> --reason "<why a fresh Session is useful>"
```

创建 Role 时，显式的 Agent 设置需要 `--agent`。更新时，省略 `--agent` 针对活动
绑定；一个具名绑定会被更新但不被激活。`task role bind` 更改选择。在更改期望设置
之前，活动 Session 需要该命令的显式确认。

关于原生配置和实现限制，参见 [Provider Runtime](provider-runtime.zh-CN.md)。
