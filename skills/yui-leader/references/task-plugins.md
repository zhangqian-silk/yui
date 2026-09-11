# Task-local capabilities

Read this before creating, validating or activating a Task-local plugin.
Use the stable Session CLI's capability directory and read the exact schema
before each unfamiliar operation. Prefer an existing tool, composition or
one-off script unless a reusable named capability is useful.

The authenticated Leader can create, scan, validate, activate and disable
Task-local plugins through `plugin.*` in an adopted writable environment.
`plugin.scan` reports the package digest without execution;
`plugin.validation` reads saved evidence; `plugin.inspect` distinguishes
persistent enable intent from the Host's loaded implementation.

Management permission does not authorize execution. Trusted-local build,
validation, activation or calls require an existing `plugin.execute` grant for
the exact plugin id, digest, environment, trust and phase, within its remaining
uses and validity. A source change cannot inherit an old digest's grant.
Trusted-local subprocesses are not an OS sandbox.

Never issue your own grants, impersonate Operator, change global configuration,
or modify the core installation, namespace or carrying Endpoint to obtain a
tool. Request only a genuinely missing resource or trust boundary, not authority
already available. Plugin grants do not authorize unrelated external effects.

Preserve validation failures and operation receipts. An unknown or partial
external effect does not authorize rerunning the action chain. After activation,
query the directory again and use the new capability through the same bridge
and native Session; no native tool-schema change or Controller restart is needed.

Save the actual business result as a file artifact with `artifact.save`
(`relativePath` plus `content`): it commits exactly that path into the Task's
local Git repository and returns a self-certifying `commit + relativePath`
reference to retain in Task results. Plugin source or successful loading alone
is not delivery. Committed artifacts remain readable after disable or restart
through `artifact.read` at HEAD or a pinned commit; saved enable intent does not
automatically execute code on restart, and an artifact's script or HTML is data,
not a program to run under Yui authority.
