# 独立模型接入配置工具

本文随 Yui 源码版本维护。它描述 `src/models/connectionConfig.ts` 和交付包
`dist/models/configureConnection.js`，不是后台服务安装器，也不要求启动 Yui Controller。
工具只修改明确选定的原生文件；Provider 权威仍在 Codex/metabridge 自己的配置中。
维护服务、安装升级和 CPA 上游/账号管理不属于此工具。

## 兼容性与证据

- Codex CLI：配置契约按 2026-10-24 的 OpenAI 官方 Advanced Configuration /
  Configuration Reference 核对。本机只运行 `codex --version`，观察到 `0.159.2`。
  支持用户级 `config.toml` 中的自定义 Responses Provider；不宣称验证了 Codex
  原生解析、认证或实际推理。Node 24/Linux 的隔离文件测试不是其他平台/版本实测。
- metabridge：只读核对 `ccc782e2ac3e4c91d89893207582dad16b45e623` 的
  `src/core/provider-config.js`、`src/bridge/server.js`、`config/bridge`、
  `config/providers`；未运行该仓库脚本或服务。支持 `providerFiles` 布局、Responses
  CPA/直接 Provider、`auth.type=keyfile|none`。`backends` 内联布局的 Provider 编辑
  明确拒绝，不自动迁移。单独修改监听设置可保留既有 `backends`。
- CPA 只需提供兼容的 Responses API 根地址与客户端认证；工具不读取 CPA 配置，
  不假设 CPA 实现/版本，不安装 CPA、不托管 OAuth、不查询额度。
- 官方资料：
  <https://learn.chatgpt.com/docs/config-file/config-advanced>
  （Config and state locations / Project config files / Custom model providers）；
  <https://learn.chatgpt.com/docs/config-file/config-reference>。
  文档会变化；升级 Codex/metabridge 后应重新核对这些字段及上游说明。

`requires_openai_auth` 必须由调用方显式选择认证模式决定，不能从端口、Provider 名、
模型名或是否名为 metabridge 推断。官方订阅认证仍由 Codex 的登录/凭据存储管理，
工具不访问 `auth.json`、系统钥匙串或已有 token。

## 安装与入口

源码工作区先执行 `npm ci` 和 `npm run build`。独立入口：

```sh
node /absolute/yui/dist/models/configureConnection.js --help
```

发布包使用相同的 `dist` 路径，不依赖源码 `scripts/`。源码便捷入口是
`node scripts/configure-model-connection.mjs`；两者调用同一个实现。
交付包包含本说明和所需编译模块；不用初始化 Home，不创建 Controller、tmux 或 Job。
Node/macOS/Linux 支持范围跟随 Yui 包；本次只在 Linux/Node 24 验证。
包安装和更新使用 Yui 既有方式，本工具不检查远端版本，也不自动更新任何组件。

## 先确认所有权和效果

1. 明确目标实例、路径、版本、当前配置管理者和允许修改的字段；暂停其他配置编辑者。
2. 在用户所有、无符号链接、不可被组/其他用户写入的目录中准备文件。
   父目录必须已存在，工具不隐式创建目录。文件需为本人可写的常规单硬链接文件，
   最大 2 MiB；拒绝符号链接、FIFO、非本人文件、只读或可被他人写入的文件。
3. 预览后核对路径、请求字段、前后修订和影响。预览不返回值或原生配置全文，
   因为文件可能含秘密；需要核对非秘密参数时同时审阅自己的请求文件。
4. 仅在有明确写入授权且已经排除其他写入者时使用 `--exclusive`。
   这个声明不是授权，也不能锁住外部编辑器。

工具在提交和恢复时重新检查文件/权限/内容及模式修订，并持有
`<target>.connection.lock` 协作锁。没有文件系统级 compare-and-swap：
不遵守锁的外部写入者仍能在检查与替换之间制造竞争。因此不能保证共享编辑下的原子 CAS；
无法约定独占写入时只用预览，不调用 apply。锁冲突直接失败，不等待、不偷锁、不重试。
崩溃残留锁需由拥有该操作的 Agent 先确认原进程已停止、检查文件和回执后处理，
不能按 PID 不存在或锁的年龄盲目删除。

