# 独立 Agent 编码评测

这是当前公开 Agent 模块的离线、可复现评测薄层，不依赖 Yui 控制面。
评测运行实际内核、编码工具、ToolExecutor、ContextBuilder、SQLite SessionStore
和 LocalObserver；仅替换 provider。任务通过来自文件快照、独立检查和执行结算，
不是模型 final、工具 `ok` 或执行 `completed`。

## 运行和接口

使用仓库支持的 Node 版本，在仓库根目录运行：

```sh
npm ci --no-audit --no-fund
npm run build
node --test test/core/native-agent-evaluation.test.js
node dist/nativeAgent/evaluation/demo.js
npm test
```

demo 输出六行默认脱敏 JSON 报告：每类一个已知好解、一个已知坏解。
好解必须 `pass`，坏解必须 `fail`，所有目录必须清理，demo 才退出 0。
这是 harness 自检，不是把坏解的编码任务记为成功，也不是模型能力排名。

```ts
import { runEvaluation, createEvaluationFixture } from './evaluation/index.js';

const report = await runEvaluation({ caseId: 'repair' }); // 默认确定性好解
const negative = await runEvaluation({
  caseId: 'refactor',
  provider: {
    source: { kind: 'deterministic-fixture', id: 'known-bad', revision: '1' },
    create: context => createEvaluationFixture(context, 'bad'),
  },
});
```

`provider.create(context)` 可注入另一个 `ModelProvider`，也可由调用方组合网关与
fixture transport。context 显式提供受控仓库 root、当前 Node 路径、固定 case
和本轮 observer；没有隐式账号、endpoint 或环境发现。来源的 id/revision/model
必须是非敏感标签。网关观察可按现有公开组合接口接到 observer，报告只消费实际
提供的用量和耗时。注入能力不授权真实模型、付费 API 或不可信代码执行。

`maxSteps`、`contextCapacity`、`signal` 使用内核原有合同。额外 `permission`
只能进一步收窄；不能放宽 runner 固定命令策略。调用方负责注入实例自行创建的
外部资源，不应在 provider 工厂创建不归本 runner 所有的进程或持久化服务。

## 固定任务和验收

所有基线由版本化 `cases.ts` 固定，实例包含 `package.json`、`README.md` 和
`math.cjs`，没有下载依赖或借用用户仓库。case revision 为 1，报告给出完整基线
文件集合摘要、输入摘要、verifier 摘要以及实际 Node/平台。摘要算法是 SHA-256。
读取、编辑、新增和语法检查均由真实工具执行；provider 只安排调用。

| 类别 | 用户目标 | 独立检查 | 坏解为何失败 |
| --- | --- | --- | --- |
| repair | 空数组均值返回 0，保留非空均值 | 基线行为检查退出 1，好解退出 0 | 错误边界值使检查仍退出 1 |
| refactor | 抽取 `double`，两个 API 实际复用它 | 数值行为保持；替换 helper 后两个 API 的输出随之改变 | 加注释或不改文件不满足实际委托目标 |
| tests | 增加空输入边界断言，不改生产代码 | 同一新增测试在正常实现通过，在固定空输入错误变体触发断言失败 | 空测试、打印 PASS、与目标无关的断言杀不死变体 |

验收器源码由评测父进程持有，通过固定 Node argv 执行，不位于被测仓库，也不
从候选的脚本或配置读取。验收只消费已独立读取的文件快照，不读取 provider 的
fixture 模式。候选能使用的 command 严格限制为当前 Node 的
`--check math.cjs` 或 `--check math.test.cjs`；不能运行自己的 oracle 或任意 argv。
验收进程由现有 command 工具计时、限输出和结算，每次都检查真实退出码及
`directChildExited/processGroup`。对 mutation 的非零退出，还必须有可信断言
失败标记；语法错误、缺测试或任意抛错不会冒充杀死变体。

这些小任务的纯函数与测试在独立 Node 进程中的受限 vm 上执行。测试合同明确只
支持 CommonJS 的 `require("./math.cjs")`、`require("node:assert/strict")` 及
原始值 `equal/strictEqual` 断言，验收使用相同严格相等语义的受限断言 API，
不是通用 npm/Node 测试平台。不支持异步测试或任意 require。函数调用和测试执行
都在 vm 时间限制内，断言计数与失败标志保留在候选不可改写的闭包。

允许/禁止范围独立比较前后完整文件集合，包括新增、删除、链接和空目录。
补测试只允许 `math.test.cjs`，生产代码一律受保护；其他两类只允许 `math.cjs`。
没有变更不能通过。读取失败、超出有界快照或非普通文件不会被当作空 diff。

## 证据与资源结算

SessionStore 是唯一完整会话事实源。报告仅含本轮逻辑引用及实际
sessionId/revision/digest/durability 回执，并在关闭重开 SQLite 后核对摘要；
不复制 transcript 或再建历史数据库。默认运行是完全可丢弃的：清理后
`retained:false`，回执说明当时确实保存，不承诺已经删除的会话仍可查询。

报告白名单保留变更种类/内容摘要、独立检查、结束原因、预算、实际工具结算、
录制状态和 observer 派生元数据，不输出输入/输出正文、原始错误、堆栈或环境。
未知新增路径只给编号和路径摘要；模型产生的 call ID 以摘要关联，未知工具名
映射成 `unregistered`。不要把敏感数据放入 caller 来源或观察关联标签。

未知 tokens/cost 为 null；观察到的 tokens 按 producer 原样保留，不求和或把
字符数当 tokens。fixture 来源始终标 `synthetic`；wall time、observer 到达间隔
和 producer elapsed 分开。没有起点的 model 观察不会虚构 duration。

每次调用创建独占临时父目录，仓库与 SQLite 分开；没有验收缓存或后台服务。
teardown 在首次分配前进入 `try/finally`，关闭 store/observer，确认检查及工具
进程组已不存在，再删除自己的精确目录并核对 ENOENT。清理不确定会留下原目录
及精确恢复路径，并判失败，不删除所有权证据或清理其他目录。
取消不回滚：已确认编辑及真实配对结算保留；预算耗尽、拒绝写入、用户指纹冲突、
未知效果、未完成录制或清理均不能报告任务通过。

## 覆盖与限制

永久回归覆盖六个好/坏任务、no-op、非零检查、step/context 预算、确认编辑后的
取消、permission 拒绝后的文件零差异、读后用户修改保留、禁止新增/删除、
正文和未知标识脱敏、真实 SQLite 重开、重复运行身份隔离及目录/进程清理、
synthetic 用量与未知费用。底层工具在途取消/超时等合同仍由原有关键回归保护。

这不是 OS 沙箱：只运行可信固定本地程序和受控 fixture 内容，不对恶意并发
文件变更、vm 逃逸或任意不可信 provider 提供隔离保证。三类有限 oracle 也不
证明任意程序正确性。未来模块消费者、真实模型规划能力、线上协议和价格均未
在这里验证；不代表其他任务交付或最终入口集成。真实资源验证需另有精确授权。
