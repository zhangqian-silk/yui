# Run 13 narrow-layout correction evidence

This directory corrects the invalid narrow captures in `../agent-access-run12`. It contains real, isolated-browser evidence from a disposable local fixture at `http://127.0.0.1:4318`, built from the exact checkout under test. The fixture used a real `SqliteTaskStore`, Agent, global Role, Profile, `createWebSettings`, and `createYuiWebServer` with synthetic data. It made no real Provider, model, account, quota, or production calls. It did not touch preview `18150`, port `4197`, production configuration, the global control plane, `main`, or another worktree.

## Invalidated Run 12 evidence

Both prior mobile filenames were factually wrong. Pillow inspection shows:

| Original file | Actual PNG | Why invalid |
| --- | --- | --- |
| `390-agent-observation-zh.png` | 1365 × 800 | It is a desktop capture, not mobile. |
| `390-role-profile-preview-zh.png` | 1365 × 800 | It is a desktop Role home view and does not show the expanded Profile diff. |

The earlier README's blanket statement of a **390 × 800** mobile viewport was also wrong: actual narrow captures use either 390 × 844 or 1365 × 800. I retained both originals under explicit `INVALID-...` names; they are audit evidence only and do not establish narrow-layout success.

## Actual viewport and capture dimensions

`observations.json` records each browser's `innerWidth`, `innerHeight`, document/body widths, and geometry at the moment of capture. Every new PNG below was opened with Pillow and asserted to match the stated CSS viewport exactly.

| Capture | CSS viewport | PNG | Purpose |
| --- | --- | --- | --- |
| `360-agent-native-observation-zh.png` | 360 × 800 | 360 × 800 | Long timestamp in Native Agent observation card. |
| `390-agent-native-observation-zh.png` | 390 × 844 | 390 × 844 | Same card at the other requested mobile width. |
| `360-role-profile-diff-zh.png` | 360 × 800 | 360 × 800 | Expanded Profile diff scrolled to its final rows. |
| `390-role-profile-diff-zh.png` | 390 × 844 | 390 × 844 | Same fully populated diff at 390. |
| `360-role-profile-actions-zh.png` | 360 × 800 | 360 × 800 | Acknowledgement and apply action reachable after scrolling. |
| `390-role-profile-actions-zh.png` | 390 × 844 | 390 × 844 | Same action path at 390. |
| `1365-agent-native-observation-zh.png` | 1365 × 800 | 1365 × 800 | Shared wide layout regression check. |
| `1365-role-profile-diff-zh.png` | 1365 × 800 | 1365 × 800 | Shared wide Profile diff regression check. |

The fixture used a long timestamp (`2026-10-27T14:05:54.952+08:00`), long native model/provider values, and a Profile diff with five rows including long description, instructions, Skill lists and constraints.

## Defects reproduced and local fix

Before the fix, at real mobile widths the no-wrap flex header allowed the 233 px status pill to keep its full width while the adjacent title/description collapsed to only **41.5 px** at 360 and **60.75 px** at 390. The Profile table retained a **343.6 px** minimum table layout inside a **270/300 px** client area, causing horizontal scrolling.

The bounded CSS correction in `src/web/assets/styles/views/settings.ts` lets the Native header wrap, makes its text block shrinkable, allows the timestamp pill to wrap, and fixes the Profile comparison table to the available width with wrapping cells. The focused regression assertions in `test/core/web-settings.test.js` protect those layout properties.

Observed after the fix:

| Check | 360 × 800 | 390 × 844 | 1365 × 800 |
| --- | --- | --- | --- |
| Native card title/description width | 276 px | 306 px | 347.75 px |
| Native header height | 97.66 px | 82.44 px | 48.69 px |
| Timestamp-pill overflow | 0 px | 0 px | 0 px |
| Profile diff scroll/client width | 270 / 270 px | 300 / 300 px | 587 / 587 px |
| Profile rows | 5 | 5 | 5 |
| Document horizontal overflow | none | none | none |

At each narrow width, the Native card was fully visible in its captured viewport. The Profile scroll region reached its bottom (`internalAtBottom: true`), its final constraint row remained visible, no cell reported internal horizontal overflow, and both the one-time-copy acknowledgement and apply action were scrolled fully into view. These are browser observations from one deterministic fixture, not claims about live providers or account availability.

## Fixture and cleanup

The fixture ran from the supplied Task `TMPDIR` with its own temporary Home. It was stopped after capture; port `4318` was verified closed, and only this run's temporary Home and scratch directory were removed. Existing port `4197` and preview `18150` resources were left untouched.
