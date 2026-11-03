# Safe body transport

Read before transporting quote-sensitive text, nested JSON or long bodies.
Keep operation request identity separate from source effect/correlation keys.

For quote-sensitive text or nested JSON, use parser-produced `--body-file`
data; prefer it for long text too. `printf '<handwritten JSON>' | ...` is still
shell source, not safe transport. Allocate unique private files under runtime
`TMPDIR`; never substitute fixed shared `/tmp` paths:

```sh
: "${TMPDIR:?Runtime TMPDIR required}"
umask 077
route_scratch=$(mktemp -d "${TMPDIR%/}/yui-route.XXXXXXXX") || exit 1
source_json="$route_scratch/source.json"; payload="$route_scratch/payload.txt"
receipt="$route_scratch/receipt.json"
```

After Runtime's original-reading and claim steps, prefer one shell invocation
for the local file lifecycle: prepare, submit once, verify the saved receipt,
then clean up on success. Shell variables do not survive tool calls. If splitting
is necessary, return and retain exact paths, not a timestamp-based scratch search.
Reuse an existing complete source-response file only when it still matches the
original being handled. Otherwise capture the source CLI response with
`> "$source_json"` in this same invocation; do not display the already-read body
again merely to prepare transport. A file is not proof of reading, freshness or
authority: read missing/changed originals and finish Runtime pagination before
extraction. Keep `umask 077` in each writing shell. For a string `data.body`:

```sh
node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); if(r.ok!==true || typeof r.data?.body!=="string") throw Error("Expected complete Message"); process.stdout.write(r.data.body)' "$source_json" > "$payload" &&
yui operator submit --body-file "$payload" --task "$task" --intent "$intent" --request-id "$key" --json > "$receipt" &&
cat "$receipt"
```

For a requested nested JSON value, select it from `JSON.parse(r.data.body)` and
emit `JSON.stringify(value)` instead, preserving its scalar values.
Never retype the payload into shell source or forward the CLI envelope. Preserve
constraints, target, intent, request identity and authority. Before reporting
success, check the successful submission's saved Message identity, target and
intent, then compare its `data.message.bodyBytes` and `bodySha256` with the
payload file's byte length and SHA-256 (raw UTF-8 bytes, no trimming or JSON
re-encoding). This verifies transport without reading the saved body again;
`digest` instead identifies the entire record. If the body checksum is unavailable,
read the exact saved Message and compare its body. A checksum never replaces
reading the original request, grants authority or proves downstream completion.
The bundled [local verifier](../scripts/verify-submission.mjs) performs this
comparison without Yui calls, writes, cleanup or ACK. Using its path under the
current Operator Skill, append to the same shell:

```sh
node "$operator_skill/scripts/verify-submission.mjs" "$receipt" "$payload" "$task" "$intent" "$key"
```

It returns compact identity and checksum evidence on success, nonzero on failure.
No script source read is needed merely to invoke this documented local check.
Use the captured receipt for verification; do not repeat a successful submission
just to capture its output. Make cleanup conditional on successful comparison,
not merely printing hashes. After preserving required evidence, remove only these
owned files and the empty `"$route_scratch"` directory in that same shell.
On failure, retain evidence and report exact paths; no unconditional exit trap
or blind resubmission. ACK remains a separate disposition after verified routing.
