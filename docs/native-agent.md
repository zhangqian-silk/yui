# 独立编码 Agent 入口

`yui agent` 与控制面共用安装包，不共用运行生命周期：它在控制面模块加载之前
分流，不初始化或读取 Yui Home，不启动 Controller/Task/Role/Host/ACP。
既有管理命令仍是 `yui config agent`。

当前入口已装配真实 kernel、ModelGateway、ExecutionOwner、工具、上下文、
SQLite、行式交互和观测。尚未接入持久 Session catalog/目录绑定及可变授权策略；
因此这是可独立使用的入口装配，不是完整产品的联合验收结果。

## 启动

源码开发先运行 `make install-local`，使用 checkout 的绝对
`output/dev/bin/yui` 和独立 `YUI_HOME`。以下 `yui` 代表安装包命令，
或该绝对开发入口；不需要 `yui setup`：

```sh
# 使用自己明确选择的凭据变量；示例不提供真实凭据。
yui agent check-config --config /absolute/agent.json
yui agent start --config /absolute/agent.json
yui agent run --config /absolute/agent.json --input '读取 input.txt，说明内容'
# 用前次 receipt 中的 ID 明确恢复；不要自动选择最近会话。
yui agent run --config /absolute/agent.json --session SESSION_ID --input '继续'
```

显式 JSON 文件（不自动发现、执行或保存配置）：

```json
{
  "schemaVersion": 1,
  "adapter": "chat-completions",
  "endpoint": "https://your-selected-provider.example/v1/chat/completions",
  "model": "your-explicit-model",
  "credentialRef": "env:MY_AGENT_KEY",
  "cwd": "/absolute/controlled/repo",
  "stateDir": "/absolute/agent-state",
  "tools": ["read", "list", "find", "search"],
  "maxSteps": 8,
  "contextBytes": 1048576,
  "outputReserveBytes": 0,
  "modelTimeoutMs": 30000,
  "stream": false
}
```

仅支持当前 Chat Completions 文本/function 协议子集，endpoint 是完整地址，
不自动拼路径。HTTPS 不允许 userinfo/query/fragment；本地 HTTP fixture 必须
显式 `--allow-http`，且只能是 loopback。无认证必须明确
`credentialRef: "anonymous"`，缺少 key 不会降级成匿名。

`check-config` 校验数据与凭据是否可解析，显示非敏感有效配置及来源；
不请求网络、不创建状态库。实际存储打开失败在启动时报告。
文件最多64 KiB、schemaVersion必须为1、未知字段拒绝，不读取项目代码配置。

优先级逐字段为 CLI > `NATIVE_AGENT_*` > 所选文件 > 安全默认；
工具数组完整替换，不合并能力。环境项为 `NATIVE_AGENT_ADAPTER`、
`ENDPOINT`、`MODEL`、`CREDENTIAL_REF`、`CWD`、`STATE_DIR`、`TOOLS`、
`MAX_STEPS`、`CONTEXT_BYTES`、`OUTPUT_RESERVE_BYTES`、`MODEL_TIMEOUT_MS`、
`STREAM`（每项都带 `NATIVE_AGENT_` 前缀）。CLI 对应 `--credential-ref`、
`--state-dir` 等 kebab-case 名称；tools是逗号分隔，stream是true/false。
文件相对路径基于文件目录，CLI相对路径基于启动目录，环境路径必须绝对。
cwd默认启动目录；model/endpoint/credentialRef/stateDir无账号或Home回退。

预算只承诺已有机制：maxSteps为1–100、contextBytes为1–1048576的JSON字节，
outputReserveBytes小于contextBytes；modelTimeoutMs为1–300000的单次模型逻辑请求
总预算（包括网关已分类重试等待），不是整个Turn或命令的硬超时。
工具现有大小/命令超时上限仍生效；不承诺货币、token或整体墙钟限额。

## 明确选择副作用

默认只有read/list/find/search。选择write/edit或command时，当前调用必须分别
带`--allow-write`或`--allow-command`，不能从配置、环境或历史自动恢复这些opt-in：

