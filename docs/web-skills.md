# Skill browsing and Role bindings

Open **Settings → Skills · browse & bind**. Search existing built-in Skills and
`YUI_HOME/skills/<id>` by ID or description, then read `SKILL.md` and select
individual resources. The reader displays UTF-8 text as data; it never executes
scripts or renders package HTML.

Choose **Global Role**, or **Task Role** with an exact Task ID, then load the
Role. Add or remove bindings and save. Drafts remain attached to that Role until
saved or explicitly discarded by reloading. Removing a binding does not delete
its package. Built-in Role instructions are automatic and are not removed by
clearing additional bindings.

Saving uses the same Role commands as CLI:

- Global: `config role update <role> --skill <id>` / `--clear-skills`.
- Task: `task role update <task> <role> --skill <id>` / `--clear-skills`.

The Web adapter requires the read revision, preserves runtime/lifecycle guards,
and validates the entire package before changing the Role. A live global Session
requires explicit acknowledgement that it retains its existing version. A stale
read must be reloaded. A save with an unknown outcome is not automatically retried:
reload and compare before editing again.

## Configuration is not loaded evidence

Configured bindings describe a subsequent launch. Saving does not restart a
Session or rewrite any frozen Session or AgentRun. The panel separately shows
the selected Agent's stored Session identity, status, launch revision, desired
revision, package digests, and original source locations. This is recorded launch
evidence, not a probe proving that a model read every file.

The frozen reader uses only references from the stored Session or Run and
requires the exact displayed package digest. It verifies the package before
reading; changed, missing, or unrecorded snapshots fail explicitly. It never
substitutes current source for history. Existing Task runtime and Run cards also
show their frozen package provenance.

Current-source reads are labelled `current-source` and carry a **file** SHA-256,
not a claimed frozen package version. A resource edit may change the next loaded
package even when `SKILL.md` is unchanged.

## Scope and limits

- Local-user Web token authentication applies to reads and writes.
- Catalog pages contain at most 30 entries; search is limited to 256 characters.
  Configured discovery is limited to 2048 entries.
- Source inventories are limited to 2048 files, 4096 entries, and depth 32.
  Only the selected resource body is returned, up to 256 KiB of valid UTF-8.
  Symlinks, special files, binary/control-byte content and paths outside the
  chosen inventory are refused. Launch package validation retains its existing
  stricter/different limits.
- Unknown, missing, unreadable, oversized and invalid packages report a reason.
  Browsing does not install or create a snapshot. Saving retains the existing
  package validation/snapshot behavior of Role commands.
- No package install/delete, marketplace, dependency resolution, script editor,
  native-provider validation, or new persistent format is introduced.

The narrow `/api/skills/catalog`, `/roles`, `/role`, and `/file` endpoints compose
these existing authorities; they are not another configuration store. Frozen
file reads can name an exact Task `run` plus Role and package digest; ordinary
UI reads use the selected Session. No client-supplied filesystem path or package
reference can authorize a frozen read.
