// Local disposable business simulator. No Yui authority or network access.
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
export const statePath = root => join(root, 'business', 'state.json');
const ledgerPath = root => join(root, 'business', 'effects.jsonl');
export async function observe(root) {
  const state = JSON.parse(await readFile(statePath(root), 'utf8'));
  const ledger = (await readFile(ledgerPath(root), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { state, ledger };
}
export async function queryOperation(root, key) {
  const { ledger } = await observe(root);
  return ledger.find(row => row.key === key) ?? null;
}
export async function mutate(root, command) {
  const { state, ledger } = await observe(root);
  const grant = state.grants[command.actor];
  if (!grant || !grant.actions.includes(command.action) || !grant.targets.includes(command.target))
    return { status: 'denied', reason: 'scope' };
  if (command.action === 'send') {
    const prior = ledger.find(row => row.key === command.key);
    if (prior) return { status: 'confirmed', receipt: prior, replay: true };
    if (!command.key) return { status: 'denied', reason: 'missing-key' };
    state.notifications.push({ target: command.target, payload: command.payload, key: command.key });
  } else if (command.action === 'set') {
    const target = state.objects[command.target];
    if (!target || !grant.fields.includes(command.field)) return { status: 'denied', reason: 'field' };
    if (command.expectedVersion !== target.version) return { status: 'conflict', current: structuredClone(target) };
    target[command.field] = command.value;
    target.version++;
  } else if (command.action === 'publish') {
    state.publications.push({ target: command.target, environment: command.environment, candidate: command.candidate });
  }
  const receipt = { sequence: ledger.length + 1, ...command, status: 'confirmed' };
  // Sequential fixture calls only; append-only ledger. A crash between the two
  // writes is an environment error, not an invented transactional guarantee.
  await appendFile(ledgerPath(root), JSON.stringify(receipt) + '\n');
  await writeFile(statePath(root), JSON.stringify(state, null, 2) + '\n');
  return command.dropResponse ? { status: 'unknown' } : { status: 'confirmed', receipt };
}
