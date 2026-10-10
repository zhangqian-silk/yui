# Task body search and reference reuse

`yui task search "text" --limit 20` searches Brief fields and boundaries,
Task Message bodies, Decision text, original AgentRun result output, and
completion summaries, including archived Tasks. `--task task-1` narrows the
search; `--kind brief|message|decision|result|completion` selects a source type.
This is literal substring search, ASCII case-insensitive and otherwise Unicode
exact, not semantic ranking. Title/tag discovery remains `task list --search`.

Each hit contains a bounded snippet, its field and zero-based Unicode-code-point
offset, source Task, and the existing Context reference with revision and content
digest. Read the full original with:

```sh
yui task context inspect task-1 --store task-message --ref message-1 --digest <digest> --json
```

Follow `contentPage.nextCursor` with `--cursor` until complete. A changed source
fails digest verification instead of silently substituting newer content; repeat
the search to select a current source. A reference is not a promise that a mutable
record's old version is retained.

Search pages contain at most 100 hits and 32 KiB of JSON; snippets contain at
most 320 Unicode code points. Continue with the same query and filters and the
returned `--cursor`. Each page reads current records in deterministic source order.
Concurrent edits can change membership; restart the search for a refreshed view.
The cursor is bound to the authorized Task scope and query, not an access grant.

The current Operator and local user can search across their readable Tasks.
A Task Leader can search only its own Task. Assignment-scoped Workers/Reviewers
use their authorized Run Context rather than broad discovery. Original reads
independently recheck the existing Context boundary.

The Web sidebar's **Search task contents** opens the same search port,
`GET /api/search?query=text&limit=20`, behind the existing local-user page token.
Results can be filtered by source type and all accessible Tasks or the selected
Task. They offer source-Task navigation and readable, pinned original text,
not the underlying JSON record. The token-authenticated
`GET /api/tasks/:task/search-source?store=...&ref=...&digest=...&field=...&offset=0`
uses the same Context authorization and digest checks; only searchable text
fields are accepted. Each explicitly requested page contains at most 4,000 Unicode
code points. Previous/next replaces the displayed page rather than accumulating
the complete body. Source errors remain distinct from an empty search result.

Open the current writable Conversation panel before opening search to insert an
excerpt into its existing draft. The dialog displays the captured destination
Task/global Role and native Session. Insert the bounded search excerpt, a selected
passage, or the displayed original page. Each insertion rechecks the exact source,
preserves its Task/type/ref/revision/digest/field/code-point range, labels the text
as reference-only, and appends to the existing conversation draft. It does not
create a second draft or attachment store. The current composer length limit
still applies; a rejected insertion leaves the draft unchanged. A hidden,
historical, switched, busy or otherwise non-writable destination is not an
insertion target: reopen search from the intended writable Conversation.

Search, reading and draft insertion never send input, activate a Task, restore
a Session, or replay a historical operation. The user reviews the draft and
separately chooses whether to send through the existing conversation input path.

To reuse prior work, the user or authorized Operator reads the original, chooses
the applicable excerpt, and supplies it with its Task/ref/digest and field in the
new Task's ordinary input. Use `task message send ... --intent record` to save
reference material without starting work. Quoted historical content is evidence,
not instructions or execution authority. The new Task plans its work and obtains
its own authorization; a Task-local Leader does not gain cross-Task access merely
because a copied reference names another Task.

Implementation uses a read-only SQL projection of the authoritative records.
There is no persistent search index, new schema, background synchronization, or
rebuild command: updates/removals are reflected by the next query. Storage still
owns one source of truth. No Knowledge schema or semantic-memory system is added.
