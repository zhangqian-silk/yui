# 请求前上下文构建

本模块独立于内核与存储，无会话状态、缓存、文件读取或模型请求。
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
        source: 'project-guide', revision: 'guide-v1', required: true,
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
真实 tokenizer 可通过 `{id, estimate(request)}` 替换；容量与输出预留必须
使用同一单位。估算覆盖整个请求，包括工具定义和身份字段，边界允许相等。
估算精度归估算器，模块只保证返回值不超过配置预算，不承诺真实模型容量。

## 保留、来源与摘要

历史采用调用方已验证的 `Message[]` 快照；模块另行检查全历史的调用身份
唯一性及配对完整性。助手的一批调用与全部结果是单个原子组，结果可按调用
ID 以不同顺序排列。悬空、重复、错误名称或孤立结果显式拒绝。
没有对完整历史沿用骨架的 1 MiB 请求限制；构建后的请求仍须满足消费方限制。

全部原始 system 消息、最后一条 user 消息至历史末尾、最近
`keepRecentGroups` 个组（默认 2）不可裁剪。
明确 guidance 材料始终保留；其他材料的 `required` 由调用方决定。
材料按源与返回顺序置于历史之前，以 JSON 包装来源：
guidance 为 system；file/data 为 user 数据，不提升为指令。
不要把不可信文件标为 guidance。源不获得完整历史，只得到当前 Step 身份和
取消信号；文件授权、读取上限及资源释放由源负责。

超限时从最旧的可选历史组开始，再按声明顺序处理可选材料。没有压缩器时
整个省略。有压缩器时只传入一个可选原子单元的冻结副本，将返回的纯文本
包装为带 provenance 的 user 摘要，再估算完整请求。只有变小且已满足预算
才保留该摘要；仍超限或没有节省时省略整个单元，继续处理下一个。
不截断工具参数、工具结果、system 或当前输入，也不伪造摘要 tool 消息。
摘要语义正确性属于注入的压缩器，报告明确标记，不冒充原始事实。

`report.entries` 覆盖每个输入单元，给出保留/摘要/省略及原因：
历史范围为 `[start, end)`；材料带 sourceId、materialId、source、revision。
历史 revision 是本次 session/turn/step 标记，**不是存储修订号或缓存有效性证明**；
原始消息的持久身份仍由存储/调用方持有。本模块不缓存这些标记。

## 失败、取消与恢复

`ContextBuildError.code` 区分 invalid_budget、invalid_history、invalid_material、
invalid_options、invalid_estimate、invalid_summary、source_failed、
estimation_failed、compression_failed、budget_exceeded、cancelled。
`budget_exceeded` 附带报告，列出不可再省略的内容和请求总估算。
扩展抛出的原始错误不拼入公开错误，避免意外泄露内容；没有隐式降级或重试。
调用方不得在构建失败后把未裁剪的请求当作成功结果发送。

每次异步调用前后检查取消，等待已开始调用结算，不用超时竞速。
不合作的扩展仍可能挂起，取消不是强制终止或回滚。
源和压缩器负责关闭其创建的资源。恢复只需从权威历史重新 build，
不会写回历史或接管 Session 状态。

## 所有权与验收范围

task-77 提供这个模块，task-72 负责内核每请求接线，task-76 提供完整历史
查询/快照，task-73 或调用方可提供厂商估算器。当前未修改公共根入口、
内核、存储或厂商协议；独立通过不等于这些模块已经组合验收。

`node --test test/core/native-agent-context.test.js` 使用固定历史、
明确指引/文件材料和 fake 扩展，覆盖预算、配对、每 Step 重建、不可变历史、
来源、失败与取消。无真实模型、付费 API、Controller 或外部服务。
