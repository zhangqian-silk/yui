# 独立 Agent 交互入口

此模块属于 task-78，只消费 Agent/会话事实，不接入 Yui Controller，
也不是生产会话持久化实现。仅从 `interaction/index.ts` 导入。
现有内核及公共 `nativeAgent/index.ts` 合同没有改动。

## 本地运行

仓库根目录执行：

```sh
npm run build
node dist/nativeAgent/cliDemo.js
```

输入任意非空文本可运行固定的 mock read → write → final 路径。
demo 仅使用自己创建的临时目录，不访问工作目录文件，不调用真实模型。
第二轮会携带同一会话的历史；模型的上下文大小限制仍然生效。
这不是语义规划演示：用户文本不会改变 mock 的固定行为。

| 输入 | 效果 |
| --- | --- |
| 普通文本 | 提交当前会话的新 Turn；等待执行时仍可输入命令 |
| `/cancel` | 查询当前活动 Turn，按精确身份请求取消；等真实终态 |
| `/new [标题]` | 创建并选择会话；不取消旧会话的执行 |
| `/sessions [offset]` | 分页列出会话（每页最多 20） |
| `/use ID` | 选择会话并重放事实 |
| `/history [offset]` | 分页显示完整消息记录（每页最多 20） |
| `/diagnostics [offset]` | 查询独立的可选观测日志页与健康信息 |
| `/refresh` | 从会话事实重新构建显示，不重发输入 |
| `/more` | 请求下一页执行事件 |
| `/help`、`/quit` | 帮助、断开入口 |

每条输出都有类型标签：`provisional` 是未确认的增量文本，
`message`/`tool result` 是会话确认的完整记录，`ended` 是真实执行终态。
刷新会追加标有 replay 的重放内容，不清屏，也不将 token 拼接成权威消息。
工具调用、开始执行和结果分别显示；取消之后已提交的工具效果仍按实际结果显示。
内容默认最多显示 2000 个 UTF-16 单元，标注省略数量；终端控制字符、
换行和双向控制符转义，防止内容伪造独立状态行或执行终端转义。
完整记录由 SessionPort 保留；CLI 首版不提供大字段全文导出。

## 替换与所有权

`openCli({ sessions, input, output, renderer?, diagnostics?, initialSessionId? })` 返回
`{ done, close }`。传入的 Node streams、SessionPort 和 renderer 由调用方选择。
关闭只释放此入口的 readline 和订阅；不关闭调用方 streams 或 SessionPort，
也不隐式请求取消。输出错误、renderer 异常、输入 EOF 不证明执行失败或停止。
`done.reason` 区分入口自己的关闭原因。Ctrl+C/SIGTERM 在 demo 中由最外层
资源所有者处理：它先关闭入口，再明确取消自有执行并等待结算，最后删除临时目录。
不合作的 provider/tool 可能一直不返回；没有强杀或伪造结算超时。
有意关闭整个 demo 会丢失内存会话；`/refresh` 和同一服务内的重连接不等于进程崩溃恢复。

`InteractionSessionPort` 是 UI **消费侧**的窄接口：

- `create/list/submit/cancel` 操作由会话服务决定；submit 只等待接受，不等待执行完成。
- `read(session, after, limit)` 查询按会话单调游标排序的事件页与实际活动 Turn。
  `history` 返回稳定追加的消息页。单页最多 20，单记录 payload 最多 512 KiB；
  每页渐进显示，对慢终端等待写回调，避免无界输出缓冲。
- `subscribe` 只表示“请重新查询”。入口先订阅再读取；通知丢失后可手动刷新。
  会话适配器必须先保存必要事实，再隔离调用显示订阅者；不能把显示错误
  直接传给内核的必要 `onEvent` sink。
- 复用现有 `AgentEvent`、`Message`、`Scope`。可选 `text_delta` 仅供临时显示；
  真实 provider 接线必须由其生产者提供增量，不能将完成的消息拆成伪 token。
- 缺失/过期游标、错会话、乱序和无进展页显式报错；不自动重放提交。
  read 的 `diagnostic` 是执行服务诊断，不是虚构的 Agent 终态。

`createMemoryDemoSessions({ provider, tools, maxSteps? })` 是可销毁的内存
fixture，用现有公开 `createAgent/runTurn/onEvent` 组装。它拥有历史与执行句柄，
先存事实再通知观察者；UI 没有自己的执行状态副本。`close()` 拒绝新提交，
取消并等待所有已接受执行；调用方仍负责 provider/tools 自身资源。
此 fixture 不应替代 task-76 的生产会话服务，不提供磁盘 schema 或迁移。
它保留所有内存历史，仅查询/显示有界；长时生产使用必须替换服务。

本模块没有 Web 项目、自动重试、真实协议接线或统一插件加载器。
task-72/76 的公共操作/查询合同仍由其拥有者协调；本模块提供最小消费样例，
不把消费接口宣称为其他模块的权威类型。

可选 `InteractionDiagnosticsPort` 只消费适配器提供的有界文本投影：
`query(sessionId, offset, limit)` 返回日志行，`health()` 返回生产者的健康摘要，
`subscribe` 触发重新读取健康信息。适配器应原样保留真实 source、gap、
rejected、dropped、inFlight 的意义；UI 不计算这些值，不以它们推断 Turn 状态。
诊断查询失败只显示 observation unavailable，不关闭输入、不取消执行。
诊断正文不能填入 SessionPort 的消息历史；观测白名单不包含会话正文。

这使 task-79 的 query/subscribe/health 可以经薄显示适配器消费，无需复制
它的权威类型；**目前只有确定性 fixture，未声称已适配 task-79 的实际签名**。
Operator 转交的 task-72 必要 recorder/可选 observer 分离原则已保留：
此处现有内核 onEvent 先保存会话事实，再调用隔离的订阅者；
迁移到最终内核时保持这个边界，不把必要记录降级为可丢失的观察出口。

## 确定性验收

```sh
node --test test/core/native-agent-interaction.test.js
npm test
```

fixture 覆盖增量与完整确认的顺序、工具结算与精确取消、会话选择与历史分页、
刷新/重连接、显示故障隔离及关闭。当前 mock provider 没有 token streaming；
delta 路径使用可控 SessionPort 验证。以上不证明真实 provider、生产持久化、
跨模块组装或真实终端全屏体验；这是行式 CLI，不是 TUI/Web 前端。
