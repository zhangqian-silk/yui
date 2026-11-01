# 通知原件单一读取候选（W13）

## 结论与边界

基线 `3e013d673a7b44ed1b4c9591506c69f13b4d5fab`，WorkItem
`task-154/work-item-13`，执行 `run-221`。这是独立候选，不是验收或集成决定。

只取消 Task/Global 主动通知中的 `Author summary` 副本。Task 通知仍保留
Task/wake/Message 身份、作者、执行/审查失败状态和 disposition pending；
Global 通知保留 Role/Message 身份。两者的当前上下文、原件读取和
claim → original → disposition → ACK 入口不变。完整摘要、限定语、失败
原文及 resultRef 仍由原件读取提供；CLI wake/message 输出没有修改。

没有修改 Host、Manifest、Skill、CLI 投影、权限、schema、评测框架或存量
记录，也没有新建加载回执/状态协议。普通无摘要通知完全不变。收益只来自
本来就会随后读取的摘要副本，不是新的 Host 缓存或 Skill-check 优化。

## 实际入口调查

- Task：`processLeaderWakeups` 使用
  `FileSchedulerStoreAdapter.claimLeaderNotification` 返回的固定 wake
  presentation；Global：`deliverGlobalInputs` 使用 `globalMessagePresentation`。
  `providerRetryDelivery` 的同 Session 重试复用这两个正常入口，没有另造简版。
- `agentHost` 在 submit/steer 前调用 `createSessionSkillNotice.prepare`；
  只有 provider 接受才 commit。恢复输入、重连及打开附件会 invalidate；
  不确定/拒绝提交不推进已接受的元数据。`codexInteractiveHost` 对 native
  start/steer 也已有同样检查，并保留原始内容部分。
- 基线 Host 本来就逐输入检查当前 Skill 文件及 VERSION；暖输入只追加
  `Yui Host checked current Skills; no Agent check needed.`。冷启动/恢复和
  元数据变化才给完整/变化指针。不能把这些已有行为冒称本候选成果。
- `sessionContextInstructions` 是原生启动通道的稳定 Manifest/回退指引；
  `withSessionContextPointer` 在当前生产代码没有调用方，只有测试引用。
  缩短这个未使用的包装不会产生实际通知节省。本候选不改它们，也不把
  Host 元数据当作加载或压缩后记忆的证明。
- `taskMessagePresentation` 仍为 CLI wake 原件索引提供有来源的摘要，
  oversized 摘要仍整段拒绝而不裁掉尾部限定语。

## 完整合成链成本

2026-10-31，Node `v24.20.0`，本地构建后以实际组件测量。旧实现来自上述
Git 对象，通过 TypeScript ES2022 转译加载；候选来自当前 `dist`。
两者使用同一 SQLite fixture、通知序列、原件和返回数据，分别维护 Host
notice 的冷暖状态。不是历史线上日志、模型观测、native reconnect E2E，
也不是 CLI 进程/Controller 传输性能测试。

每条链计入：实际 Host 包装的通知；首次 launch 指引；需要时的完整
Manifest/Profile/当前 Runtime、Role、自定义 Skill 文件；当前 Context；
inbox show 全部分页、claim 回应；Task wake show 与完整 Message/result
原件或 Global Message 原件全分页；语义处置后的 ACK 回应及最终 current
inbox。恢复场景另计完整 context-ordering 参考；变化场景只重读受影响的
自定义 Skill；安装损坏先记录原始检查错误，再修复并重新走冷入口。
模拟处置只操作 fixture，不产生真实外部效果。

计数口径：文件为实际 UTF-8 bytes，组件命令数据按
`JSON.stringify({ok:true,data}) + "\n"` 计入。CLI 数据路径使用
`runTaskCommand`、`runGlobalRoleCommand`、`runInboxCommand` 的实际处理器，
不是重写一份缩小的预期输出。固定的 tool 请求/API 包装、Provider 历史
缓存与推理不计；两版共用相同回应，未声称它们的 CLI 输出有任何节省。
表内“响应数”包含文件读取、分页读取以及 claim/ACK 回应，而非全是只读
操作。两版响应数相同，额外读取为 **0**。

