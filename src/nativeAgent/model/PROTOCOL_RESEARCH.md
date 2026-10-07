# Task-87 协议补核与交接

日期：2026-10-04（Asia/Shanghai）。WorkItem：work-item-1，续接 run-5。
这是代码工作区内的研究补充，供 Leader 采用为修订 Task Artifact；
它自身不冒充已保存的 Task Artifact，也不代表 WorkItem 或 Task 已验收。

## 固定研究与本轮边界

原研究/比较/实施方案由 Leader 固定为
`git:e7760384074e8bae6af210db7ff2b43d76ccde21:research/protocols-and-capabilities.md`。
本轮通过合法 `task artifact read` 完整读取，内容 digest 为
`84db17000c870b6fe091721b7dda60c80ec7f7a31d6ecfce7e9fbaa6cbfe9165`。
它在 Task Artifact 仓库，不在项目代码仓库；不能以本 checkout 的 `git show`
是否存在来判断 Artifact 是否存在。

message-7 撤销了旧 message-3 的读取前提；本轮未绕过旧 Assignment 拒绝。
精确 Context 是 `task-87/run-5`、`context-snapshot-5`，
digest `102ad08654ff662a7bc7633dfe203991292c2c3451b84eb39eb2ca1171efa153`；
完整 message-1 仍是用户要求。开发授权已明确，不是 Draft 讨论自行开工。
修改仅在合法 project-1/work-item-1 checkout；保留并审查了先前未提交修改。

## 官方字段补核

以下材料实际读取于 2026-10-04。只核查列出的部分，不声称整库审计或
这些固定版本永远是最新版本。未复制第三方实现、未添加 SDK 运行依赖。

1. OpenAI 官方 docs：
   `https://developers.openai.com/api/reference/resources/responses/methods/create`
   通过官方 docs MCP 读取仍是生成式入口，没有完整 schema 正文。
   官方 OpenAPI endpoint `https://api.openai.com/v1/responses` 返回版本 2.3.0，
   本轮实际读取 create 请求、完整 text/tool/stream 示例及 usage；响应中的
   component refs 不等于已读取全部 component schema。
   另实际读取官方 function-calling 页面相关 strict 内容。

2. 为补足输入与 create 类型，固定 OpenAI 官方 TypeScript SDK：
   repo `openai/openai-node`，main ref 由 `git ls-remote` 得到
   `11b9283f2a22737e273ccc1593d01af5cf584a0b`。
   随后以该 commit 读取
   `src/resources/responses/responses.ts` 中的 EasyInputMessage、
   ResponseInputContent、ResponseOutputMessage、FunctionTool、
   ResponseFunctionToolCall/Output，以及 create 的 input/store/stream/
   truncation/max_output_tokens 字段。
   `https://github.com/openai/openai-node/blob/11b9283f2a22737e273ccc1593d01af5cf584a0b/src/resources/responses/responses.ts`

   补核确认：input messages 可以携带 caller-owned assistant 字符串；
   output_text 则属于带 id/status/type 的 ResponseOutputMessage，不能把缺失
   元数据的 output item 混作输入消息。自有历史不存服务器 item ID，故用
   EasyInputMessage，而不是伪造 ID。function_call 保留原 call_id，
   function_call_output 保留原 call_id 和字符串 ToolOutcome。
   store:false、truncation:disabled、stream、max_output_tokens 与扁平 function
   的 name/parameters/strict:false 均有官方字段依据。

   SDK 还公开 assistant phase、异步/program caller 和 namespace。
   当前内核没有这些语义的保真类型；本次明确拒绝，而非丢弃后执行。
   因而不能声称适配所有当前 Codex/Responses 模型，即使它们提供该 API。
   API 中更广的输入类型也不等于本结果支持图片、文件或服务端工具。

3. Anthropic 托管规范：
   实际尝试 `https://platform.claude.com/docs/en/api/messages/create` 与 `.md`，
   仍被重定向到 “App unavailable in region”。没有目标规范正文，
   未通过代理、账号或其他区域绕过。网页检索工具未取得可用证据。
   按 message-7 指导，使用固定官方 SDK 校准窄子集，保留这一证据缺口。

