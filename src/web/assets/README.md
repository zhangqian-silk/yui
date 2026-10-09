# Web 仪表盘前端（模块地图）

本目录是 `yui web` 仪表盘的全部前端：静态外壳、样式与浏览器端 ES 模块。
没有打包器，也没有前端运行时依赖（xterm 除外）。浏览器端代码是写在
TypeScript 字符串里的 JavaScript，由 `tsc` 编译进 `dist/`，再由
`src/web/webServer.ts` 按 URL 原样提供。浏览器里只保存视图状态；Task 事实
一律来自 loopback API（`client/lib/api.ts`）。

阅读建议：先看本文件定位，再只打开要改的那个模块。每个模块文件头都有职责
说明；控制器工厂上方的 `deps:` 注释列出了它能用到的全部依赖。

## 怎么被提供

| 源 | URL | 汇总处 |
| --- | --- | --- |
| `shell/index.ts` 的 `DASHBOARD_HTML` | `/`（注入页面 token） | `assetManifest.ts` |
| `styles/index.ts` 的 `STYLESHEETS`（有序） | `/assets/css/<name>.css` | 同上；外壳按此顺序 `<link>` |
| `client/index.ts` 的 `CLIENT_MODULES` | `/assets/js/<path>.js` | 同上 |
| `client/app/main.ts` 的 `APP_SCRIPT` | `/assets/app.js`（入口） | 同上 |
| `fonts.ts` / `fontData.ts`、xterm 包 | `/assets/fonts/*`、`/assets/vendor/*` | 同上 |

新增客户端模块 = 新文件导出 `XXX_SCRIPT` + 在 `client/index.ts` 注册
`"<layer>/<name>"`。新增样式表 = 新文件 + 在 `styles/index.ts` 按层叠顺序插入。

## 分层

```
shared/   TS 端单一事实源：themes（主题令牌）、geometry（断点/列宽）、
          taskTabs（Task 页四个分区与别名）、icons。外壳、样式、客户端
          都在构建期插值引用，三方不会漂移。
styles/   CSS 字符串。tokens/base → layout/workspace → ui/* → views/* →
          markdown → layout/responsive（断点最后，覆盖前面所有）。
shell/    静态 HTML：sidebar、dock、dialogs 三个区域 + index 组装。只固定
          区域和需要跨重绘保持身份的控件；其余由客户端渲染。
client/   浏览器 ES 模块，只向下依赖：
  lib/      DOM、格式化、偏好存储、i18n、主题、API、Markdown（无业务）
  ui/       与领域无关的组件：primitives、containers、controls、
            forms（写入通道 submitWrite）、metrics、text、toast
  domain/   Yui 词汇与记录渲染：vocab、context、records、work、runs、
            taskForms（讨论输入框 / queue·steer·interrupt / 标题表单）
  views/    页面区域：sidebar、overview、globalInput、
            task/*（page + overview/delivery/runtime/records 四个分区）、
            dock/*（discussion、terminal）。纯渲染，回调由上层传入。
  layout/   工作区列与 dock（workspace）、列宽（sizing/resizer）、
            URL 状态（router）、键盘快捷键（shortcuts）
  app/      组装根 main + 持有视图状态的控制器
  i18n/     en.ts（参考目录，定义 MessageKey）、zh-CN.ts（按 en 键类型约束）
```

依赖规则：`lib ← ui ← domain ← views ← layout ← app`，只能 import 左边
（更底层）的层；同层可互相引用但不得成环。`views/` 不持有应用状态：数据
与回调都由参数传入；某个 Task 的局部视图记忆（记录筛选、已读分页等）放在
`detail.viewState`，随该 Task 的详情一起保留。

## 运行时组装（client/app）

`app/main.ts` 是组装根，也是唯一把控制器互相连起来的地方。不存在共享的
`app` 大对象：每个控制器只接收一个显式 `deps`，在工厂上方逐项注释，包含
服务、先创建的控制器（单向）、以及指向后创建控制器的具名回调（由 main
延迟绑定）。