保存不等于应用：工具不启动/重启/热加载任何服务，不联网，不刷新目录，不验证 API key，
不修改活动 Codex Session。监听端口是否空闲也未验证。
metabridge 此版本在启动时加载配置，`MB_HOST` / `MB_PORT` 环境变量可覆盖文件；
由实例实际生命周期管理者单独安排应用，并评估现有会话及未知消费者。
Codex 用户配置可能被 CLI、profile 或受管策略覆盖；新进程/新会话是否使用本配置应单独检查，
不能把写入成功宣称为当前会话接入成功。

## 请求格式：Codex 直接接入 CPA

请求文件只放认证引用，不放密钥。以下地址、路径、名字都是示例，不是本机默认值。

```json
{
  "codex": {
    "codexHome": "/absolute/private/codex-home",
    "scope": "user",
    "provider": {
      "id": "cpa",
      "name": "CPA",
      "baseUrl": "http://127.0.0.1:9100/v1",
      "auth": { "type": "env", "envKey": "CPA_INFERENCE_KEY" }
    }
  }
}
```

发现顺序：显式 `configPath` > `codexHome/config.toml` >
`CODEX_HOME/config.toml` > `~/.codex/config.toml`。所有显式路径必须绝对；
不展开字符串内的 `~` 或变量。文件名必须为 `config.toml`。不写 profile、系统层、
受管 requirements 或可识别的项目 `.codex/config.toml`；用户若显式将 `CODEX_HOME`
设为某目录，则它本身就是所选用户配置根。工具不查阅所有受管策略来判断最终生效值。

Provider 的 `id` 为 1–80 个字母/数字/下划线/连字符；
`openai`、`ollama`、`lmstudio`、`amazon-bedrock` 保留，不作为自定义 Provider 改写。
`name` 是非空单行名称；`baseUrl` 是完整 http(s) API 根，不允许用户名、密码、query、hash。
仅写 `wire_api="responses"`。认证必填：

| `auth.type` | 写入 |
| --- | --- |
| `env` | `env_key` 指定的环境变量名，`requires_openai_auth=false` |
| `none` | 删除旧 `env_key`，`requires_openai_auth=false` |
| `official` | 删除旧 `env_key`，`requires_openai_auth=true`，保留原生官方登录 |

环境变量必须由调用 Codex 的环境提供。`none` 只用于服务本身允许无认证的边界；
`official` 只适用于确实支持客户端官方登录语义的网关，不是一般 CPA 的默认值。
目标 Provider 已有 command auth、literal bearer token 或自定义 headers 时拒绝改写，
由授权 Agent 按匹配版本的原生文档处理，避免静默混用认证。

解析和输出校验使用已有 `smol-toml`；编辑支持普通显式 Provider 表和顶层标量，
只改请求字段，保留无关 TOML 字节、注释、模型、MCP、权限和其他 Provider。
目标 Provider 使用 inline/dotted 表示时可能返回 `UNSUPPORTED_TOML_EDIT`，不把整份配置重排。
修改后再次解析并比对全部预期语义，防止损伤无关值。没有重复文本追加。

新增/更新 Provider 不切换默认值。单独的切换请求：

```json
{ "codex": { "codexHome": "/absolute/private/codex-home", "selectProvider": "cpa" } }
```

也可把 `selectProvider` 与 Provider 添加组合在同一个显式请求内。
恢复到官方方式可显式选择 `openai`，或使用下面的精确快照恢复。
只有显式 `catalogPath` 才会设置 `model_catalog_json`：它是已有本地文件的绝对引用，
工具不生成、读取、分发或下载目录，不承诺目录格式/新鲜度。

## 请求格式：Codex → metabridge → CPA/直接 Provider