4. Anthropic 官方 TypeScript SDK：
   repo `anthropics/anthropic-sdk-typescript`，
   commit `d49bdab458000bcdffe77bd84b03293f31824fb3`（原固定报告版本）。
   本轮实际读取 `src/resources/messages/messages.ts` 的 create 参数、
   Message/TextBlock/ToolUseBlock、raw stream events、Usage/MessageDeltaUsage
   相关段；`src/client.ts` 的 API key 检查及固定版本 header；
   `src/lib/MessageStream.ts` 的 start/block/delta/stop 累积相关段。
   `https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts`

   确认 max_tokens 为 create 的显式字段、system 顶层表达、text/tool_use/
   tool_result 结构、x-api-key、anthropic-version:2023-06-01、
   stop_reason 和 message_stop 终止、input_json_delta 参数碎片。
   output/input/cache 计数更新是累计值，不逐帧累加，也没有可据此伪造的
   total_tokens。SDK MessageParam 的 union 包含 system，但同文件 create
   文档仍明确顶层 system；本实现选择原报告规定的保守无损子集，
   不根据矛盾的宽泛 union 推断中途 system 支持。
   本结果不支持 SDK 的 server tools、thinking、citations、toolsets、
   assistant prefill、cache 控制或 beta 扩展。

## 与固定比较的交叉核验和方案差异

原 Artifact 记录 pi/Codex/Claude Code 来源 commit、许可与 Yui 差距；
本轮又读取以下相关段，没有运行上游测试或安装第三方内核：

- pi commit `200387122ca450d6387f033949423114a270b96c`，
  `packages/ai/src/api/openai-responses-shared.ts`。它的输出消息重送保留
  id/status/annotations/phase，工具区分 call_id 与 item.id，并支持 namespace。
  Yui 不具备它的更广历史类型，选择标准 input message 和原 call_id；
  不复制拼接 ID、跨模型归一化或 phase 丢弃行为。
- Codex commit `afb436df8b70bb5bc57b86d9a3e829968988cd21`，
  `codex-rs/codex-api/src/sse/responses.rs` 的 output_item.done、failed/
  completed/incomplete、EOF 和内嵌 tests 相关段。EOF 不能代替终态；
  其受产品语义控制的 interrupted 处理不照搬。Yui 保守拒绝所有 incomplete。
- Claude Code 官方 `how-claude-code-works.md` 的 agentic loop/model/tools/
  environment 相关段仍说明 harness，而不是 wire codec。内部 codec、
  retry、usage 处理仍未知。Anthropic SDK 不是 Claude Code 私有内核的证据。
- 原报告许可边界保留：pi MIT、Codex Apache-2.0；Claude Code 不得按
  可移植内核处理。本次只独立实现协议，未复制来源代码。

总体架构不变：一个 ModelGateway 负责请求冻结、结果校验、取消、deadline、
有限安全重试和 reader 结算；三个 codec 负责 wire；共享 SSE helper 仅做 framing。
没有新增 Runner、认证平台、模型目录、状态机恢复服务或模型循环。

补核导致的实际修正：

- assistant 历史改用合法 Responses input message，避免 schema 混用。
- Responses async/program caller/namespace/phase 和未知 item/block 字段显式失败；
  保留直接文本/function 子集，不吞掉服务器动作语义。
- 新协议已知流内错误保留 authentication/quota/rate_limit 分类；所有
  HTTP200 流错误仍是未知效果，绝不触发自动重放。未知流错误为 incomplete。
- usage 的 input/output/total/cache 字段可缺席；Messages 不合成总数，
  缓存写入计数经现有统一组合入口到 observability，不建立第二套权威类型。
- model capacity 仅声明；contextWindow 不被当作本层已验证的 token 预算。
  配置与压缩仍分别归调用方/其他授权结果，不访问其私有工作区。

