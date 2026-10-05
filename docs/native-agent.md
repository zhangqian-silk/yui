# 独立编码 Agent 入口

`yui agent` 与控制面共用安装包，不共用运行生命周期：它在控制面模块加载之前
分流，不初始化或读取 Yui Home，不启动 Controller/Task/Role/Host/ACP。
既有管理命令仍是 `yui config agent`。

当前入口已装配真实 kernel、ModelGateway、ExecutionOwner、工具、上下文、
SQLite、行式交互和观测，以及真实本地安全 binding/permission/environment、
项目指导、按需完整Skill与唯一项目MEMORY。
尚未接入持久 Session catalog/目录元数据；
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
  "tools": ["read", "list", "find", "search", "project_context", "project_memory"],
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
`STREAM`、`COMMAND_CONFIG`（每项都带 `NATIVE_AGENT_` 前缀）。CLI 对应 `--credential-ref`、
`--state-dir` 等 kebab-case 名称；tools是逗号分隔，stream是true/false。
文件相对路径基于文件目录，CLI相对路径基于启动目录，环境路径必须绝对。
cwd默认启动目录；model/endpoint/credentialRef/stateDir无账号或Home回退。

预算只承诺已有机制：maxSteps为1–100、contextBytes为1–1048576的JSON字节，
outputReserveBytes小于contextBytes；modelTimeoutMs为1–300000的单次模型逻辑请求
总预算（包括网关已分类重试等待），不是整个Turn或命令的硬超时。
工具现有大小/命令超时上限仍生效；不承诺货币、token或整体墙钟限额。

## 明确选择副作用

默认选择read/list/find/search及只读project_context/project_memory。选择write/edit或command时，当前调用必须分别
带`--allow-write`或`--allow-command`，不能从配置、环境或历史自动恢复这些opt-in：

```sh
# agent.json须含下述已审查command配置；单有allow-command不授予任意命令。
yui agent start --config /absolute/agent.json \
  --tools read,list,find,search,write,edit,command --allow-write --allow-command
```

入口使用真实 `createLocalToolBinding`，同一工厂的编码tools、permission、environment
通过公开能力组合交给唯一 `createToolExecutor`，不使用 Agent 的 tools 简写。
编码调用保留原工厂的活lease和实际权限检查；普通项目工具不获取编码lease，
按其Session作用域、具体action与本次授权检查，不向82私有声明集合注入外来工具。
实际声明仍受 `tools` 选择限制。root 与 cwd 都绑定到有效配置的 canonical cwd；
不会从 `.git` 或项目文本推断更大根。有效配置和 binding 描述可供核对真实目录。
目录身份在授权和执行时复核，替换/消失/软链变化拒绝旧绑定。

选择command还必须提供调用方审查过的完整规格：所选JSON文件的 `command` 字段，
或 `--command-config JSON` / `NATIVE_AGENT_COMMAND_CONFIG` JSON值。
例如文件中加入：

```json
{
  "command": {
    "env": {"LANG": "C"},
    "specs": [
      {"executable": "/canonical/path/to/reviewed-program", "argv": ["--check"], "effect": "read"}
    ],
    "timeoutMs": 10000,
    "maxOutputBytes": 65536,
    "killGraceMs": 1000
  }
}
```

这是片段，需合并进前述version-1配置；程序路径必须是真实规范化绝对普通可执行
文件、无软链组件。argv逐项精确匹配，command调用的cwd必须等于绑定cwd；
程序身份变化、额外参数、另一个解释器或目录均拒绝。`effect:"write"` 还需要本次
`--allow-write`，仅 `--allow-command` 不允许写规格。上述三个预算字段可省略，
沿用工具预算；无command配置时不能启用command。

规格不是程序分析或只读证明。调用方必须审查具体程序、完整参数及其实际配置行为；
不得把模型临时生成的脚本、可写脚本文件、可变外部配置或任意参数当作已审查规格。
`--allow-command` 不是任意shell/脚本权限。离线例子只授权代码中固定且已审查的
fixture检查程序，不代表可以自动授权任意模型建议。

env是完整白名单环境，只允许显式PATH/LANG/LC_ALL/TZ，默认`{}`；
不继承process.env/HOME/凭据/代理/加载器变量。PATH目录及程序仍须可信审查。
公共配置输出不打印command规格、argv或环境值，binding只报告envKeys/commandCount。
原始调用/结果是必要执行事实，仍会保存到历史；不要在argv或配置中放秘密。
入口把当前已知凭据传给82的outcome脱敏，并继续保护模型/记录/诊断出口；
这是已知秘密文字保护，不是全通道DLP，也不改变被读取文件的实际内容/sha256。

