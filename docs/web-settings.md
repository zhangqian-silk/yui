# Web settings

Open **Settings** from the Web sidebar, or `/settings` on the existing loopback
Web listener. General settings are expanded first; advanced configuration,
Agents, global Roles and Profiles load their details when opened. Search uses
the existing catalog's keys, labels and descriptions. Group discovery is paged.

The page is an adapter over the same configuration commands used by the CLI.
It does not introduce a configuration file, a parallel validator, or a Task
policy engine. Base values, default provenance and effect descriptions come
from `configCatalog` and `effectiveConfigData`.

## Saving and adoption

Edit a group and choose **Save group**. Only changed fields are submitted.
Each group checks the read revision and saves transactionally. A rejected
group keeps its draft, including when an earlier field was valid and a later
one failed validation. Other groups' drafts are not replaced. Reset is offered
only where the underlying command has a clear operation.

A conflict offers a current read for comparison. Adopting that read revision
keeps the draft; it does not merge somebody else's edits into it. A lost write
response remains unknown and cannot be replayed from the same page. Inspect
current values and reconcile before beginning a fresh edit.

The success receipt includes the actual command result, a fresh group read and
the Controller refresh result. Saving never automatically restarts a service.

- Browser theme and language apply immediately in the current page.
- Global defaults and Profiles affect subsequent selection or newly created
  objects. Existing Task Roles keep their saved bindings.
- Global Role launch settings and Agent connection settings affect later Host
  starts. Changing settings for a live Session requires the same explicit
  acknowledgement as the CLI. The Session keeps its effective snapshot.
- Explicit global Role Agent selection is saved alone, through the existing
  binding operation and its live-session/lifecycle guards. Read the selected
  Agent's fields before editing them.
- Reconciliation interval changes refresh the current Controller timer.
  Other fields retain their catalog-defined immediate/restart boundaries.
- Terminal history limits affect new tmux sessions, not existing history.

Structured fields such as arguments, Skills, health thresholds and Review use
JSON controls. Agent environment configuration accepts process-variable
references, not literal values. Presence is observed in the Controller's
environment; a missing variable must be supplied outside this page. Native
account authentication remains the Agent's responsibility.

## Native metadata and browser access preference

Capability reads use the existing Agent catalog service on demand. The page
preserves live/cache/fallback provenance, timestamps, failures, unsupported
fields and warnings. An unavailable query is not an empty account model list.
Static adapter fields describe accepted configuration, not account entitlement.
No real model execution is needed for the deterministic settings tests.

Session entry consumers can import `readSessionAccessMode` and
`writeSessionAccessMode` from `/assets/js/lib/prefs.js`. The browser-local
`yui.session.accessMode` key accepts `native` or `structured`, with `native`
as the fallback. The setting affects subsequent entry where supported; it does
not switch a live Session or promise support that the selected Agent lacks.
