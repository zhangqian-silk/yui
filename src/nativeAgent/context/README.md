# 请求前上下文构建

本模块复用独立内核的消息类型，不依赖 Yui 控制面，不读取任意文件。
builder 只生成请求投影；可选 provider compressor 发起有界摘要请求。
只保留一份进程内可丢弃摘要缓存；原始历史仍只归唯一 SessionStore 所有。
只通过本目录 `index.ts` 导入。共享消息使用上层公开 `Message`、
`ModelRequest`、`StepScope`；不重新定义 Session/Turn/Step。

```ts
import { createContextBuilder } from './context/index.js';

const context = createContextBuilder({
  sources: [{
    id: 'selected-project-material',
    async load(scope, signal) {
      // 调用方读取已经授权且明确选定的材料；这里不做路径发现。
      signal.throwIfAborted();
      return [{
        id: 'guide', kind: 'guidance', content: 'Keep changes bounded.',
        source: 'builtin-code', revision: 'guide-v1', required: true,
      }];
    },
  }],
});

// 由内核调用方在每次 provider.complete 前执行，不能复用上一个 Step 的输出。
const { request, report } = await context.build({
  request: fullRequest,
  budget: { capacity: 64 * 1024, reserveOutput: 8 * 1024 },
}, signal);
const response = await provider.complete(request, signal);
// 继续持有 fullRequest 对应的完整历史；不要用 request.messages 覆盖它。
```

示例中的预算是默认估算器的 UTF-8 JSON **字节**，不是厂商 token。
`ContextCounter.count(request)` 返回 `unit/source/accuracy/value/uncertainty`，
覆盖整个请求（包括工具定义、编码开销）。`exact` 的 uncertainty 必须为 0；
`estimated` 的 uncertainty 是调用方明确选择的欠计安全余量，不是跨语言的数学保证。
unknown、无误差声明、溢出或单位不匹配均拒绝发送。
旧 `{id, estimate(request)}` 接口仍可用于显式字节/custom fixture：报告说明单位，
非默认 estimator 视为调用方假定误差 0 的 custom 估算，不冒充 tokenizer。

可选 `ContextCapacitySource.resolve(scope,signal)` 在每次请求前刷新
`model/revision/unit/contextWindow/counterId/maxOutput`；
能力提供者拥有模型/编码选择，85 不内置模型 catalog。
报告带 capacitySource；完成异步投影后再次核对能力，期间变化则 capacity_changed。
能力的 counterId 应含 tokenizer/编码版本，且必须匹配 counter.id。
有能力时 contextWindow 是容量权威；否则 budget.capacity 是调用方声明的容量。
可用输入 = 容量 − reserveOutput − reserveTools − safetyMargin；
完整请求 count + uncertainty 必须小于等于可用输入。
输出 reserve 不偷偷更改协议参数：调用方/模型网关应配置实际输出限制，
不能据本模块报告声称已经编码了厂商输出参数。
JSON 字节计数针对自有 ModelRequest，**不等于 HTTP wire 字节或 token**；
生产 token counter 必须与实际 gateway 编码相符。
独立保留内核 1 MiB 请求、512 KiB 单消息字节安全上限。

## 保留、来源与摘要

历史采用调用方已验证的 `Message[]` 快照；模块另行检查全历史的调用身份
唯一性及配对完整性。助手的一批调用与全部结果是单个原子组，结果可按调用
ID 以不同顺序排列。悬空、重复、错误名称或孤立结果显式拒绝。
没有对完整历史沿用骨架的 1 MiB 请求限制；构建后的请求仍须满足消费方限制。

全部原始 system 消息、第一条 user（初始目标）、最后一条 user 消息至历史末尾、最近
`keepRecentGroups` 个组（默认 2）不可裁剪。
明确 guidance 材料始终保留；其他材料的 `required` 由调用方决定。
材料按源与返回顺序置于历史之前，以 JSON 包装来源：
guidance 为 system；file/data 为 user 数据，不提升为指令。
对齐 Task84 的固定实际合同（本 Task message-9）：只有随代码提供的内建行为指引可以标为 guidance。
外部 AGENTS、选中的完整 Skill、MEMORY 和 routing 材料使用 file/data；
`required:true` 时必须完整保留，容纳不下则明确预算失败，不摘要、截断或丢弃。
content 中已有的 scope/trust/provenance 原样留在包装内，sourceId/materialId/revision
继续随报告保留；区分内建内容的责任在生产者/调用方，不新增信任 schema 或文件发现机制。
实际 MEMORY 使用 kind=file；单个 project_context 的 inspect/load_skill/reference
动作由生产者负责，builder 仍只消费已有 ContextSource/ContextMaterial，不新增工具装配或权限。
`protectedHistoryRanges` 可显式保护中途新增的硬约束、目标或关键事实；
触及工具组时保护整个组。内核调用方通过 contextRetention/TurnInput.context 传入。
本模块不通过关键词猜测哪些文本是硬约束，也不替调用方发现 Skills。
不要把不可信文件标为 guidance。源不获得完整历史，只得到当前 Step 身份和
取消信号；文件授权、读取上限及资源释放由源负责。

