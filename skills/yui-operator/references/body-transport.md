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
```

Retain these exact paths across tool calls; set `umask 077` in each shell writing
them. Capture the actual CLI response with `> "$source_json"`; finish Runtime
pagination before extraction. For a string `data.body`:

```sh
node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); if(r.ok!==true || typeof r.data?.body!=="string") throw Error("Expected complete Message"); process.stdout.write(r.data.body)' "$source_json" > "$payload" &&
yui operator submit --body-file "$payload" --task "$task" --intent "$intent" --request-id "$key"
```

For a requested nested JSON value, select it from `JSON.parse(r.data.body)` and
emit `JSON.stringify(value)` instead, preserving its scalar values.
Never retype the payload into shell source or forward the CLI envelope. Preserve
constraints, target, intent, request identity and authority. For this transport,
read the returned Message once to compare its saved body with the intended
submission before reporting success; report mismatches without blind resubmission.
After preserving required evidence, remove only these owned files and the empty
`"$route_scratch"` directory; retain them if ownership or required evidence is uncertain.
