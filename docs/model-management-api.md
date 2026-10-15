# Model management Web contract

This is the implementation contract for Task 122. Server implementation belongs
to Leader; Web assets and interactions belong to the model-web WorkItem.

All routes use the existing `x-yui-web-token` boundary and return JSON directly,
not a `{data: ...}` envelope. A failed mutation returns HTTP 409 with
`{error, disposition: "not-submitted" | "unknown"}`. Never automatically replay
unknown writes. No arbitrary remote paths or proxy methods are accepted.

## Connection and providers

`GET /api/models` returns `ModelManagementView` (see
`src/models/modelManagementTypes.ts`). This reads local configuration only.
The revision covers both the connection and the current bridge configuration.

`POST /api/models/connection` accepts `{revision, connection}`. Connection is
null to disconnect, or all five string fields: `bridgeUrl`, `bridgeConfigFile`,
`cpaUrl`, `managementKeyFile`, `catalogKeyFile`. Optional fields use empty strings.
Bridge URL is required; bridgeConfigFile enables local configuration management.
CPA URL and a private management-key file are needed for quota refresh. Catalog
key is independent from the management key. Secrets are never returned.
Disconnecting never stops services or deletes credentials.

`POST /api/models/provider` accepts:

- save: `{revision, operation:"save", provider:{id?,name,via,baseUrl,prefix,enabled,apiKey?}}`
- remove: `{revision, operation:"remove", id}`

An absent id creates a provider. An omitted/empty apiKey preserves the existing
credential; a nonempty value replaces it. New API-key providers require a key.
Use a password input, never rehydrate it, clear it after submission, and never
put it in URLs, logs, localStorage or error messages.
`via` is direct or cpa. For cpa the key is a CPA **client inference key**,
not an upstream account key or a management key. Prefix is the explicit model
namespace/mapping and is mandatory for newly managed providers. Existing
official/subscription and unprefixed shared routes are read-only. Render
`editable/reason` rather than guessing. Removal unlinks the provider but retains
its file/credentials; the result notice reports that fact.

Successful mutations return a fresh ModelManagementView. Saving is NOT applying:
application stays `unverified`; an operator may need to reload metabridge using
its existing deployment flow. This page never restarts it, rewrites Codex
configuration, switches Sessions, or claims inference was validated.

## Catalog and quota

`GET /api/models/catalog?cursor=0` reads the cached catalog and returns
`ModelObservation<ModelCatalogItem> & {total:number,nextCursor:string|null}`.
Pages contain at most 100 items. `source` comes from the model ID namespace,
or `metabridge` when absent; it is not proven account attribution.

`POST /api/models/refresh` accepts `{revision,kind:"catalog"}` and returns the
first catalog page, or `{revision,kind:"quota",source:"factory"|"command-code"}`
and returns `ModelObservation<ModelQuotaItem>`. Quota refresh is explicit and
may contact the upstream billing service via the installed CPA extension.
It does not renew credentials, reset quota or run inference. No polling.

`GET /api/models/quota?source=factory` (or command-code) reads only that cached
observation. Sources stay separate. Null means unknown, not zero. Failed refresh
does not retain a successful current value. A timestamped stale success must be
visibly marked stale. A 404 alone is an unavailable/unknown extension route, not
proof that the plugin is uninstalled. Unsupported or failed quota must not block
the catalog or connection editor.

The page should link to existing settings for Agent/model selection without
automatically importing models. Use the existing navigation/theme/i18n and
accessible forms; an ordinary `/models` shell is appropriate. Worker owns the
asset manifest, shell, navigation and client assets. Leader owns server route
wiring, controller dependency wiring, types, configuration and tests of backend
behavior. Do not edit each other's files without coordination.