```json
{
  "bridge": {
    "configPath": "/absolute/private/bridge/config.json",
    "host": "127.0.0.1",
    "port": 9200,
    "provider": {
      "path": "/absolute/private/bridge/cpa.json",
      "name": "cpa",
      "via": "cpa",
      "baseUrl": "http://127.0.0.1:9100/v1",
      "auth": { "type": "keyfile", "file": "cpa-client-key" }
    }
  },
  "codex": {
    "codexHome": "/absolute/private/codex-home",
    "provider": {
      "id": "metabridge",
      "name": "metabridge",
      "baseUrl": "http://127.0.0.1:9200/v1",
      "auth": { "type": "none" }
    }
  }
}
```

`host`、`port` 可以省略以保留原值；工具不硬编码当前用户地址或端口。
非 loopback 监听还须 `allowRemoteListen:true`，并由调用方另行保障访问边界；
metabridge 的推理监听不是 Yui Web 管理认证。端口范围 1–65535。

Provider 文件必显式指定，以 `name` 校验身份，不能用同一路径静默改名。
`via:"direct"` 配置直接 Provider API；`via:"cpa"` 指向 CPA，两者都是 Responses 根。
已有路由、prefix、过滤规则、reasoning 和其他字段保留；已有非 Responses protocol、
sanitize/webSearch 等不兼容处理策略拒绝编辑，不擅自重设。
新增时 `requestMode` / `compaction` 用该版上游支持的 passthrough 策略；
已有设置保持，不执行全量上游校验。

`keyfile.file` 是原生 metabridge 引用：相对路径相对于 Provider 文件目录，
上游支持的 `~/` 由 metabridge 解释。工具不读取、不创建、不复制该密钥文件；
须由获准管理者单独准备私有客户端推理凭据。`none` 表示显式无认证。
不接受静态密钥/env_key 作为 bridge 新认证参数。
已有自定义 `http_headers` / `env_http_headers` 也拒绝此窄接口编辑，避免旧认证头覆盖新选择。
已有 Provider 文件的 `auth` 会被此次显式认证选择替换，旧内容保留在私有备份里。

工具把 Provider 文件路径（相对 bridge 配置目录）加入 `providerFiles`，不重复引用，
保留其余已有引用和原生 JSON 字段；JSON 格式化会变化，TOML 的无关字节不变。
本工具不遍历/验证其他引用文件，不运行 bridge 的启动/健康检查（某些检查会刷新上游）。

## 预览、提交与恢复

先将路径调整为获准的隔离/实际目标，并准备所有父目录。下面命令中
`/absolute/...` 必须替换，不要原样执行。新文件应使用私有权限：

```sh
umask 077
node /absolute/yui/dist/models/configureConnection.js preview \
  --input /absolute/request.json > /absolute/new-preview.json
node /absolute/yui/dist/models/configureConnection.js apply \
  --input /absolute/request.json --if-plan /absolute/new-preview.json \
  --exclusive --receipt /absolute/new-receipt.json
node /absolute/yui/dist/models/configureConnection.js restore \
  --from /absolute/new-receipt.json --exclusive \
  --receipt /absolute/new-restore-receipt.json
```

每个 receipt 路径必须尚不存在；CLI 在任何配置写入前先独占创建 `0600` 回执文件。
apply 重新构造计划并比较预览的所有文件前后修订与字段，不执行反序列化计划。
公共结果仅含路径、请求字段、修订摘要、是否变化、逐文件状态、备份引用及影响提示。
退出码：`0` preview/saved/unchanged；`2` 校验/冲突/失败；
`3` 部分文件已保存；`4` 结果未知（含写后回执持久化失败）。

真正变化前创建同目录 `0600` 的 `.connection-backup-<uuid>.json`，
保存原字节、权限、目标和写后修订；它可能包含原文件秘密，不可贴到日志/聊天。
新文件 `0600`，既有安全文件保留权限；写后 readback 验证并同步目标目录。
幂等重复请求无变化时不产生备份。回执和备份不自动清理：
保存恢复证据直到确认不再需要，再由拥有者删除其精确路径，不做目录通配清理。

