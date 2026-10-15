import { manageDocument } from "./manage.js";

// The /models page inside the shared management frame. Access, catalog and
// quota are daily model management; the connection section is listed under
// Settings in the shared navigation but stays on this page and endpoint
// (?section=connection). The client renders every section into #models-root.
export const MODELS_HTML = manageDocument({ page: "models", title: "Models", main: `
      <p class="manage-scope" data-i18n="models.scope">Manage the metabridge and CLIProxyAPI connection Yui reads. Saved configuration is not applied until metabridge is reloaded, and nothing here runs inference.</p>
      <div id="models-root" class="models-root"></div>` });
