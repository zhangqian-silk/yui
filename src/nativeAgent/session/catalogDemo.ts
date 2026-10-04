import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgent, createExecutionOwner, createSessionStore, createSqliteSessionBackend,
  type ExecutionOwner, type SessionStore, type SessionInfo,
} from '../index.js';

// Standalone storage/owner evidence, not task-80's product CLI or a live model.
const directory = await mkdtemp(join(tmpdir(), 'native-catalog-demo-'));
const filename = join(directory, 'sessions.sqlite');
let store: SessionStore | undefined;
let owner: ExecutionOwner | undefined;
let modelCalls = 0;
const openOwner = (sessions: SessionStore) => createExecutionOwner({
  store: sessions, maxSteps: 1,
  agent: recorder => createAgent({
    recorder, tools: [],
    provider: { async complete(request) {
      modelCalls++;
      if (modelCalls === 2) assert.deepEqual(request.messages.map(m => 'content' in m ? m.content : ''),
        ['hello', 'saved answer', 'again']);
      return { kind: 'final', content: modelCalls === 1 ? 'saved answer' : 'continued after restart' };
    } },
  }),
});
try {
  store = createSessionStore(createSqliteSessionBackend(filename));
  for (const id of ['c', 'a', 'b']) await store.create(id);
  await store.renameSession('a', 'Same title', 0);
  await store.renameSession('b', 'Same title', 0);
  await store.renameSession('c', 'Temporary', 0);
  await store.renameSession('c', null, 1); // Explicitly clear, no history replacement.
  owner = openOwner(store);
  await owner.submit('b', 'hello');
  const evidence = await owner.settle('b');
  assert.equal(evidence?.result?.reason, 'completed');
  await owner.close(); owner = undefined;
  await store.close(); store = undefined; // No old database connections survive.

  store = createSessionStore(createSqliteSessionBackend(filename));
  const discovered: SessionInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listSessions({ limit: 1, cursor });
    discovered.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(discovered.map(s => s.sessionId), ['a', 'b', 'c']);
  assert.equal(discovered.filter(s => s.title === 'Same title').length, 2);
  // Titles are not keys: the caller chooses the displayed exact ID.
  const selected = discovered.find(s => s.sessionId === 'b')!;
  const detail = await store.getSessionInfo(selected.sessionId);
  assert.equal(detail.digest, evidence?.receipt?.digest);
  const renamed = await store.renameSession(selected.sessionId, 'Chosen session', detail.metadataRevision);
  assert.equal(renamed.revision, detail.revision);
  let historyPages = 0, historyRecords = 0;
  do {
    const page = await store.readHistory(selected.sessionId, { limit: 2, cursor });
    historyPages++;
    historyRecords += page.records.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.ok(historyPages >= 3);
  assert.equal(historyRecords, detail.revision);
  assert.equal(modelCalls, 1); // Discovery/selection/history never start execution.
  owner = openOwner(store);
  await owner.submit(selected.sessionId, 'again');
  assert.equal((await owner.settle(selected.sessionId))?.result?.reason, 'completed');
  console.log(JSON.stringify({
    discovered, selected: renamed.sessionId, persistedTitle: renamed.title,
    historyPages, historyRecords, receiptPreserved: true,
    allConnectionsClosedBeforeReopen: true, continuedThroughExistingOwner: true, modelCalls,
  }, null, 2));
} finally {
  await owner?.close();
  await store?.close();
  await rm(directory, { recursive: true, force: true });
}
