import type { ExecutionOwner } from '../executionOwner.js';
import { SessionSaveError, type SessionStore, type SessionLocation } from '../session/index.js';
import { ProductError, validateProductLocation, type ProductConfig } from './config.js';
import { storageFailure } from './storage.js';

/** A bounded detail is a location fact, never permission or execution history. */
export async function restoreProductLocation(store: SessionStore, id: string, config: ProductConfig): Promise<SessionLocation> {
  let detail;
  try { detail = await store.getSessionInfo(id); } catch (error) { throw storageFailure(error); }
  if (!detail.location) throw new ProductError('agent_storage', 'location',
    'Saved location is missing; choose a new Session explicitly. Never guess or retrofit the old location.', undefined, id);
  for (const field of ['root', 'cwd'] as const) {
    if (config.sources[field] !== 'default' && config[field] !== detail.location[field])
      throw new ProductError('agent_config', field, 'Explicit location conflicts with this Session; select the original location or a new Session.');
  }
  await validateProductLocation(detail.location);
  return detail.location;
}

/** Creation stays in the unique owner. A lost acknowledgment stops this attempt;
 * reconcile reads by the attempted ID, never retry create or run effects here. */
export async function createProductSession(owner: ExecutionOwner, store: SessionStore, title: string, location: SessionLocation) {
  try { return await owner.create(title, location); }
  catch (error) {
    if (!(error instanceof SessionSaveError) || error.expectedRevision !== null) throw storageFailure(error);
    let confirmed = false;
    try {
      const detail = await store.getSessionInfo(error.sessionId);
      const saved = await store.load(error.sessionId);
      confirmed = detail.location?.root === location.root && detail.location.cwd === location.cwd
        && saved.revision === 0 && detail.revision === 0 && detail.digest === saved.digest
        && saved.recovery.disposition === 'ready';
    } catch { /* Read failure/not-found is not proof that no commit occurred. */ }
    throw new ProductError('agent_storage', 'creation', confirmed
      ? `Same-ID detail and load confirm empty Session ${error.sessionId} and original location. No execution started; explicitly reopen this Session ID.`
      : `Creation of Session ${error.sessionId} remains unknown. Preserve this ID and inspect same-ID detail plus load; do not blindly recreate, switch IDs or replay.`,
    'unknown', error.sessionId);
  }
}