公开合同、协议映射、上限、不支持项、消费者样例见同目录 README.md 和
model/index.ts。仅新增 maxOutputTokens 参数；未知请求/配置参数 pre-send 拒绝。

## 本轮实际验证和资源

环境：Linux、Node 24.20.0；项目基线
`ff0b12cfe6c521ea3087d8dcd4d47f6d9a6b4f10`。

- 启动检查：原有修改已保留；未发现归属于该 checkout 的遗留测试进程，
  output/dev 仅已有本地 launcher，没有测试 Controller/Home。未假定旧测试通过。
- `make install-local` 成功，build 成功；仅生成 checkout 本地 launcher，
  没有替换全局 CLI、初始化/重启全局 Home。
- 首次 model/protocol focused：12/12 通过。
- 三项新回归先失败（历史编码、执行语义丢弃、流内错误分类），完成修正后，
  最终 `npm run build` 与以下 focused 命令成功，15/15 通过，约 0.20 秒：
  `node --import ./test/helpers/physical-tmpdir.mjs --test test/core/native-agent-model.test.js test/core/native-agent-protocols.test.js`
- `npm run test:core`（含规定的 prebuild）成功：
  567 tests，560 pass，0 fail，7 skip，测试阶段 7773.759077 ms。
  7 skip 是已有 macOS 专属边界，当前 Linux 环境未运行；没有跳过本次协议测试。
- `git diff --check` 成功；完整 diff 与相邻消费者自审，无独立 Reviewer 结论。
  无包装/发布修改，不额外运行 assembled-package smoke。

fixtures 使用 loopback HTTP/fake transport、dummy credentials 和固定 JSON/SSE：
涵盖保留 Chat、两种新协议文本/多个工具调用的完整循环、UTF-8 分片、
具名事件/序号关联、delta 不执行、失败/截断/EOF、重复/错位 ID、
未知语义、请求配对、不支持参数、认证/限流、usage 缺失/累计/缓存、
脱敏、取消、读流释放、无未知效果重放和旧 Gateway deadline/retry 边界。
这些断言不能证明真实账号、模型或服务兼容性。

HTTP server teardown 在 listen 前注册；读流由 Gateway 关闭；
测试结束后没有发现该 checkout 或本运行 TMPDIR 下的 fixture 进程、
Controller/socket/Home，临时目录仅保留运行环境的 runtime 目录及 Node compile
cache，不删除管理运行环境。未启动真实模型测试，未 push/PR/merge/tag/npm，
未更改版本、全局 Home、账号、模型或 effort。

Leader 下一步：采用本补充为修订 Artifact，检查候选 commit 和固定研究引用，
再决定 Review/WorkItem 验收与后续集成；Worker 不代替这些决定。

## work-item-2 / run-8：function_call 可选状态窄修复

在本修复 checkout 重新通过合法 `task artifact read` 读取上述固定原研究及
`git:b9f0faf2b9d9d09ae97f03de258d29eaeca0ac3a:research/protocol-implementation-supplement.md`。
message-13 不在本次 Assignment 可读范围；使用 run-8 派发的独立问题重述，
未跨读旧 Worker/Reviewer 工作区。

实际补核 OpenAI 官方 function-calling guide 的 streaming 段：
`https://developers.openai.com/api/docs/guides/function-calling#streaming`；
其 added/done 样例均省略 function_call 的 status。另读取上述固定官方 SDK
commit `11b9283f2a22737e273ccc1593d01af5cf584a0b` 的
`ResponseFunctionToolCall` 接口，status 为可选的
`in_progress | completed | incomplete`。生成式 create 文档入口仍无完整 schema；
没有将入口视为 schema 审计，也没有将示例视为完整响应终态。

离线 JSON 与完整分片 SSE 回归先证实省略 status 会使工具 Turn 失败，
仅在 function_call 缺席该字段时放行。显式无效/不完整状态、message 状态、
参数 done、item done、response completed 与关联/一致性检查保留。
未新增 fallback、重试或持久状态，未扩大工具语义支持范围。