超限时，将所有可摘要的较旧原子组交给压缩器，保留不可压缩集合。
没有压缩器、摘要无收益或仍超限时明确失败，**不再默默省略旧历史/材料**。
摘要的 user 数据包装含 trust=data、sessionId、当前 historyDigest、摘要源集合
digest、compressor 身份和**有界聚合来源**，不将每个旧组重新展开进模型请求。
`contextSummary.sources` 是聚合对象，不是逐项来源数组：

- `groups` 为选中单元数，`provenanceDigest` 对选中 report entries 去掉
  action/reason 后的有序数组求 SHA-256，绑定精确来源、revision、范围和工具结算。
- history（有历史时）给出 `rangeKind:enclosing`、半开 historyRange、该原文跨度的
  digest 和组数。保护锚点可能形成空洞；这个跨度不是“所有消息都被摘要”的声明。
  精确选中组由 report 和 provenanceDigest 核对，不列出无界范围数组。
- materials（有可摘要材料时）只给出 count 和上述材料来源记录子集的 digest；
  完整 sourceId/materialId/revision 留在 report，必需材料仍完整进入请求。
- toolSettlements（有已摘要工具结算时）明确 `representation:aggregate-only`，
  给出 succeeded、failedWithoutEffect 和有序原始 toolOutcomes 的 digest。
  成功不等于无效果，失败计数不等于成功；计数由原文计算，不由摘要模型猜测。
  无效果失败可能是拒绝或未启动，计数不宣称调用已执行；具体 errorCode 见原始报告。

模型请求不逐项保留旧调用 ID/name/errorCode；这些完整事实留在本次派生
`report.entries[].toolOutcomes` 和唯一权威历史，不新增持久账本。
摘要器仍接收完整选中原子组（缓存折叠时接收旧摘要与新组），要求如实保留关键结算、
失败、约束与下一步，但摘要正文是可能有损的证据，不承诺逐项语义保留。
未知工具效果在任何缓存复用/压缩之前从完整原文预检，仍 unresolved_effect fail-closed。
缓存消费和再次折叠都重算聚合来源，不重新展开全部旧组；
元数据字段数固定，只有范围/计数数字长度随历史增长。report 的审计细节可随原文增长，
但不随请求发送，丢弃它可从权威原文重新构建，digest 不是签名或内容真实性证明。
不截断工具参数、工具结果、system 或当前输入，也不伪造摘要 tool 消息。
摘要语义仍可能丢失未保护的细节；结构保留不证明模型语义无损。

`report.entries` 覆盖每个输入单元，给出保留/摘要/省略及原因：
历史范围为 `[start, end)`；材料带 sourceId、materialId、source、revision。
历史 revision 改为完整消息快照的 `sha256:<digest>`，不再用 Step 字符串冒充版本；
每组 digest 对 `[start,end)` 原始 Message[] 的 JSON.stringify 字节求 SHA-256。
源集合 digest 对各组 digest 数组的 JSON.stringify 求 SHA-256。
baseReceipt 表示 owner 加载的**存储前缀** revision/digest/messageCount；
同一 Turn 新增消息属于 historyDigest，不冒充已保存前缀。
缓存只在同一 Session、相同模型能力/counter 身份、原子源内容/材料 revision
前缀完全匹配且仍可摘要时复用；每次重新计数，能力变化重新从原文生成。
失败/取消/无收益不安装新缓存。重启或切换 builder 丢弃它可直接由原文重建。
每次 build 都重新加载全部源；包括 required 材料在内，内容、revision、身份、
顺序或选择集合变化都会丢弃同一 Session 的旧摘要缓存。
材料快照相同时可复用通过历史前缀校验的摘要，缓存不代替当前文件读取。

## 有界真实摘要与手动入口

```ts
const context = createContextBuilder({
  counter, capacity, // 来自调用方公开模型合同；bytes fixture 可省略
  sources: selectedSources,
  compressor: createProviderCompressor({
    id: 'coding-summary-v1', provider: summaryProvider,
    counter: summaryCounter, capacity: summaryCapacity,
    budget: { capacity: 16000, reserveOutput: 2000 },
    maxCalls: 32, maxSummaryBytes: 4096,
  }),
});
const budget = { capacity: 64000, reserveOutput: 4000, reserveTools: 2000 };
const owner = createExecutionOwner({
  store, maxSteps: 8,
  context: { builder: context, budget, tools: tools.map(t => t.definition) },
  agent: recorder => createAgent({
    provider, tools, recorder, contextBuilder: context, contextBudget: budget,
  }),
});
const projection = await owner.compact(selectedSessionId, signal);
// 之后 owner.submit 从同一 store 加载完整历史；同一 builder 校验并消费手动投影。
```

