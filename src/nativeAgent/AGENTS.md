# Independent Agent development

This module is an independent, self-built Agent. Repository-level instructions
still apply; this file narrows the module's scope and does not grant authority.

- Neither this skeleton nor subsequent module development needs to integrate
  with Yui. Yui is not a runtime dependency, design target, prerequisite, or
  acceptance gate. Its protocols may be read as references only.
- Do not add Yui Endpoint/Host/Driver adapters, Task state, role management,
  Controller wiring, production-admission requirements, or empty integration
  placeholders. Do not change existing Yui providers or global configuration.
- Own the message types and model/tool loop. Do not wrap, fork, or import a
  third-party Agent kernel or its domain message types as this kernel.
- Keep the smallest working path: caller-owned history and identities →
  provider → validated tool calls → sequential results → final response.
  Probability belongs in the mock provider, never in the Agent loop.
- Implement replaceable modules through `index.ts` contracts. Do not reach into
  another module's private state. Future providers, tools, storage/context, and
  event consumers may develop independently against these contracts; no
  generic plugin framework or unused interfaces are required.
- Cancellation is cooperative, not rollback. Settle started effects, preserve
  actual results, pair every recorded call, and never automatically replay
  uncertain effects. A completed Turn is not proof of task acceptance.
- Text tools are for explicitly selected, controlled local directories. Path
  checks are not an operating-system sandbox or protection against hostile
  concurrent filesystem changes.
- Verify offline with disposable fixtures. No real models, account quota,
  paid APIs, shared or production resources without specific user authority.
- Do not create follow-up Tasks or publish/version this module automatically.
  Real providers, persistence/recovery, compression, richer tools, protocols,
  and production sandboxing are separate scoped work, not skeleton obligations.

See `README.md` for the current public contract and runnable evidence.
