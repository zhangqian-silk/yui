# Run 12 settings regression evidence

This directory contains browser evidence from a disposable local fixture at `http://127.0.0.1:4317`. The fixture used rebuilt repository assets with real `SqliteTaskStore`, a configured Agent, global Role, Profile, model management, `createWebSettings`, and `createYuiWebServer`. It used synthetic Agent/Provider configuration, a deterministic model catalog, and temporary files. It made no real Provider, model, account or quota calls and did not touch preview `18150`, production configuration, global control-plane state or other worktrees.

## Browser measurements and coverage

All captures use Chinese. The CSS viewports were **390 × 800** (mobile) and **1365 × 800** (desktop). Both measured `scrollWidth === clientWidth`, including the expanded Provider records. Earlier representative responsive coverage in `evidence/agent-access-final/README.md` remains applicable to unchanged layout behavior; this run repeats only the affected and previously missing paths.

- `/settings/server`: correct shared CLI source/reset/no-restart notice, distinct Defaults and Runtime groups, the time-zone next-render effect, and localized comparison values. The backend Server notice and raw English Role launch text are absent.
- Agent/Role/Profile details: each comparison view uses its own localized source/semantics explanation. Backend Agent, Role and Profile notice prose is not appended.
- Native Agent overview: shows the actual `观测时间 · 2026-10-27T08:00:00Z`; an absent timestamp is unit-tested as `未报告观测时间`, not left blank or presented as current.
- Role: has one later-launch notice, a distinct ordinary-Save live-session acknowledgement, and a separate one-time Profile-copy acknowledgement. The Profile preview is localized, fenced, and clearly labelled before copying.
- Provider data panel: visible metabridge, CPA and native Provider facts with long names and URLs, expansion without horizontal overflow, and keyboard-visible focus on a record summary. Credential sentinel strings are absent.
- The compact mobile master/detail composition and long-path wrapping remain usable in the inspected captures.

`browser-results.json` records the three browser check groups as passed. Captures are `1365-server-zh.png`, `1365-server-compare-zh.png`, `390-role-zh.png`, `1365-role-zh.png`, `390-role-profile-preview-zh.png`, `390-agent-observation-zh.png`, `390-providers-zh.png`, `390-providers-expanded-zh.png`, and `1365-providers-expanded-zh.png`. Structured observations are in the adjacent JSON files.

## Fixture and cleanup

The fixture ran from the supplied task `TMPDIR` with a temporary Home owned by this run. Its exact process was stopped after capture, port `4317` was verified closed, and only this run's temporary Home and fixture scratch directory were removed. Existing port `4197` resources were left untouched.