provider compressor 使用自有 ModelProvider（可直接用真实 createModelGateway），
摘要工具声明为空，源数据和旧摘要均包装为低信任 user 数据；
可信摘要指令由实现提供，不从文件或历史提取。
长输入顺序按完整原子组分块，前次有界摘要与下一块共同归并；
每一次**发给模型**的请求独立计数、刷新能力并预留输出，最多 maxCalls 次。
分块试探结束后，在发送前对确切 prepared 请求重新 build；
容量下降使旧请求不再合格时明确 budget_exceeded，不向 provider 发送该过期请求，
也不重试；更早已结算的摘要调用不回滚或冒充未发生。
单组加固定指令/前次摘要无法容纳则 summary_input_exceeded；
不会把整段无界历史送入模型，也不裁剪参数/结果。
工具调用型、空、超字节上限或非法响应拒绝安装。
provider 负责合作取消、网络期限及已启动请求结算；不合作的替换 provider 仍可挂起。

manual compact 只允许本 owner 空闲且 store recovery=ready 的 Session，
前后核对精确存储回执；和 submit 互斥。取消/close 等待已启动摘要结算。
存储校验或取消失败时调用 builder.discard，丢弃该 Session 的派生缓存。
它不新增 Turn/工具事件、不改原始历史、不执行或重放工具。
builder/budget/tool set 必须与 Agent 工厂共享；入口交互产品仍由调用方负责。

## 失败、取消与恢复

`ContextBuildError.code` 区分 invalid_budget、invalid_history、invalid_material、
invalid_options、invalid_estimate、invalid_summary、source_failed、
estimation_failed、compression_failed、compression_no_gain、budget_exceeded、
byte_budget_exceeded、count_unknown、capacity_mismatch、capacity_changed、capacity_failed、
summary_input_exceeded、summary_budget_exhausted、cancelled，以及 manual 的
session_busy、session_recovery_required、history_changed、storage_failed。
每个错误包含 recovery（也包含在 message 中）；provider/store 原始错误保留为 cause，
不作为摘要输入。内核 TurnResult 的 context_error message 仍包含具体原因及恢复动作。
`budget_exceeded` 附带报告，列出不可再省略的内容和请求总估算。
扩展抛出的原始错误不拼入公开错误，避免意外泄露内容；没有隐式降级或 Turn 重试。
调用方不得在构建失败后把未裁剪的请求当作成功结果发送。

每次异步调用前后检查取消，等待已开始调用结算，不用超时竞速。
不合作的扩展仍可能挂起，取消不是强制终止或回滚。
源和压缩器负责关闭其创建的资源。恢复只需从权威历史重新 build，
不会写回历史或接管 Session 状态。

## 验收与公开消费边界

公开根入口导出 builder、provider compressor、容量/计数合同和手动 owner API。
指导仍由明确授权的 ContextSource 提供；容量/counter 由模型能力拥有方提供；
不拥有指令发现、模型协议、持久目录或完整交互入口产品。
没有新增持久字段、迁移或第二历史账本。现有 SessionDocument v2 不变。
Task84 实际合同通过合法转交的 message-9 读取，generic file/data 路径由离线合同 fixture 验证；
不声称已联合装配或跨 Task 验证其具体实现。
Task87 的生产容量/计数合同仍未收到确认。

`node --test test/core/native-agent-context.test.js` 使用固定历史、
明确指引/文件材料和 fake 扩展，覆盖预算、配对、每 Step 重建、不可变历史、
来源、失败与取消。`native-agent-compaction.test.js` 增加容量、误差、provider
分块、摘要失败、取消、手动接线和真实模块长会话验收；规模回归覆盖
300/1200 个旧组、成功/无效果失败工具、保护锚点空洞、可选材料、缓存续聊与再次折叠。

```sh
npm run build
node dist/nativeAgent/compactionDemo.js
```

示例执行 9 次续聊及真实受限文件读取，多次自动压缩与手动 compact；
核对原始 events/messages 前缀不变、摘要范围/聚合来源 digest、实际模型请求的有界
来源元数据、工具结算计数及 SQLite 重开；输出 largestSourceMetadataBytes。
只替换网关的 model transport 响应。临时目录和 SQLite 连接在 finally 释放。
它证明预算、结构、来源及组合行为，**不证明真实模型的摘要语义质量**。
没有真实模型、付费 API、Controller 或共享 Home 验证。