```sh
yui agent start --config /absolute/agent.json \
  --tools read,list,find,search,write,edit,command --allow-write --allow-command
```

这是现有公开合同的“调用方授权的预绑定工具”，不是可变权限策略、提示授权UI
或强沙箱。不实现`/permissions`；改变工具集合需退出再显式启动。
command的完整环境为`{}`，不继承PATH/HOME/凭据；使用绝对可执行路径及显式argv。
文件工具绑定受控root；命令可访问root以外的路径、网络与系统资源。
只向可信任本地命令开放此能力，不对敌对文件系统或脱离进程组的后代作隔离保证。

真实凭据仅用于内存中的模型认证；不保存在配置/历史/日志/诊断中，不传给工具
子进程。已知的当前凭据若出现在模型响应/工具参数/必要记录，入口拒绝该出口，
停止后续效果；不把秘密写入错误。流式正文不直接显示，避免分片泄密；
UI显示确认消息、工具事件和不含正文的观测。无法识别用户主动输入的其他秘密。

## 输入、取消、关闭与保存

`start`复用行式UI：普通文本提交；`/cancel`按精确活动Turn身份取消；
`/history`查询真实消息；`/use ID`选择明确会话；`/new`新建；
`/quit`、EOF或SIGTERM关闭整个产品。Ctrl-C在执行时请求取消，在空闲时退出。
取消不是回滚：已发生的文件/命令效果仍按真实结果保存；未知效果不重放。
执行所有者先取消/drain，再关闭SQLite、观测、响应体和自有HTTP连接池，
移除信号/输出监听。UI断开不是工具停止证明。

正常/取消/预算终态的receipt由真实SQLite记录产生并与再次load的digest/revision
核对；展示终态不等于已保存。保存失败只给lastConfirmedReceipt及检查建议，
不声称完整Turn已保存，不重试必要记录。`run`返回JSON：
configuration/result/receipt/observations；退出码0完成，1错误或保存失败，
2配置错误，3步骤预算耗尽，130取消/中断，143终止信号。
全局`--json`前缀与`run/check-config`的`--json`标记也在控制面加载前处理；
`start`是行式UI，若要求JSON则明确拒绝并建议使用run。
工具执行非零exitCode不是业务成功；完整结果中需要检查实际工具outcome。

状态文件固定为显式stateDir下`sessions.sqlite`，使用既有独立Session格式2和
现有v1→v2迁移，不改变Yui Home版本。新状态目录0700、数据库0600；
已有目录权限不擅自重设。请独占受控状态目录，每个Session只运行一个owner；
CAS不是跨进程执行租约。恢复非ready状态被拒绝且不自动修复/重放。
掉电/SIGKILL不保证finally运行；强沙箱、真实模型质量和其他平台未验证。

## 真实接线剩余边界

- 持久catalog生产者须提供稳定ID/标题/分页、create/open/rename、cwd元数据和
  可恢复诊断；与现有InteractionSessionPort的create/list/read/history接线。
  目前`--session ID`和`/use ID`直接查询真实store，`/sessions`只列出本进程显式选择，
  不代表持久发现；当前无法核对原会话cwd，使用者须重新选择相同受控目录。
- 权限/环境生产者须提供实际ToolPermission/ToolEnvironment和有效授权视图，
  预绑定root/env与执行边界一致；恢复授权默认只读。入口不复制生产者策略。
- 最终“新进程发现并选择同会话、目录一致、运行时授权”的验收需要真实生产者
  固定成果，不能用fixture替代。当前离线检查只替换模型网络，其余模块真实，
  但不是这些尚未提供模块的最终集成。

## 可执行离线样例

源码完成本地安装后：

```sh
node docs/examples/agent-offline.mjs
```

样例创建本地HTTP服务、一次性目录和dummy凭据，经真实入口完成读取、编辑、
本地检查、回执核对和指定ID续聊；finally关闭fixture进程/服务并删除自己的目录。
不使用真实模型、账号或共享资源，不启动控制面。
