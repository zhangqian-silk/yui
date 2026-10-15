<p align="right"><a href="./review-evaluation.md">English</a> | <strong>简体中文</strong></p>

# 首轮审查：材料与离线评测

默认单 Reviewer 按风险使用互补视角，不固定 Agent 或 Findings 数量。
验收仍由 Leader 判断。通用方法位于 `skills/yui-reviewer` 和
`skills/yui-leader`；项目命令与架构规则保留在 Project Skill/Policy。

## 材料交接

复用有效要求、决定和验证结果。复杂变更可以保存简短的 Task 工件索引：

- 目标/非目标及有效决定入口。
- 可观察场景、预期行为和独立契约依据。
- 契约入口、调用方及关键风险。
- 候选身份和实际检查结果（提交、环境、命令、结果），区分未执行场景与未覆盖边界。
- 完整复审追加修复 delta、历史 Findings 处置及仍适用证据；当前完整冻结候选仍在范围内。

通过 `task artifact save` 保存索引，将返回的
`git:<commit>:<relativePath>` 放入 Brief。新的 Review Snapshot 包含 Brief
及 active 决定。按 Context inventory 的精确 `store/refId` 读取相关正文并跟完内容分页。
同 Task 工件通过 `task artifact read <task> <path> <commit>` 读取固定提交。
后续 Brief/决定修改不改变既有 Review Snapshot。这不是文档齐全门禁、
自然语言解析器或 Skill 版本冻结机制。普通完整复审与已有等价性 Delta Recheck 保持不同语义。

## 小型开发集

`scripts/review-eval/` 是离线文件工具，不是调度器、模型适配器或新增 Core 存储。
它不调用 Provider，不以任何历史 Task 案例或结果为输入。八个题目均由明确契约新构造。

| 案例 | 能力 | 形态 |
| --- | --- | --- |
| E01 | 半开区间行为 | 入门单根因 |
| E02 | 持久化失败与重试身份 | 一个完整候选内的两个独立根因 |
| E03 | 生产者/消费者不透明游标契约 | 两个模块 |
| E04–E06 | 生命周期、部分结果对应、授权副作用 | 中等状态/契约题 |
| E07–E08 | 区分合法行为与缺陷 | LRU 与渐进展示正确对照 |

每包提供完整候选，不是历史补丁，也不要求仓库基线。要求明确输入、非目标和副作用。
评分侧目录保存根因、触发、违反约束、影响及修复对照。
`verify.mjs` 用独立的字面预期检查可观察行为，验证七个目标根因、通过的修复及正常对照。
这不证明穷尽正确性、独立出题核实或 Agent 效果。额外有效发现需要裁定。

```sh
node scripts/review-eval/evaluate.mjs verify
node scripts/review-eval/evaluate.mjs export E03 basic /absolute/new-participant-directory
```

导出仅投影候选源码与要求；indexed 材料只增加导航索引。两组的必要契约与源码完全相同。
导出不含 gold、修复、评分器、家族标签或 Git 历史，拒绝已有目标目录。
导出失败可能留下部分目录，应检查并避免当作完整受测包使用。

导出不是文件系统沙箱。若受测者能读本仓库、评分目录、先前会话或网络，仍可能获得答案。
只有另行配置的隔离环境确实拒绝这些路径/工具访问，并留存探针证据，才能声称盲测。
“禁止看答案”的提示词不能代替隔离。

这些是公开开发题。未知保留题必须在方法与协议确定后单独编写，独立核实契约并做家族重叠审计。
开发题的改名、修复和近似变体不能变成保留题。保留源码、标签和裁定材料不得进入受测权限或
方法调优会话。本工具明确不伪造保留集，也不声称已评测保留集。

## 运行前固定比较协议

```sh
node scripts/review-eval/evaluate.mjs plan protocol.json
node scripts/review-eval/evaluate.mjs score plan.json records.json
```

