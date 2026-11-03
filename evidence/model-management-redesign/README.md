# Model management redesign — browser evidence

Isolated fixture only: real `createYuiWebServer` + `createWebSettings` + `createModelManagement`
over a temporary SQLite Home with fake catalogs and upstream HTTP disabled. No Provider, model,
quota, metabridge or CLIProxyAPI call was made; the 18150 preview and personal config were not used.

Reproduce: `npm run build`, then `harness/start.sh full 4301` (also `readonly 4302`, `empty 4303`,
`nomodels 4304`), then feed `harness/measure.py`, `harness/interact.py` or `harness/touch.py` to
`browser-use` (they write screenshots to `/tmp/yui-t150-wi6/`; adjust paths as needed).

## Design rationale (short)

- **IA.** One "Models" area with three peers: *Execution configs* (roles + Profile templates: what a
  new Session launches with), *Agents* (native tools, their own default model, and whether Yui routes
  them to an endpoint), *Model services* (Yui endpoints and native Providers, split by connection
  protocol: Codex · Responses vs Claude · Anthropic Messages). metabridge / CLIProxyAPI are optional
  components inside Model services, each showing the file it owns — never top-level pages.
- **Layout.** Full-width list first, no auto-selection and no empty right pane. Selecting a row opens a
  contextual detail: split view ≥900px container width, detail-replaces-list below it, compact card rows
  ≤640px. Secondary field groups are collapsed `<details>`.
- **Truthful launch facts.** Each row shows the model · effort a new Session actually gets, with source:
  endpoint binding > role/Profile value > Agent native default. If the binding overrides a saved value,
  the detail says so. If `/api/models` is unreadable the route is shown as Unknown, not guessed.
- **One guide.** Every page/entity has one "Ask Operator…" entry: free-text intent → context-specific
  prompt preview → copy. No questionnaire, nothing executed, IDs whitelisted, and text that looks like a
  credential blocks copying and is redacted from the preview.
- Kept: drafts across row/section switches, per-section dirty dots, live-session notes, conflict/readback
  protection and catalog/quota freshness labels. A read-only snapshot (e.g. a preview of live config)
  looks exactly like the live page: no snapshot badge, timestamp or debug note; only saving is blocked.

## Files

- `before-*` — previous design (1365).
- `r1..r5-*` — role/agent detail, services, guide, 390 list/detail/services, empty, nomodels.
- `m-<width>-<page>.png` + `measurements.json` — 360/390/768/1024/1365/1920 × roles/agents/providers:
  PNG equals CSS viewport, `docW == vw`, no element past the right edge, first content row 191–324px.
- `i1..i8-*` + `interactions.json` — scripted interactions:
  - draft edit → other row → other section → back: draft retained, row "Unsaved" badge, nav dirty dot;
  - keyboard: Enter on a focused row opens detail and focuses Back; Enter on Back closes and restores
    focus to the same row (`:focus-visible` true);
  - collapsed section expands; 390px: detail replaces list, Back returns to list with focus restored;
  - guide at 390: copy disabled while empty, enabled with intent, disabled + redacted with a secret,
    close restores focus;
  - read-only (`ro-*`): no snapshot/provenance text anywhere on roles, agents, services or an opened
    detail at 390 and 1365; Save stays disabled;
  - nomodels: services page shows the read error with Retry;
  - touch (`pointer:coarse`): rows ≥81px, every button/summary ≥40px.

## Detail panel simplification (follow-up)

The detail is one frame with a flat interior: a header with the name and the launch facts on one line
(Agent · model · effort · source), groups separated by hairlines with small muted headings instead of
nested cards, saved value and reset on one row under each field, the "defaults apply to later launches"
note moved into the sticky footer (replaced by the unsaved count while editing), and the model-source box
removed — the header already states it; only an override warning remains as a slim inline strip.
Screenshots: `d-1365-role.png`, `d-390-role.png`, `d-1365-agent.png`, `d-1365-role-expanded.png`,
`d-1365-dirty.png`.

## Second pass: denser fields and open/close motion

- Each field is now one label row (name · saved value · Reset) above its control. Help text is the
  control's description: visible while the field is focused, on hover (title) and to screen readers
  (`aria-describedby`), hidden otherwise. Section intro paragraphs are hidden the same way.
- Opening/closing a detail on wide layouts runs a same-document View Transition: the list glides to its
  new column (old layout fades out before the new one fades in, never both), the detail slides in 24px
  from the side. Switching rows while open fades/rises only the detail content. Narrow layouts rise the
  detail (or the list on Back) in. `prefers-reduced-motion` and browsers without the API change instantly.
- `harness/motion.py` checks: transition started/finished for open and close, row switch animates the
  content only, focus shows help + `aria-describedby`, 390 animates the detail, reduced motion runs no
  transition. `c-open-frame1.png` is a frame captured at 8% playback.

## Third pass: compact core block and self-explaining sections

- Enabled / Agent / Model / Effort are one compact block without headings: each is a single line
  (short label · control · Reset), two per row when the detail is wide (76px for all four at 1365/1920),
  four 34px lines at 390. Full field names and the saved-value note are hover titles.
- "Native capabilities" became one line under the model fields: what it does ("read the options this Agent
  supports and pick from a list"; tooltip: no Session, no quota) and one "Read supported models" button;
  "Read again" appears only after a read. Agents without a model field no longer show it.
- Collapsed groups say what they hold in the summary (e.g. Workspace — default working directory for new
  Sessions); "Apply from Profile" is now "Overwrite from a Profile template — copy once, preview first".
- The running-Session acknowledgement appears only once there are edits to save; the duplicate
  "Unsaved changes" receipt line is gone. `harness/compact.py` measures the block and the dirty state.

- Execution members have no separate Reset checkbox: the user picks or types the value; emptying a clearable field removes the saved setting (same CLI clear operation). Server settings keep their reset. `r-*-no-reset.png`.

## Fourth pass: no diagnostics, workspace inline, Profile dialog

- Execution members no longer show "Configuration source & evidence" or the raw observation JSON (server
  settings keep theirs). The Role workspace is a full-width line in the compact block, not a collapsed group.
- "Apply a Profile template…" is a row that opens one dialog: template cards (name, Agent · model · effort,
  description; unavailable ones disabled with the reason), then the exact change list flattened to single
  settings (nested execution config → Model / Effort rows, adapter id omitted when the Agent changes), then
  Cancel / Apply template. The live-Session acknowledgement appears only when a Session may be live. Esc or
  × closes and returns focus to the row; read-only previews but cannot apply. `harness/profile.py`,
  `p-*.png`.

- Fifth pass: the Role workspace is no longer shown (nor written) in execution details. The template picker is a single radio list: name + description, one 42px line each; launch facts appear only in the change list. `s-*.png`.

- Sixth pass: choosing a template previews the description, system instructions and constraints the Role will read after applying (Changes / Unchanged tag each; long text clamps with Show all). The preview API adds an additive `result` with those three values; the settings table keeps the short settings. `t-*.png`, `harness/profile-text.py`.