| 控制器 | 职责 | 唯一写入的状态 |
| --- | --- | --- |
| `layout/workspace` | sidebar \| center \| dock 三列、dock 开关/模式/位置/宽度、窄屏 sheet | dock 状态（模块私有）、列宽偏好 |
| `app/taskView` | 绘制选中 Task 页、dock 讨论区与 Session 目标、总览、分区切换、回答输入请求 | `state.activeTab` |
| `app/selection` | 选中/离开 Task、跟随 URL、读取 Context 快照与运行时观测 | `state.selected` / `detail` / `detailKey` |
| `app/catalog` | 5 秒轮询、侧栏（关注项、状态筛选、搜索、分页）、URL 筛选、按页读取 Session | 目录相关字段（见 main 中 `state` 分组注释） |
| `layout/shortcuts` | 键盘快捷键（Escape 逐级回退） | 无 |

创建顺序：workspace → taskView → selection → catalog → globalInput →
shortcuts。主要流程：

- 刷新：`catalog.refresh` → 侧栏 → 未选中时画总览，选中时 `selection.reload` → `taskView.render`
- 选中：侧栏行 / 总览行 / URL → `selection.selectTask`
- 离开：返回按钮或 Escape → `selection.clearSelection`（有未发送草稿先确认）
- 写入：Task 页或讨论区 `afterWrite` → 静默刷新目录
- URL：加载与前进后退 → `catalog.applyFilters` + `selection.followUrl`

轮询保护：`taskView.render` 在中心区有未发送草稿、进行中的读取或焦点时跳过
重绘；`selection` 用 Context 指纹跳过相同读取，保留展开块、分页与草稿。

## 改什么看哪里

| 想改 | 位置 |
| --- | --- |
| 主题颜色 / 新增主题 | `shared/themes.ts`（tokens.css、设置色块、客户端主题列表都由它生成） |
| 断点、列宽、分隔条范围 | `shared/geometry.ts` |
| Task 分区与快捷键 1–4、旧分区别名 | `shared/taskTabs.ts` |
| 某个 Task 分区的内容 | `client/views/task/<overview\|delivery\|runtime\|records>.ts`；运行时观测槽位在 `views/task/observation.ts` |
| Task 页头、分区标签 | `client/views/task/page.ts` |
| dock 行为（开关、模式、居中、窄屏 sheet） | `client/layout/workspace.ts`；外观在 `styles/views/dock.ts` |
| 讨论区 / 原生 Session 终端 | `client/views/dock/discussion.ts` / `terminal.ts` |
| 侧栏列表、筛选 | 渲染 `client/views/sidebar.ts`；数据与分页 `client/app/catalog.ts` |
| 键盘快捷键 | `client/layout/shortcuts.ts` + 设置对话框列表 `shell/dialogs.ts` |
| 文案 | `client/i18n/en.ts` 与 `zh-CN.ts` 同时改 |
| 样式 | 对应 `styles/<层>/<名>.ts`；顺序在 `styles/index.ts` |
| 写入表单 | 表单本身 `client/domain/taskForms.ts`；提交通道 `client/ui/forms.ts` |
| 新的 API 读写 | `client/lib/api.ts`，经控制器 `deps.api` 或 Task 页上下文传入 |
| 选中 / URL / 加载顺序 | `client/app/selection.ts`、`client/layout/router.ts` |

## 陷阱

- 绝大多数脚本是 `String.raw` 模板：其中的 `${…}` 会在构建期插值（用于
  引入 shared 常量），浏览器代码请用字符串拼接；反斜杠按字面保留。
  `lib/markdown.ts` 是普通模板字符串，正则里的反斜杠必须写成双反斜杠。
- 模块内 import 必须是单行 `import { a, b } from "/assets/js/<path>.js";`，
  测试按此格式校验目标资源存在且导出了对应名字。
- 样式依赖层叠顺序：后面的表可以覆盖前面；断点样式必须保持最后。
- en 是参考目录，zh-CN 只能翻译 en 中存在的键（类型检查），缺键回退 en。
  两边保持同键。
- 几何数值只在 `shared/geometry.ts` 定义，不要在 CSS 或客户端里写死。
- Agent 文本只能经 `lib/markdown.ts`（先转义再加标签）或 `textContent`
  进入页面，禁止拼接 `innerHTML`。

## 验证

```sh
node -e 'require("fs").rmSync("dist/web/assets",{recursive:true,force:true})'  # tsc 不删旧产物
npm run build && npm run lint
node --import ./test/helpers/physical-tmpdir.mjs --test test/core/web-evidence.test.js test/core/task-usage.test.js
npm test
```

`web-evidence.test.js` 会对每个提供的脚本做语法检查，并校验模块导入图。
界面改动另需在真实浏览器里走一遍受影响的视图（`scripts/seed-web-dashboard.mjs`
可生成本地演示数据）。
