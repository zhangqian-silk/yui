# Agent access visual verification

This directory contains representative screenshots from the final rebuilt `dist` served by two disposable, isolated fixtures:

- writable: `http://127.0.0.1:4197/settings/agents`
- read-only: `http://127.0.0.1:4198/settings/agents`

Both used real `createYuiWebServer`, `createYuiWebSettings`, SQLite and temporary Home directories. They made no Provider/model/account calls and did not touch preview `18150`, real services, configuration or quota.

## Final browser measurements

Measured CSS viewports and browser results:

| Viewport | Horizontal overflow | Footer visible while scrolled | Footer clears canvas at bottom |
| --- | ---: | --- | --- |
| 360 × 800 | 0 | yes | yes |
| 390 × 844 | 0 | yes | yes |
| 768 × 1024 | 0 | yes | yes |
| 1024 × 768 | 0 | yes | yes |
| 1365 × 800 | 0 | yes | yes |
| 1920 × 1080 | 0 | yes | yes |
| 1092 × 640 (125%-equivalent width) | 0 | yes | yes |

The footer is the inspector's sticky action bar. `.agent-inspector` uses `overflow:clip`, not `overflow:hidden`; the latter establishes a sticky containing block and makes the footer disappear behind long content.

Screenshots cover initial layouts, selected Agent/Role/Profile details, scrolled long content, localized English, the read-only snapshot and the shared Server page. The mobile inspector collapses the master index after selection while keeping drafts mounted.

## Interaction findings

- A 606-character Role draft survived switching to an Agent and back; the footer reported `1 项未保存`.
- Close rendered the explicit empty state and restored focus to the selected Role row.
- The read-only fixture had 27 ordinary field controls: 26 disabled and only the Profile template selector enabled. Save and Profile confirm were blocked; preview remained available.
- The localized Profile preview replaced backend English prose with the Chinese one-time-copy contract and showed no English notice leakage.

## Shared-page regression boundary

`/settings/server` rendered from the real rebuilt assets, had zero horizontal overflow, used the correct `Yui 服务` heading and did not show the Agent inspector's `Agent 执行工具` label.

`/models/providers` correctly routed to `Provider 管理` with the localized header and zero horizontal overflow, but its data panel reported the fixture's explicit `Model management unavailable` limitation because the disposable harness did not provide the model-management dependency. That Provider panel is therefore not claimed as a full visual pass; the deterministic Provider tests passed in the complete gate.

## Verification

- `npm run build` — passed
- `npm run lint` — passed
- focused settings tests — 8/8 passed
- `npm test` (Node 24) — 952 passed, 0 failed, 8 platform-conditional skips