多文件顺序：Provider 文件 → bridge 配置引用/监听 → Codex 配置。
提交前预检全部修订，提交中每项再检查。它们不是事务：
`saved` 是该文件已保存；`unchanged` 无变化；`failed` 在写边界前失败；
`unknown` 无法证明写入最终结果；`skipped` 未执行。全局 `partial` 保留此前成功，
不自动删除 Provider 文件、不假装整体回滚。unknown 优先保留未知状态，不自动重试。
临时文件/协作锁正常退出会清理，清理失败会在结果中报告。

restore 仅恢复回执中确认 `saved` 的项，逆序检查私有备份摘要和目标写后修订；
任何后续编辑或权限变化都会失败，不覆盖它们。恢复也生成自己的回执/备份，
不删除旧证据。原先不存在的文件恢复时删除该精确新建文件；原来文件则恢复原字节/权限。
它只恢复文件，不回滚已应用的进程状态。
`unknown`、进程崩溃、空/缺失回执、回执落盘失败需先根据逐文件摘要及备份人工核对，
不能当作安全重试/恢复许可；不把未知项冒充已保存项。

## Yui / Agent 复用

导入 `dist/models/connectionConfig.js`：

```ts
const plan = planConnectionConfig(input); // 或传显式 environment，避免继承不需要的环境
// 核对 plan.files 的路径、字段、修订，完成调用方原有权限/实例所有权检查
const result = applyConnectionConfig(plan, { exclusive: true });
// 后续显式恢复：
const restored = restoreConnectionConfig(result, { exclusive: true });
```

导出的 `ConnectionConfigInput`、`ConnectionConfigPlan`、`ConnectionConfigResult`、
`ConnectionWriteOptions` 是类型契约。计划原始文本仅存在模块私有 WeakMap，
公共 JSON 不含原文，反序列化/伪造计划句柄不能执行。
Web/CLI 管理服务应在服务器按已授权实例路径重新构造计划，再比较客户端批准的预览修订；
不得把来自浏览器的任意路径、`exclusive` 声明或回执当成写权限。
工具不是远程 API，也不接受任意 shell 命令；上层继续复用既有授权、审计与实例身份。
修改后上层重新读取原生权威配置并刷新自己的投影，不另存第二份 Provider 真相。

预览失败抛 `ConnectionConfigError`，仅包含有界 code，不包含解析器片段/秘密。
apply/restore 返回逐文件失败或抛出输入/备份错误；调用者须按状态处理，
不能用“函数返回了”判断全部成功。不得自动对未知外部效果重放。

## 常见故障与验证

- `UNSUPPORTED_TOML_EDIT`：目标为复杂 inline/dotted 表示或无法安全保留语义。
  由获准 Agent 先按原生文档备份、检查修订并规范该目标，不自动重排全文件。
- `UNSAFE_*`：检查精确路径、所有者、只读/组写权限、符号链接与父目录。
  不绕过检查，也不自动 chmod 用户文件。
- `REVISION_CONFLICT` / `PREVIEW_REVISION_CONFLICT`：重新读取并核对已发生的变更，
  再决定是否生成新的预览；旧恢复请求不能强行覆盖。
- `CONFIG_LOCK_UNAVAILABLE`：确认该配置是否仍被使用，不自动偷锁。
- `CODEX_AUTH_REQUIRES_NATIVE_EDIT` / `INLINE_BRIDGE_BACKENDS_UNSUPPORTED`：
  使用匹配版本的原生文档和明确授权处理；不是认证失败或模型不可用的证据。

确定性测试：`npm run build` 后
`node --test test/core/connection-config.test.js`。
覆盖两条路径、direct Provider、CODEX_HOME、预览零写入、幂等、无关字段/注释保留、
默认独立切换、权限/符号链接/项目层拒绝、恢复冲突、部分成功、写后未知及 CLI 回执。
不启动 Controller/metabridge/CPA，不读取真实用户配置，不调用模型/额度。
更完整的包安装、平台组合和真实服务行为不由这些文件测试证明。