改变工具/授权需先取消并等旧owner结算、关闭，再显式重开。
每次启动/指定ID恢复均从当前配置和本次opt-in创建新binding/executor，重新验证目录、
程序与授权；旧标题/ID/历史/描述不授予权限，不热更新旧lease。
不实现`/permissions`或授权提示UI。命令仍可访问root外的路径、网络与系统资源，
不对敌对文件系统或脱离进程组的后代作隔离保证，不是OS强沙箱。

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
configuration/binding/projectAuthority/result/receipt/observations；退出码0完成，1错误或保存失败，
2配置错误，3步骤预算耗尽，130取消/中断，143终止信号。
全局`--json`前缀与`run/check-config`的`--json`标记也在控制面加载前处理；
`start`是行式UI，若要求JSON则明确拒绝并建议使用run。
工具执行非零exitCode不是业务成功；完整结果中需要检查实际工具outcome。

状态文件固定为显式stateDir下`sessions.sqlite`，使用既有独立Session格式2和
现有v1→v2迁移，不改变Yui Home版本。新状态目录0700、数据库0600；
已有目录权限不擅自重设。请独占受控状态目录，每个Session只运行一个owner；
CAS不是跨进程执行租约。恢复非ready状态被拒绝且不自动修复/重放。
掉电/SIGKILL不保证finally运行；强沙箱、真实模型质量和其他平台未验证。

## 项目指导、Skill与MEMORY

每个Turn从实际recording的Session身份创建真实`createProjectGuidance`，
接入已有ContextBuilder；不使用UI当前选择作为授权身份。root=cwd仍是当前明确目录。
内建编码指导是required system材料，项目AGENTS、Skill和MEMORY是required的
低信任user材料；来源、revision和materialId进入ContextReport。预算不足或读取
失败阻止模型请求，不静默丢弃、摘要截断或把项目文本提升成system权限。

初始只加载当前目录指导及Skill元数据目录。模型可用`project_context`的`inspect`
检查目标目录规则，`load_skill`读取指定locator的完整SKILL.md，`reference`按需
读取已加载Skill的相对资源。成功后下一步上下文加载完整正文，不把正文复制到历史；
每个Turn重建状态，跨Session或恢复不会继承已激活Skill/目录。frontmatter中的
allowed-tools/model/hooks、伪造role或记忆文本不能扩展工具或权限。

唯一项目记忆位置为`.agents/MEMORY.md`，不是另一个Session存储。`project_memory`
的`read`默认允许；`replace`和`delete`需要**本次调用**的`--allow-memory-write`，
并按生产工具的expectedSha256规则防止覆盖陈旧内容。该flag不从文件、环境或历史
恢复，也不授予编码write/edit/command；`--allow-write`不能替代它。示例：

```sh
yui agent run --config /absolute/agent.json --allow-memory-write \
  --input '读取项目记忆，然后以当前指纹保存这次确认过的经验'
```

这是project_memory的具体action授权，不是文件系统ACL：若另行明确授予普通
write/edit或可写命令，它们仍具有其既有受控root权限，可能直接修改这个文件。
外部修改在下一步重新读取；旧指纹拒绝，读写权限与记忆内容不互相授予能力。
项目读取遵守84的大小、总材料、目录/Skill数量和深度上限；不自动执行Skill脚本，
也不访问Home或任意项目外资源。显式`--tools`完整替换默认集合；
即使未选择项目工具，required内建和基线项目指导仍加载，但不能按需激活更多内容。

## 真实接线剩余边界

- 持久catalog生产者须提供稳定ID/标题/分页、create/open/rename、cwd元数据和
  可恢复诊断；与现有InteractionSessionPort的create/list/read/history接线。
  目前`--session ID`和`/use ID`直接查询真实store，`/sessions`只列出本进程显式选择，
  不代表持久发现；当前无法核对原会话cwd，使用者须重新选择相同受控目录。
- 已采用82真实安全模块，包含实际ToolPermission/ToolEnvironment及有效binding描述；
  默认只读、精确命令、本次授权、结算关闭后重开重建已经通过真实CLI离线验证。
  已采用84真实源码，项目工具使用独立的公开权限组合，MEMORY写授权不继承。
- 最终“新进程发现并选择同会话、原会话目录一致、实际授权效果”的验收仍需81
  真实源码与完整合同，不能用fixture或完成通知替代。指定ID恢复只验证当前绑定，
  还不能核对原会话目录。当前离线检查只替换模型网络，其余已装配模块真实，
  不是缺少catalog的最终联合验收。

## 可执行离线样例

源码完成本地安装后：

```sh
node docs/examples/agent-offline.mjs
```

样例创建本地HTTP服务、一次性目录和dummy凭据，经真实入口完成读取、编辑、
精确授权本地检查、按需完整Skill、MEMORY默认拒绝与显式写入、回执核对和指定ID
续聊，随后重开不继承command/write/MEMORY授权；
finally关闭fixture进程/服务并删除自己的目录。
不使用真实模型、账号或共享资源，不启动控制面。
