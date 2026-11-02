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
- Kept: drafts across row/section switches, per-section dirty dots, read-only snapshot mode, live-session
  notes, conflict/readback protection, provenance and freshness labels.

## Files

- `before-*` — previous design (1365).
- `r1..r5-*` — role/agent detail, services, guide, 390 list/detail/services, empty, read-only, nomodels.
- `m-<width>-<page>.png` + `measurements.json` — 360/390/768/1024/1365/1920 × roles/agents/providers:
  PNG equals CSS viewport, `docW == vw`, no element past the right edge, first content row 191–324px.
- `i1..i8-*` + `interactions.json` — scripted interactions:
  - draft edit → other row → other section → back: draft retained, row "Unsaved" badge, nav dirty dot;
  - keyboard: Enter on a focused row opens detail and focuses Back; Enter on Back closes and restores
    focus to the same row (`:focus-visible` true);
  - collapsed section expands; 390px: detail replaces list, Back returns to list with focus restored;
  - guide at 390: copy disabled while empty, enabled with intent, disabled + redacted with a secret,
    close restores focus;
  - read-only: 27 fields, only the Profile template picker (preview only) enabled, Save disabled;
  - nomodels: services page shows the read error with Retry;
  - touch (`pointer:coarse`): rows ≥81px, every button/summary ≥40px.
