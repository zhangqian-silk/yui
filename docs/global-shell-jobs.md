# Global Shell Jobs

A global Shell Job owns its command steps, environment and text script files.
It needs neither a Task nor a Project. The Web Jobs editor and CLI edit the
same revisioned definition. Saving never starts a Run.

Commands execute as the local Yui user, **not in a security sandbox**. Do not
store credentials in commands, scripts or environment variables. Task-scoped
Shell Jobs retain their existing managed Project/workspace authority.

## CLI

Create a command-only Job:

```sh
yui job define --global --job hello --title "Hello" --command 'printf "hello\n"'
```

Import a local script into a Job-owned relative path (the file contents are
copied, not linked to the mutable source file):

```sh
yui job define --global --job check --title "Daily check" \
  --command 'sh scripts/check.sh' --script scripts/check.sh=./check.sh
yui job show --global --job check --json
```

Edit the local script and upload a replacement using the revision returned by
`show`. Existing commands and other script files are preserved:

```sh
yui job update --global --job check --revision 1 \
  --script scripts/check.sh=./check.sh
yui job update --global --job hello --revision 1 --command 'printf "updated\n"'
```

`--script` can be repeated for different paths. To edit multiple steps,
environment variables, or remove files, use `--input-file config.json` with
the complete configuration:

```json
{
  "kind": "shell",
  "env": {},
  "steps": [{"name": "check", "command": "sh scripts/check.sh", "timeoutMs": 60000}],
  "files": [{"path": "scripts/check.sh", "content": "printf 'ok\\n'\n"}]
}
```

Pass `--title` with complete-configuration define/update. Re-read the current
revision after a conflict instead of blindly retrying. A full configuration
replaces the previous one; shorthand edits preserve unrelated fields.

Run explicitly and inspect the exact returned Run:

```sh
yui job run --global --job check --request-id check-20261023-1
yui job runs --global --job check
yui job logs --global --job check --run <returned-run-id>
```

## Files, history and schedules

Each admitted Run captures the exact configuration and script contents. The
runner materializes files in a fresh `artifacts/jobs/global/<run-id>/workspace`
directory inside the selected Yui Home. Earlier Runs are not changed by later
edits. Script paths are relative, cannot traverse directories, and are limited
to 64 files / 512 KiB total. Use `sh scripts/check.sh` or another installed
interpreter; script names do not choose an interpreter automatically.

Schedules use the existing explicit service authorization, bound to the Job's
revision. Editing commands or scripts invalidates the old schedule binding;
inspect and explicitly re-enable/re-authorize the schedule before future runs.
Saving a new script never silently changes an already authorized command.

Storage 1.23 declares this additive payload change. Upgrade an existing Home
through the normal authorized upgrade path; do not run a new build against an
older shared Home or rewrite its records by hand.