| 路径 | 响应数 | 基线通知 B | 候选通知 B | 基线完整链 B | 候选完整链 B |
| --- | ---: | ---: | ---: | ---: | ---: |
| Task 冷入口 | 12 | 1,910 | 1,783 | 27,736 | 27,609 |
| Task 暖、无摘要 | 7 | 362 | 362 | 6,933 | 6,933 |
| Task 暖、4 个摘要 | 10 | 2,227 | 503 | 16,762 | 15,038 |
| Task 恢复附件、长原件 | 14 | 1,910 | 1,783 | 80,712 | 80,585 |
| Task Skill 版本变化 | 8 | 1,239 | 1,112 | 8,262 | 8,135 |
| Task 暖 Host、指令丢失后全文恢复 | 12 | 489 | 362 | 25,468 | 25,341 |
| Task 当前安装修复后冷入口 | 12 | 1,911 | 1,784 | 27,458 | 27,331 |
| Global 冷入口 | 10 | 1,767 | 1,640 | 21,200 | 21,073 |
| Global 暖、无摘要 | 6 | 368 | 368 | 6,353 | 6,353 |
| Global 暖、单个较长摘要 | 6 | 799 | 368 | 8,029 | 7,598 |
| Global 恢复附件、长原件 | 13 | 1,767 | 1,640 | 123,614 | 123,487 |
| Global Skill 版本变化 | 7 | 1,245 | 1,118 | 7,655 | 7,528 |
| Global 暖 Host、指令丢失后全文恢复 | 10 | 495 | 368 | 19,081 | 18,954 |
| Global 当前安装修复后冷入口 | 10 | 1,767 | 1,640 | 20,914 | 20,787 |
| 合计 | 137 | — | — | 400,177 | 396,752 |

Task 合计减少 2,359 B，Global 减少 1,066 B，总计 **3,425 B（0.856%）**。
普通摘要为 93 B；较长摘要为 398 B；恢复原件正文包含
`"Large original evidence.\n".repeat(1800)`，以覆盖原件分页。
Task 摘要束是四条独立消息，未合并或删除事件。无摘要输入已直接断言
基线与候选通知相等。每个完整链都是同一输入的对照，不拿短暖通知与
冷恢复链相互比较。

这不是大幅节省：完整原件/指令读取仍占主导，恢复链的比例尤其小。
静态 bytes 不能证明真实 token、模型驻留、净收益、成功率或 Agent 行为。
没有使用历史 80 通知/127045 B 的数字推断当前收益，也没有设立固定
阈值或据此宣称其他优化方向应停止。

## 验证与资源

- `make install-local` 完成独立 checkout 构建和本地绝对 launcher 安装；
  未调用该 launcher 的 setup 或启动 Controller/Home。初次 shell 选到
  Node 18 的安装尝试已停止；随后用 Node 24 完整重跑成功。
- 测试先行：新增“delivery 不复制摘要、保留失败状态及原件”断言在基线
  失败，完成候选后通过。扩充既有测试，没有新建重复测试矩阵。
- `npm run build` 通过。
- `node --test test/core/notification-presentation.test.js
  test/core/session-skill-notice.test.js
  test/core/provider-retry-controller.test.js test/core/agent-inbox.test.js
  test/core/context-temporal.test.js`：71/71，通过，测试阶段 2.86 秒。
- `npm test`：989 项，981 通过、8 跳过、0 失败；测试阶段 26.17 秒。
  跳过项为 7 项 macOS 边界及 Node 24 下未安装的可选 sqlite-compat。
  包含 normal/retry 同源 presentation、未知效果不重放、保留旧 claim、
  显式 ACK、全文分页、Host 缺失文件/版本变化/晚到 commit 等既有回归。
- `git diff --check` 通过。没有 runtime 包装变更，未运行 package smoke、
  真实模型、共享服务验证、外部发布或线上安装。
- 合成 fixture 在 runtime `TMPDIR` 中分配，`try/finally` 在分配前建立；
  关闭 SQLite 后删除确切 fixture Home，已验证不存在。没有启动
  Controller、tmux 或 Provider，因此没有待停的 fixture 服务。

## 风险与交接

主动通知不再直接展示作者的自然语言限定语，需要先读其明确指向的原件；
这与已有 mandatory-original 契约一致，但快速分流的便利性下降。Task
机械失败状态仍展示。原件读取失败必须仍停在错误上，不能因为通知短了
就跳过全文或自动 ACK。本地确定性测试不证明模型实际会遵守这些要求。

Task 描述引用的 `93e0b174...:plans/continuous-context-optimization.md`
在当前隔离 checkout 不是可读 Git 对象；未跨工作区追索或 fetch。
本候选按完整冻结 WorkItem objective 和执行 directive 的明确范围完成。

首次 current inbox 为空。后续同身份只读复查遇到 Controller
`CONTROLLER_TIMEOUT`：`controller.status` 请求
`f5c322fe-59ff-4b9a-92dd-913ff111aa8a`，Home
`/data00/home/zhangqian.0326/.yui`；交接前复查请求
`85d5ac9a-230e-4a2a-b7ce-c459ffb4c5ce` 同样超时。
依 Worker 边界未重启共享服务、未换
Home/Session、未伪造 claim/ACK。最终报告须标明无法确认这之后的新输入，
由 Leader/Operator 恢复正常监督；这个读取故障不被当作代码测试失败、
业务接受或重放授权。

建议 Leader 对本候选独立审查并决定是否保留“通知只留机械事实、作者
摘要留在必读原件”的取舍；不与 CLI/Skill/W8 改动捆绑。没有自行接受
WorkItem、完成 Task、推送或发布。
