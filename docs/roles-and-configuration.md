<p align="right"><strong>English</strong> | <a href="./roles-and-configuration.zh-CN.md">简体中文</a></p>

# Roles, Profiles and execution configuration

## Responsibilities

Agent selects an execution component, connection plan and launch environment.
Role selects an active Agent binding and portable behavior. Each binding retains
independent runtime options. A Role can keep multiple bindings without creating
parallel writers or sharing one binding's credentials/configuration with another.

Task Roles are Task-local; global Roles provide configured defaults and global
conversations. Role identity/configuration is not a writable runtime status.
Session and Provider observations describe actual activity.

An explicit Task-final Review uses an existing Task-local Reviewer Role without
requiring a same-named global Role. A global Role is a creation template only
when the requested Task Role does not exist. Availability, producer separation
and the frozen review candidate still apply.

## Profiles

An Agent Profile combines portable behavior—instructions, Skills and access
intent—with runtime intent. Runtime either follows the current Global Worker
binding or explicitly selects an Agent with optional model and effort.
`config profile reset` supplies `worker`, `explorer`, `implementer` and `reviewer`.

Creating a Task Role from a Profile freezes its resolved behavior and binding.
Later Profile or Global Worker edits do not rewrite existing Task Roles.
Reapplying a Profile is an explicit configuration change. The selected Agent
must match the target binding; explicit Role options override the corresponding
template fields. A Profile is not a Session, workspace owner or resource grant.

Native children inherit their parent Agent and authority. A Profile can guide
their behavior; model/effort overrides require actual native tool support.
They do not acquire Yui Roles, independent Assignments or broader scope.

## Desired, effective and observed

Desired settings are next-launch intent. An AgentRun and Session capture the
effective launch: Agent/component, protocol, model, effort, permission strategy,
workspace/environment, Role context and planning/delivery authority.

Live run-configuration inspection separately reports what the Agent actually
states. Unsupported and unknown are explicit; an accepted setter without a
reported current value is not an observed match. Configuration reads do not
modify the Agent to make the observation agree with desired settings.

Worker binding changes preserve an active Assignment's Agent and effective
snapshot; subsequent explicit dispatch uses the current selection. Leader
replacement revokes the previous management entry without rewriting Worker
Assignments. Changing desired configuration does not hot-mutate the native
Session. An explicit `task role session new` request handles old runtime
cleanup before selecting a fresh Session; it does not require manually settling
Run status first. A useful Session may be reused, but it is never the only
holder of Task context.

## Permissions and Project context

Provider permission strategy, Profile access intent and Project write scope are
different contracts. Provider bypass does not grant writes to another Project.
Managed workspace owner, exact Assignment and resource grants enforce Yui
operations; broad native permissions are not an OS sandbox.

Yui supplies its generic Role Skills and Context pointers. Project Skills remain
ordinary Project files discovered natively by the Agent. Project Knowledge is
maintained under `YUI_HOME`; copying repository material into a prompt does not
make it authoritative Knowledge.

## Native authentication

Account configuration outlives a Session. Yui preserves `HOME` and the selected
`CLAUDE_CONFIG_DIR`; new/resumed Sessions do not copy, clear, or fabricate native
login, key-approval, or onboarding records.

For Claude Code, standard API-key, base-URL, bearer/OAuth, model-alias and native
provider-selection environment variables are forwarded only to Claude. Values
remain in the Controller's replaceable runtime environment and the child process,
not in Task/Role records. Unsetting a source and refreshing the Controller
environment removes it for subsequent launches. Other custom credential variables
still use explicit Agent environment bindings or native user settings; Yui does
not inherit the whole shell environment or infer cloud credentials.

Claude itself loads native settings and chooses between API keys, existing
helpers, login credentials, profiles and cloud authentication according to its
effective configuration. Yui does not inject `apiKeyHelper`, copy credential
files, or override the native authentication priority. Explicit `--settings`
paths and settings-source selections are passed through unchanged.

Fresh native configuration can still require Claude's initialization, key,
workspace and security confirmations, including access to initialization
services. Isolating `YUI_HOME` or replacing a Session does not require a fresh
native account directory. Managed Task execution uses Claude's non-interactive
stream-json path with the same native configuration ownership.

## Commands

```sh
yui config agent capabilities <agent-id>
yui config role show <global-role>
yui config profile show <profile>
yui task role add <task> <role> --profile <profile>
yui task role show <task> <role>
yui task role update <task> <role> --environment <preparation-id>
yui task role update <task> <role> --managed-environment
yui task role session inspect <task> <role>
yui task role session new <task> <role> --reason "<why a fresh Session is useful>"
```

On Role creation, explicit Agent settings require `--agent`. On update, omitted
`--agent` targets the active binding; a named binding is updated without being
activated. `task role bind` changes selection. A live Session requires the
command's explicit confirmation before desired settings are changed.

For native configuration and implementation limits, see [Provider runtime](provider-runtime.md).
