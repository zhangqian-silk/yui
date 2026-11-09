# Configuration through confirmed conversation

Read both effective configuration and the catalog before explaining or changing
settings:

```sh
yui --json config show
yui --json config describe
yui --json config describe <domain>
```

For Agent-dependent settings, also read:

```sh
yui --json config agent capabilities <agent-id>
```

For a Task Role or a reported launch failure, use the scoped query from
[runtime recovery](../../yui-runtime/references/execution-failure.md)
instead of the global defaults above. The catalog reports native options and
whether custom values are allowed; it is not a complete service-side whitelist.
Distinguish current and cached metadata, and do not invent provider values from memory.

A Profile combines portable behavior with either a dynamic Global Worker
runtime source or an explicit Agent with optional model and effort. Applying it
to a Task Role resolves and freezes that binding; later Profile or Worker
changes do not rewrite the Role. Read `profile show` and `task role show`
before routing or dispatching Agent-specific work, and preserve unrequested
bindings and per-Agent settings.

Leader supports optional `--stage draft|develop` on global and Task Role updates.
Read `role show` / `task role show` first; for stage-native choices use
`task role capabilities <task> leader --stage draft|develop`. Stages override
only Agent/model/effort, not permissions or responsibility. Missing Agent uses the
default active Agent; missing model/effort use the selected Agent's own frozen
binding, never another Agent's settings. `--clear-agent`, `--clear-model` and
`--clear-effort` remove individual overrides; `--clear-agent-config` removes the
whole stage. Global edits affect new Tasks only. Existing Task changes require
explicit Task-level updates. Draft activation selects develop via the existing
planning/delivery handover; retained Sessions and Host restoration keep their
effective snapshot until a legal replacement. Do not promise hot switching,
replay input, or treat desired stage settings as observed native configuration.

When the user requests a change:

1. explain the relevant current value, exact proposed behavior, and material
   consequence;
2. obtain confirmation when the change affects user-owned configuration or
   requires a restart;
3. change only the confirmed fields;
4. read effective configuration back; and
5. restart the Controller only when the catalog says it is required.

Do not silently create a Worker or Reviewer, enable global review, replace
unrelated Role bindings, expose secrets, or make the user run mechanical CLI
steps.

Preserve each Role binding's Agent, model, effort, permission, Profile, and
Session configuration unless the user requests a change. Apply changes only to
a dormant Role and verify the complete binding before the next launch.
