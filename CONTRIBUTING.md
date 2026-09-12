<p align="right"><strong>English</strong> | <a href="./CONTRIBUTING.zh-CN.md">简体中文</a></p>

# Contributing to Yui

Thanks for your interest in improving Yui! This guide covers the local
development workflow. For the design, start with
[ARCHITECTURE.md](ARCHITECTURE.md) and the
[documentation map](docs/architecture/README.md).

## Prerequisites

- Linux x64 with glibc
- Node.js `^20.17.0`, `^22.9.0`, or `^24.0.0`
- Git and tmux
- For source builds: a Linux C compiler and static libc development libraries
  (used to build the Claude process supervisor). Published npm packages already
  include that executable, so end users do not compile it.

## Set up

```sh
npm ci
npm run build
npm test        # or: npm run test:core
```

`npm run lint` type-checks without emitting. `npm test` builds first, then runs
the seconds-scale core suite (`test/core/*.test.js`).

## Exercise your checkout in isolation

Never use the global `yui` or `make link` to validate local changes. Instead:

```sh
make install-local
<checkout>/output/dev/bin/yui setup     # once; initializes an isolated Home
<checkout>/output/dev/bin/yui doctor
```

`make install-local` writes a single launcher at `output/dev/bin/yui` and does
not touch your `PATH`, the global `yui`, or your data home. The launcher defaults
`YUI_HOME` to `output/dev/home` inside this checkout, so its Controller, tmux
server, and state stay isolated. Always call it by absolute path; re-run
`make install-local` after pulling code, and
`<checkout>/output/dev/bin/yui controller restart` if an older build is running.

## Before you open a PR

- Read [`.agents/skills/develop-yui/SKILL.md`](.agents/skills/develop-yui/SKILL.md);
  it owns Yui-specific implementation and validation rules.
- Follow the [verification policy](docs/testing/verification-levels.md): run
  `npm run build` and the smallest relevant check while iterating. The delivery
  gate is `npm test` / `npm run test:core`, plus the package-start check for
  runtime-packaging changes. Keep the test phase seconds-scale.
- Keep durable Task intent separate from engineering/runtime state, and prefer a
  clear error plus Agent-directed retry over new fallbacks, leases, or repair
  workers (see [AGENTS.md](AGENTS.md)).
- Any change to a persistent schema or payload must add one migration through
  the centralized version chain — never repair runtime state heuristically.
- Keep bilingual docs in sync. The two READMEs ([README.md](README.md) and
  [i18n/README.zh-CN.md](i18n/README.zh-CN.md)) and every page under `docs/`
  (`X.md` plus its `X.zh-CN.md` counterpart) must be updated together when
  behavior changes.

## Validation and real resources

Do not run live-model, paid, shared, or production validation without an explicit
request that names that resource and effect boundary. Use isolated, deterministic
evidence otherwise, and remove temporary harnesses after capturing their output.

## Reporting bugs and requesting features

Open a [GitHub issue](https://github.com/zhangqian-silk/yui/issues). For
security-sensitive reports, follow the [security policy](SECURITY.md) instead.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