按正常工件流程将 stdout 保存为单独文件。协议 JSON 包括非空
`model`、`effort`、`tools`、`environment`、`budget`、`seed`，正整数 `repeats`，
以及 `baseline`/`improved` 两个“Skill 相对路径 → 精确 UTF-8 内容”映射，
包含 VERSION 和必要引用。只在隔离评测配置加载，不修改全局安装。
协议文件属于评分侧，含两种方法，不能整体交给受测者。

计划固定 A=baseline/basic、B=improved/basic、C=baseline/indexed、
D=improved/indexed，记录题库、配置、源码、材料、Skill 摘要与 run ID。
按 seed 排列案例/重复块，并以拉丁轮换平衡组别位置。八题各重复三次是 96 次运行，
不是资源授权或统计效力承诺。各组不得更换模型、预算或工具。
额外独立 Reviewer 属于另一项试验，计入全部生产者与汇总成本，可补同总预算比较。

没有真实执行或自动重试命令。实际运行需要明确资源/副作用授权、全新受测会话和已验证隔离。
保留精确输入、实际加载的 Skill/配置、原始输出与执行/工具证据，不能把投递当成功执行。
重试规则须另行预先规定，保留原失败及全部尝试成本；主分析不得以成功重试覆盖失败的计划记录。
此最小工具每个计划 run 只统计一次尝试。

## 先裁定，再汇总

`records.json` 是数组。每条记录包含计划 `id`、`planDigest`、
实际观察到的 `candidateDigest`、`materialDigest`、`skillDigest`、`configDigest` 及 `status`
（`completed`、`timeout`、`infra-failed`、`not-run`）。
已执行记录还包含 `evidenceRef`、`rawOutput`；未完成记录需要 `reason`。
身份摘要来自执行记录者，本离线工具不为其真实性背书。
实际模型/工具/环境配置保留在证据中；协议偏离应单列排除，不能重标为合规运行。
`configDigest` 对依次包含 `model`、`effort`、`tools`、`environment`、`budget`
的 JSON 对象取摘要。其他摘要使用导出的 `digest` helper
（`JSON.stringify(value)` 的 SHA-256）。报告通过 `recordsDigest` 绑定完整输入记录数组；
该文件应与计划、报告一同保留。

完成记录必须有 `findings`（允许空数组）。每条含 `id`、原始 `claim` 和
`verdict`：`valid`、`invalid`、`pending`、`gap` 或 `suggestion`。
valid/invalid 还必须有 `root`、`reason`、`evidence`。
按语义、触发、违反约束及影响匹配，不按标题或行号匹配；核实证据后才使用题库根因 ID。
gold 外有效根因经单独核实后用 `novel:<stable-key>`，不自动判误报；争议保留 pending。
可行时让评分者不见组别；编题、核实和评分由同一人/Agent 完成时必须披露独立性限制。

可选 `coverage` 条目含 `perspective`、`scenario`、`expected`、`evidence`，
使用案例适用视角。它仍是待检查的覆盖声明，不是自动证明。
可选 `metrics` 包含非负 `wallMs`、`agentCalls`、`toolCalls`、`inputTokens`、
`outputTokens`、`contextBytes`、`cost`（预先约定同一币种）。
缺失值保持缺失，不估造。

报告包含逐题重复召回、已知根因宏/微召回、已裁定去重有效比例、误报及正确对照误报率、
重复/新增/待裁定数、计划完成率与发现产出、成本可得性、Skill/材料/交互差异。
零分母为 null；部分输出保留在原记录，但不混入完整首轮指标。
缺失计划 run 保持 not-run，不算“审查无问题”；失败运行成本仍计入。
完成子集的比较可能有选择偏差，须结合失败、分母及逐题波动解释。
gold 修改后保留旧计划，在统一新裁定版本下重算所有组并同时报告新旧结果。
此小型构造集不产生自动验收阈值或真实项目泛化结论。
