# 项目编码指导、目录指令、Skills 与记忆

`createProjectGuidance` 是已有 `ContextSource` 和 `Tool` 的生产端，不是新 Agent
循环、插件平台或权限库。每个 Session 显式创建一个实例，绑定受控项目 `root`、
已有目录 `cwd` 和 `sessionId`。没有 Yui Home、Task、Controller、全局配置或
第三方 Agent 内核依赖。唯一公开入口为本目录 `index.ts`，也从根入口导出。

```ts
import {
  createProjectGuidance, createContextBuilder, createCodingTools,
  createToolExecutor, createAgent,
} from './index.js';

const guidance = createProjectGuidance({ root, cwd, sessionId });
const executor = createToolExecutor({
  tools: [...guidance.tools, ...createCodingTools({ root, command: { env } })],
  environment, permission, // 调用方已有的显式授权/环境合同
});
const agent = createAgent({
  provider,
  toolExecutor: executor,
  contextBuilder: createContextBuilder({ sources: [guidance.source] }),
});
// 同一 Session 串行运行；身份和完整历史由调用方持有。
const result = await agent.runTurn({ sessionId, turnId, input, history, maxSteps: 8 });
```

以上变量由调用方提供。仓库文本和 frontmatter 不会修改 `executor.definitions`、
permission、provider 或当前用户请求。不改变上下文、协议或会话格式。

## 每步材料与信任

- 只有随代码发布的固定编码行为是 `kind: guidance`（system）。它要求自主选择
  读取/修改/验证，先了解目标约定和完整适用 Skill，核对文件效果和 command
  `exitCode`，诚实说明失败/未执行；不建立固定阶段机。
- 仓库指令、Skill 目录/正文/引用和项目记忆均为 required `file/data`（user）。
  JSON 内容标记类型、`trust: project-content`、目录 scope、优先级、相对路径、
  内容 SHA-256。目录仅含 metadata；正文没有进入初始请求。
- `ContextReport` 沿用 source/material ID 和 revision。材料每步重新读取，不用旧
  正文冒充 live。required 材料无法放入 builder 的预算时失败，不截断或偷偷压缩。
  来源异常也不会 fallback；builder 按现有合同报告 `source_failed`，直接调用
  `source.load` 或工具可取得具体异常/错误。
- 当前用户与系统约束高于项目约定；目录指令只对自己子树生效，深层规则只在该
  子树覆盖祖先，兄弟规则互不覆盖。记忆低于指令，是可能过时的经验。
  这些是模型的使用指导，不是保证语义抗提示注入的沙箱。

## 目录与渐进加载

首次 source 加载只读 root→cwd 的目录链，不上探根外或扫描整仓。
每目录选择第一个存在的文件：`AGENTS.override.md`、`AGENTS.md`，再到调用方明确
提供的 `fallbackNames`。损坏/超限的优先文件会失败，不当成缺席回退；不自动加载
CLAUDE 文件，不解析 `@import`。

普通工具 `project_context` 接受以下准确字段；多余字段会被拒绝：

```json
{"action":"inspect","path":"services/api/file.ts"}
{"action":"load_skill","locator":".agents/skills/check/SKILL.md"}
{"action":"reference","locator":".agents/skills/check/SKILL.md","path":"references/check.md"}
```

`inspect` 用现存目录自身或文件目标的父目录，完整检查其祖先链，激活当前 Turn
范围（文件本身可尚不存在，父目录必须存在）。初始 cwd 外的目标应先 inspect。
每个已选目录只发现 `.agents/skills` 的直接子目录 `SKILL.md`，目录输出稳定排序；
可选默认目录不存在是正常缺席，文件损坏、非目录、symlink 和预算问题则明确失败。
同目录重名 Skill 拒绝为歧义；祖先/深层同名条目保留明确 scope 和 locator，
模型按目标选择最深适用项，也可明确选中某个完整 locator。

frontmatter 是有界 UTF-8 文件中的小型声明子集，不是完整 YAML：

- 第一行和结束标记必须为独立 `---`；支持 LF/CRLF。
- 平面唯一 key，必需 `name`（1–64 个小写字母/数字/连字符，首位字母或数字）、
  非空 `description`。
