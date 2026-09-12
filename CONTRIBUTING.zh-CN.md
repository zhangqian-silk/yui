<p align="right"><a href="./CONTRIBUTING.md">English</a> | <strong>简体中文</strong></p>

# 为 Yui 做贡献

感谢你有兴趣改进 Yui！本指南介绍本地开发流程。关于设计，请从
[ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md) 和
[文档导航](docs/architecture/README.zh-CN.md)开始。

## 前置条件

- Linux x64 / glibc
- Node.js `^20.17.0`、`^22.9.0` 或 `^24.0.0`
- Git 和 tmux
- 源码构建还需要：一个 Linux C 编译器和静态 libc 开发库（用于构建 Claude 进程
  监督器）。已发布的 npm 包已包含该可执行文件，因此最终用户无需编译。

## 初始化

```sh
npm ci
npm run build
npm test        # 或：npm run test:core
```

`npm run lint` 做不产出文件的类型检查。`npm test` 会先构建，然后运行秒级的核心套件
（`test/core/*.test.js`）。

## 在隔离环境中验证你的 checkout

绝不要用全局 `yui` 或 `make link` 来验证本地修改。应改为：

```sh
make install-local
<checkout>/output/dev/bin/yui setup     # 一次；初始化一个隔离 Home
<checkout>/output/dev/bin/yui doctor
```

`make install-local` 只在 `output/dev/bin/yui` 写入一个 launcher，不改动你的 `PATH`、
全局 `yui` 或你的数据 Home。该 launcher 把 `YUI_HOME` 默认为此 checkout 内的
`output/dev/home`，因此它的 Controller、tmux server 和状态都保持隔离。始终用绝对
路径调用它；拉取代码后重新执行 `make install-local`，若有旧构建仍在运行则执行
`<checkout>/output/dev/bin/yui controller restart`。

## 提交 PR 之前

- 阅读 [`.agents/skills/develop-yui/SKILL.md`](.agents/skills/develop-yui/SKILL.md)；
  它负责 Yui 专有的实现与验证规则。
- 遵循[验证策略](docs/testing/verification-levels.zh-CN.md)：迭代时运行
  `npm run build` 和最小的相关检查。交付门是 `npm test` / `npm run test:core`，外加
  针对运行时打包变更的 package-start 检查。把测试阶段保持在秒级。
- 把持久的 Task 意图与工程/运行时状态分开，并优先用清晰的错误加上 Agent 主导的重试，
  而不是新的 fallback、lease 或修复 worker（见 [AGENTS.md](AGENTS.md)）。
- 任何对持久 schema 或负载的变更都必须通过集中式版本链新增一条迁移——绝不启发式地
  修复运行时状态。
- 保持双语文档同步。两份 README（[README.md](README.md) 和
  [i18n/README.zh-CN.md](i18n/README.zh-CN.md)）以及 `docs/` 下的每一页（`X.md` 加上
  对应的 `X.zh-CN.md`）在行为变更时必须一并更新。

## 验证与真实资源

不要在没有明确点明该资源和效果边界的请求下运行真实模型、付费、共享或生产环境的
验证。其余情况使用隔离的、确定性的证据，并在捕获输出后移除临时 harness。

## 报告缺陷与提出功能建议

提交 [GitHub issue](https://github.com/zhangqian-silk/yui/issues)。对涉及安全的报告，
请改为遵循[安全策略](SECURITY.zh-CN.md)。

一旦贡献，即表示你同意你的贡献按 [MIT 许可证](LICENSE)授权。
