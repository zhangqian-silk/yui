// Frozen allocation from Task artifact 882168341788af2e3e78020634344ad02e16594a.
export const caseSetVersion = 'unified-v2-materials-1';
export const planDigest = '7b2badd708e580f496df03586be8b10ba0464bea1693e7d096313e3d8972b67b';
const rows = [
  ['C01', 'code', 'H', 'normal', 'single', 'pagination-repair'],
  ['C02', 'code', 'HKC', 'hard', 'single', 'authenticated-cache'],
  ['C03', 'code', 'X', 'normal', 'single', 'csv-export'],
  ['C04', 'code', 'C', 'hard', 'single', 'archive-retention'],
  ['C05', 'code', 'HX', 'normal', 'multi', 'cursor-sdk'],
  ['C06', 'code', 'X', 'hard', 'multi', 'auth-error-contract'],
  ['C07', 'code', 'K', 'normal', 'multi', 'binary-diagnostic'],
  ['C08', 'code', 'CX', 'hard', 'multi', 'limit-rollout'],
  ['W01', 'docs', 'H', 'normal', 'documents', 'async-export-design'],
  ['W02', 'docs', 'K', 'normal', 'documents', 'backup-guide'],
  ['W03', 'docs', 'CX', 'hard', 'documents', 'auditor-permissions'],
  ['W04', 'docs', 'HCX', 'hard', 'documents', 'migration-v2'],
  ['R01', 'research', 'K', 'normal', 'evidence', 'offline-search-pilot'],
  ['R02', 'research', 'HC', 'hard', 'evidence', 'incident-causality'],
  ['R03', 'research', 'X', 'hard', 'evidence', 'regional-rollout'],
  ['R04', 'research', 'KC', 'hard', 'evidence', 'retention-policy'],
  ['A01', 'data', 'H', 'normal', 'tables', 'registration-union'],
  ['A02', 'data', 'XC', 'normal', 'tables', 'qualified-conversion'],
  ['A03', 'data', 'HC', 'hard', 'tables', 'order-corrections'],
  ['A04', 'data', 'XK', 'hard', 'tables', 'inventory-units'],
  ['O01', 'operations', 'X', 'normal', 'simulator', 'ticket-assignment'],
  ['O02', 'operations', 'H', 'hard', 'simulator', 'lost-send-receipt'],
  ['O03', 'operations', 'XKC', 'hard', 'simulator', 'partial-config'],
  ['O04', 'operations', 'C', 'hard', 'simulator', 'revoked-publication'],
];
const holdout = new Set(['C04', 'C07', 'W04', 'R04', 'A04', 'O04']);
const predecessor = new Set(['C05', 'W01', 'R02', 'A03', 'O02']);
export const definitions = Object.freeze(rows.map(([id, category, tags, difficulty, topology, family]) =>
  Object.freeze({ id, category, split: holdout.has(id) ? 'holdout' : 'dev',
    tags: Object.freeze([...tags]), difficulty, topology, family,
    modes: Object.freeze(predecessor.has(id) ? ['F', 'P'] : ['F']) })));
export const variants = Object.freeze([
  { id: 'C02-V1', base: 'C02', factor: 'irrelevant-summary' },
  { id: 'R03-V1', base: 'R03', factor: 'notification-restored' },
  { id: 'A03-V1', base: 'A03', factor: 'arrival-order' },
  { id: 'O03-V1', base: 'O03', factor: 'read-only-reviewer' },
].map(Object.freeze));

export function definition(id, variant = 'base') {
  const value = definitions.find(item => item.id === id);
  if (!value) throw new Error(`Unknown case: ${id}`);
  if (variant !== 'base' && !variants.some(item => item.base === id && item.id === variant))
    throw new Error(`Unsupported variant: ${id}/${variant}`);
  return value;
}