- 支持 plain scalar、JSON 双引号字符串、YAML 单引号字符串（`''` 转义）、
  `|`/`>` 后两空格缩进多行文本。没有列表、嵌套对象、tag、anchor、alias、
  inline comment、chomping 标记或任意 YAML 执行。
- 其他支持语法的标量字段仅列入 `ignoredFields`，不产生授权/配置效果。
  unsupported syntax、重复 key 或缺失字段明确失败。比如标量
  `allowed-tools: export_secrets` 是无效能力声明，绝不授予工具；
  YAML 列表形式不在该子集内，明确拒绝而不猜测。

发现阶段有界整读以解析 metadata，但只投影 metadata，不声称文件 IO 没有读到
正文。`load_skill` 仅接受当前 catalog 的 locator，成功后下一个 source 请求包含
整个原始 SKILL.md，之后每步刷新。引用必须属于已完整加载的 Skill，路径相对于
其目录，不接受绝对路径、`..` 或 symlink；不递归追链或自动执行脚本。
工具只返回来源/指纹 receipt 和 catalog，正文由 source 提供，不再复制进历史。
不支持关闭正文中恶意指令的语义效果；实际工具权限仍由执行器决定。

选择状态仅存当前 Turn，换 Turn 成功加载时清空并从 cwd 重建；工具拒绝错误
Session 或非当前 Turn。加载失败不提交选中状态。调用方必须串行使用同一 Session，
不得重叠不同 Turn 的 source/tool 操作；这不是并发 Session 调度器或跨进程锁。

## 唯一可见记忆

产品仅有 `root/.agents/MEMORY.md` 一个普通 bounded UTF-8 Markdown 文件；
用户可直接查看、修改、删除。没有隐藏索引、副本、自动生成、会话摘要存储、
跨项目数据库或后台进程。`project_memory` 只能作用于此文件，不接受任意 path：

```json
{"action":"read"}
{"action":"replace","expectedSha256":null,"content":"初次创建的经验"}
{"action":"replace","expectedSha256":"64位小写SHA256","content":"修改后的经验"}
{"action":"delete","expectedSha256":"64位小写SHA256"}
```

`read` 返回 exists、完整 text、bytes、sha256；缺席时 sha256 为 null。
replace 的 null 仅能创建缺席文件，必要时创建唯一 `.agents` 父目录；已有文件必须
带当前指纹。替换复用公开文本工具的指纹/临时文件写入合同。delete 只删除该
精确文件且必须匹配指纹，不提供通用删除。此实例的 memory 操作串行结算。
旧指纹不会覆盖直接用户修改；source 每步刷新，删除后材料消失，重启重新读取
同一个文件，不依赖旧 Session。普通管理调用也需先为当前 scope 调用 source。
取消发生在已完成的替换/删除之后不撤销效果；结算成功不被伪造为回滚。

默认单文件64 KiB、catalog16 KiB、总材料256 KiB、64 Skills、64已选目录、
32路径层级；调用方可显式收紧（构造器检查上下限）。遍历目录项也有界，
总材料在累积时检查，不读取无界内容后才截断。
这些路径/指纹检查面向受控本地目录和单写者，不是 OS 沙箱、敌对文件系统防护
或对外部并发写入的跨进程 CAS。普通授权 shell/用户仍能直接改文件；
“唯一”指产品存储/API，并非文件系统独占权限。

## 离线证据

`test/core/native-agent-guidance.test.js` 通过公开工厂验证作用域/覆盖/兄弟隔离、
Session/Turn 状态、metadata 子集、完整按需正文、失败不激活、唯一记忆的
创建/刷新/冲突/取消/精确删除、symlink/损坏/预算及外部内容不变成 system。
真实 context、executor、coding tools 在确定性 provider fixture 下完成
inspect→load→read→edit→本地 command→检查 exitCode→final；额外的非零
exitCode 与拒绝记忆授权保留失败事实。相邻 composition regression 已覆盖真实
gateway 编解码/SQLite/CLI 接线。没有真实模型/账号测试，不证明模型一定会选择
正确 Skill 或服从 scope，也不证明 final 意味着业务验收。
