# 工具管理与执行结算

公开入口为 `toolManager/index.ts`。这是可替换的工具执行能力，不是第二个
Agent 内核；不依赖 Yui，也不持有会话历史、恢复台账或策略配置。
现有 `createAgent` 尚未接入本模块，统一组装由内核模块负责。

## 使用

以下为纯内存示例；实际持久化实现由调用方注入：

```ts
import { createToolExecutor } from './index.js';

const executor = createToolExecutor<{ prefix: string }>({
  tools: [{
    definition: { name: 'echo', description: 'Echo text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } },
        required: ['text'], additionalProperties: false } },
    validate(args) {
      return args && typeof args === 'object' && !Array.isArray(args)
        && typeof args.text === 'string' && Object.keys(args).length === 1
        ? null : { code: 'invalid_arguments', message: 'Expected {text}', effect: 'none' };
    },
    async execute(args, _scope, _signal, environment) {
      return { ok: true, content: environment.prefix + (args as { text: string }).text };
    },
  }],
  environment: {
    async acquire() {
      return { value: { prefix: 'Echo: ' }, async release() {} };
    },
  },
  permission: { async check() { return { allowed: true }; } },
});
const inMemoryFacts: unknown[] = [];
const result = await executor.executeBatch({
  scope: { sessionId: 's', turnId: 't', step: 1 },
  calls: [{ id: 'c1', name: 'echo', arguments: { text: 'hello' } }],
  signal: new AbortController().signal,
  async beforeExecute(identity) { inMemoryFacts.push({ intent: identity }); },
  async afterExecute(receipt) { inMemoryFacts.push({ settlement: receipt }); },
});
// result.results[0].outcome = { ok: true, content: 'Echo: hello' }
```

原有三参数 `Tool.execute` 可直接使用，环境感知工具可消费第四参数。
环境类型属于组合方；工具、权限检查和执行收到同一环境值。执行器不会暗读
全局目录或权限，缺少环境、权限或必要记录接口明确失败。

## 正常路径与替换合同

创建时校验唯一非空名称、JSON 声明及方法，保存声明和方法快照；没有动态注册、
热加载或卸载协议。需要不同集合时创建另一个执行器。`inputSchema` 是模型声明；
无副作用的 `Tool.validate` 负责具体参数语义，不暗加第二套 JSON Schema 引擎。

先验证完整批次，再严格顺序执行：

1. 参数校验；获取独立资源 lease。
2. 等待 `beforeExecute` 记录意图，检查取消。
3. 等待权限检查，再次检查取消，直接调用工具。
4. 等待实际结果并归一，在 `finally` 中等待 `release`。
5. 等待 `afterExecute` 记录完整结算，再允许下一个调用开始。

记录意图不是工具已经启动的证明。`started` 仅表示实际调用了 `execute`，
不证明工具完成效果。权限检查与目标效果之间不再等待其它外部能力，但这不构成
跨进程授权事务；需要更强原子授权的工具必须在自身效果边界使用授权资源。
同一会话/共享环境的批次由调用方串行提交；本实现不提供并发调度。

调用方先记录完整调用批次，拥有跨批 ID 唯一性、必要持久化和历史配对。
每个合法调用恰有一个回执，保留 Session/Turn/Step/call ID 与名称。
无效批次整体拒绝，无资源获取或工具效果。输入、声明、记录参数和结果为
冻结 JSON 快照；环境是资源引用，不尝试深复制或冻结它。

本地预算与既有 wire 合同一致：每批 1–8 个调用，参数 64 KiB，
整批和全部工具声明分别不超过 512 KiB，scope 不超过 4 KiB，JSON 深度
至多 32。各身份字符串及工具名最多 1024 UTF-8 字节，为配对错误留出空间；
结果按配对 tool 消息的 UTF-8 JSON 大小限制为 512 KiB。
超限不截断：执行前拒绝；执行后无法可信表达的结果报告未知效果。

## 失败、取消、资源与恢复

- 未知工具、参数拒绝和权限拒绝：`not_executed`，效果 `none`，可继续后续调用。
- 环境、校验实现、权限能力或必要意图记录故障：停止新增效果，剩余调用补齐未执行回执。
- 已启动工具返回已知错误：`failed`；明确的 `cancelled`/`none` 错误为 `cancelled`。
  取消信号本身不能证明效果未发生。成功写入即使遇到取消也保留 `succeeded`。
- 抛异常、畸形/超限结果或工具声明未知效果：`unknown`，停止本批，不重试。
- 已取得 lease 的所有路径只调用一次 `release`，不传已取消的 signal。
  获取拒绝为 `acquire_failed`：创建方仍负责部分资源，不能宣称本执行器已清理。
  畸形 lease 或释放失败为 `failed`，保留调用身份和清理故障；不覆盖真实工具结果。
- `afterExecute` 失败保留 `recordingError`，停止新增效果并停止调用该坏出口；
  全部回执仍返回在内存中。此前写入可能已生效，调用方核对原存储，不能盲重写。
  `stopped` 是停止原因摘要，必须同时检查回执的 `cleanup` 和 `recordingError`。
- 没有超时竞速、硬取消或自动恢复。工具、权限、记录或释放能力不合作时可能一直等待。
  不自动重放工具或记录；跨请求去重、崩溃恢复与未知效果处置属于调用方唯一权威。

普通 UI/遥测不能充当必要记录接口；其可隔离失败应由组合方分开处理。
工具和环境实现是可信代码，权限接口及目录检查不是操作系统沙箱，不能阻止恶意插件
绕过合同执行任意代码。替换 `ToolExecutor` 的实现必须保持配对、权限、必要记录、
取消结算和未知效果不重放的语义。

离线证据：`test/core/native-agent-tools.test.js` 使用 fake tools、环境与记录器，
不调用真实模型或共享资源；既有骨架测试仍单独验证原内核路径。新内核/基础工具/
持久化模块的真实组合尚须按其合同验收，不能从这些 fixture 推断已完成。
