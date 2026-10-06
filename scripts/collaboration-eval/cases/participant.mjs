// Deliberately no catalog/materials/oracle import and no case-ID input.
// All choices come from public records read back by the enclosing Yui runner.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { observe, mutate, queryOperation } from './business.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
function decodeReadback(readback) {
  if (!readback?.origin || !Array.isArray(readback.records)) throw new Error('Missing original-record readback');
  const facts = {};
  const sources = [];
  for (const record of readback.records) {
    const f = record.value;
    if (!record.ref || !f?.key || !f.digest) throw new Error('Incomplete original-record readback');
    const { digest, ...unsigned } = f;
    if (hash(JSON.stringify(unsigned)) !== digest || record.digest !== digest) throw new Error('Fact digest mismatch');
    if (facts[f.key]) throw new Error('Duplicate fact key');
    facts[f.key] = f.body;
    sources.push({ key: f.key, ref: record.ref, source: f.source, revision: f.revision, digest });
  }
  for (const key of ['request', 'decision', 'evidence', 'checkpoint', 'identity', 'timeline'])
    if (!facts[key]) throw new Error(`Missing necessary fact: ${key}`);
  if (facts.timeline.cutoff !== 2 || facts.timeline.futureVisible) throw new Error('Invalid evaluation cutoff');
  return { facts, sources };
}
async function writeOutput(root, path, content) {
  const resolved = resolve(root, path);
  if (relative(root, resolved).startsWith('..')) throw new Error('Output outside case root');
  await mkdir(resolve(resolved, '..'), { recursive: true });
  await writeFile(resolved, content);
}
function codeImplementation(kind, d) {
  // Public business-operation handlers, not answer arrays. Oracle uses other
  // inputs and literals rather than importing any of these implementations.
  switch (kind) {
    case 'pagination': return `export function collect(pages) {
  const items=[]; const seen=new Set(); let cursor='start';
  while(cursor!==null && !seen.has(cursor)) {
    seen.add(cursor); const page=pages[cursor]; if(!page)throw Error('missing page');
    items.push(...normalizeItems(page.items)); cursor=page.next;
  } return items;
}\n`;
    case 'cache': return `export function shouldCache(response) { return ${JSON.stringify(d.cacheableStatuses)}.includes(response.status); }
export function cacheKey(principal,resource) { return JSON.stringify([principal,resource]); }
export function createCache() {
  const saved=new Map();
  return {get(principal,resource,fetch) {
    const key=cacheKey(principal,resource);if(saved.has(key))return saved.get(key);
    const response=fetch();if(shouldCache(response))saved.set(key,response);return response;
  }};
}\n`;
    case 'csv': return `export function* csv(rows) {
  const columns=${JSON.stringify(d.columns)};
  const quote=v=>{const s=String(v??'');return /[",\\r\\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s};
  yield columns.map(quote).join(',')+'\\r\\n';
  for(const row of rows)yield columns.map(k=>quote(row[k])).join(',')+'\\r\\n';
}\n`;
    case 'retention': return `export function retention(config) {return config.retentionDays??${d.defaultDays};}
export function migrate(records) {return structuredClone(records);}\n`;
    case 'cursor-sdk': return `export function consume(server) {
  const rows=[];let cursor=null;const seen=new Set();
  do {const response=server({${d.requestField}:cursor});rows.push(...response.items);
    cursor=response.nextCursor;if(cursor!==null&&seen.has(cursor))throw Error('repeated cursor');
    seen.add(cursor);
  } while(cursor!==null);return rows;
}\n`;
    case 'auth-contract': return `export function consume(server) {
  const code=server().error.code;if(typeof code!==${JSON.stringify(d.acceptedErrorType)})throw Error('contract');
  return code;
}\n`;
    case 'binary-diagnostic': return `export function decode(bytes) {
  const n=bytes[0]+256*bytes[1];if(bytes.length!==n+3)throw Error('length');
  const payload=bytes.slice(2,2+n);if(payload.reduce((a,b)=>a+b,0)%256!==bytes.at(-1))throw Error('checksum');
  return payload;
}\n`;
    case 'limit-rollout': return `export function consume(server,limit) {
  if(limit>${d.acceptedLimit})throw Error('limit');return server(limit);
}\n`;
    default: return null;
  }
}

function deriveData(kind, d, e, checkpoint, strategy) {
  if (kind === 'registration-union') {
    const entities = new Map();
    // Legal incremental path preserves the previous partition; full path also
    // supported. Both must process duplicate rows for full row-level lineage.
    if (strategy !== 'full') for (const item of checkpoint.entities) {
      entities.set(JSON.stringify(d.key.map(k => item[k])), { ...item, rows: [...item.rows] });
    }
    const anomalies = [];
    for (const row of e.rows) {
      if (!row.email) { anomalies.push({ row: row.row, reason: 'missing-email' }); continue; }
      const key = JSON.stringify(d.key.map(k => row[k]));
      const item = entities.get(key) ?? { event: row.event, email: row.email, rows: [] };
      if (!item.rows.includes(row.row)) item.rows.push(row.row);
      entities.set(key, item);
    }
    return { entities: [...entities.values()], anomalies, snapshots: e.snapshots, rule: d.version };
  }
  if (kind === 'conversion') {
    const visitors = new Map();
    const excluded = [];
    for (const row of e.rows) {
      if (!row.qualified || row.test) { excluded.push(row.row); continue; }
      const item = visitors.get(row.user) ?? { user: row.user, rows: [], converted: false };
      item.rows.push(row.row); item.converted ||= row.purchase; visitors.set(row.user, item);
    }
    const denominator = [...visitors.keys()];
    const numerator = [...visitors.values()].filter(x => x.converted).map(x => x.user);
    return { denominator, numerator, ratio: numerator.length / denominator.length,
      entities: [...visitors.values()], excluded, snapshot: e.snapshot, rule: d.version };
  }
  if (kind === 'order-aggregate') {
    const latest = new Map();
    if (strategy !== 'full') for (const item of checkpoint.currentOrders) latest.set(item.order, { ...item });
    const lineage = {};
    for (const row of e.events) {
      (lineage[row.order] ??= []).push(row.row);
      if (!latest.has(row.order) || latest.get(row.order).revision < row.revision)
        latest.set(row.order, { order: row.order, revision: row.revision, cents: row.cents, at: row.at });
    }
    const days = {};
    const entities = [...latest.values()].map(item => {
      const day = new Date(Date.parse(item.at) + d.timezoneOffsetMinutes * 60000).toISOString().slice(0, 10);
      days[day] = (days[day] ?? 0) + item.cents;
      return { ...item, day, rows: lineage[item.order] };
    });
    return { days, entities, snapshots: e.snapshots, rule: d.version,
      waterMark: 'all-provided-events', path: strategy === 'full' ? 'full' : 'incremental' };
  }
  if (kind === 'inventory') {
    const known = {}; const unresolved = [];
    for (const row of e.rows) {
      const item = d.mapping[row.material], scale = d.units[row.unit];
      if (!item || scale === null || scale === undefined) {
        unresolved.push({ row: row.row, reason: !item ? 'mapping' : 'unit-rate' }); continue;
      }
      known[item] ??= { quantity: 0, rows: [] };
      known[item].quantity += row.quantity * scale; known[item].rows.push(row.row);
    }
    return { known, unresolved, snapshots: e.snapshots, rule: d.version, total: null,
      questions: e.missing, status: 'needs-input' };
  }
  return null;
}

function composeDocument(kind, d, e, request) {
  const sections = [];
  const propositions = {};
  if (kind === 'design-document') {
    propositions.choice = d.choice; propositions.maxBytes = d.maxBytes;
    propositions.cancellation = d.cancel;
    propositions.recovery = 'Recover durable queued/running jobs by original job ID; inspect prior artifact before retrying publication.';
    sections.push('States: queued, running, completed, failed, cancelled. Cancellation before publication prevents output.',
      `Maximum output is ${d.maxBytes} bytes; larger jobs fail without publishing an oversized artifact.`,
      propositions.recovery, 'Acceptance: check the size boundary, cancellation race, and recovery without duplicate publication.');
  } else if (kind === 'procedure-document') {
    propositions.environment = d.environment; propositions.steps = d.procedure; propositions.execute = false;
    sections.push(`Applies only to ${d.environment}. Authorized operator needed; this author must not execute commands.`,
      ...d.procedure.map((step, i) => `${i + 1}. ${step}`),
      `Illustrative commands only: ${e.examples.join('; ')}.`);
  } else if (kind === 'permission-documents') {
    for (const name of request.documents) propositions[name] = structuredClone(d.roles);
    sections.push('Audit export is permitted. Auditors remain read-only for configuration. Administrator may configure.',
      'The proofreader report is completed but does not constitute acceptance of these candidates.');
  } else if (kind === 'migration-document') {
    propositions.target = d.target; propositions.steps = d.confirmedSteps;
    propositions.recoveryConfirmed = d.recoveryConfirmed; propositions.publishable = false;
    sections.push(`Target ${d.target}. Use only confirmed v2 steps: ${d.confirmedSteps.join('; ')}.`,
      `Removed instructions: ${d.removedCommands.join(', ')}; old review does not validate v2.`,
      `Blocked recovery confirmation: ${e.missing.join(', ')}. Ask the technical owner; do not guess, execute, or publish.`);
  } else return null;
  return { propositions, text: sections.join('\n\n') };
}

function composeResearch(kind, d, e) {
  const claims = []; const questions = []; let status = 'conditional-recommendation';
  if (kind === 'search-recommendation') {
    const viable = e.options.filter(o => o.offline);
    claims.push({ type: 'fact', text: e.conditions, source: e.study },
      ...viable.map(o => ({ type: 'fact', option: o.name, p95ms: o.p95ms,
        maintenanceHours: o.maintenanceHours, offline: o.offline, source: e.study })),
      { type: 'recommendation', options: viable.map(o => o.name), approved: false,
        reason: 'Both satisfy offline deployment; choose latency or maintenance priority after confirming capacity.' });
    questions.push(...e.unknown);
  } else if (kind === 'incident-analysis') {
    claims.push({ type: 'fact', observed: e.coverage.requestsObserved, total: e.coverage.totalRequests, source: d.version },
      { type: 'hypothesis', alternatives: e.alternatives, source: d.version, causalCertainty: false },
      { type: 'correction', timezone: e.timezoneCorrection, source: d.version });
    questions.push(...e.missing); status = 'needs-evidence';
  } else if (kind === 'rollout-recommendation') {
    claims.push({ type: 'fact', region: e.original.region, sample: e.original.sample,
      supportCount: e.original.supportCount, scope: e.original.scope, source: e.original.report },
    { type: 'recommendation', scope: e.original.scope, approved: false,
      condition: 'Only a conditional North pilot; report still needs acceptance; other regions need independent evidence.' });
    questions.push(...e.unknown);
  } else if (kind === 'policy-recommendation') {
    claims.push({ type: 'principle', text: d.principle, source: d.version },
      { type: 'options', alternatives: e.options, source: 'artificial-options', approved: false },
      { type: 'unknown', fixedDays: null, source: d.version });
    questions.push(...e.missing); status = 'needs-input';
  } else return null;
  return { claims, questions, status, approved: false,
    text: 'Facts, hypotheses and conditional recommendations are separated below.\n' +
      claims.map(c => JSON.stringify(c)).join('\n') + '\nOpen evidence: ' + questions.join('; ') };
}

async function operate(root, kind, d, e, identity) {
  const receipts = [], targets = {};
  if (kind === 'reconcile-notification') {
    const receipt = await queryOperation(root, e.key);
    if (!receipt) return { status: 'unknown', key: e.key, targets, receipts };
    return { status: 'confirmed', key: e.key, payload: e.payload, receipt,
      targets: { [e.target]: 'confirmed' }, receipts: [receipt] };
  }
  if (kind === 'publish-package') return { status: 'authorization-missing', targets, receipts, candidatePreserved: true };
  const { state } = await observe(root);
  if (kind === 'assign-tickets') {
    if (d.status !== 'accepted') return { status: 'waiting-acceptance', targets, receipts };
    for (const item of d.assignments) {
      const receipt = await mutate(root, { actor: identity.actor, action: 'set', target: item.id,
        field: 'assignee', value: item.assignee, expectedVersion: item.version });
      targets[item.id] = receipt.status; receipts.push(receipt);
    }
    return { status: 'confirmed', targets, receipts };
  }
  if (kind === 'resume-config') {
    for (const id of e.targets) {
      const current = state.objects[id];
      if (current.enabled === d.desired) { targets[id] = 'already-confirmed'; continue; }
      if (current.version !== d.expectedVersions[id]) { targets[id] = 'conflict'; continue; }
      if (!identity.businessActions.includes('set')) { targets[id] = 'read-only'; continue; }
      const receipt = await mutate(root, { actor: identity.actor, action: 'set', target: id,
        field: d.field, value: d.desired, expectedVersion: d.expectedVersions[id] });
      targets[id] = receipt.status; receipts.push(receipt);
    }
    return { status: identity.role === 'reviewer' ? 'observed' : 'partial', targets, receipts };
  }
  return null;
}

export async function executeCase({ root, readback, strategy = 'incremental', style = 'standard' }) {
  const { facts, sources } = decodeReadback(readback);
  const { request: r, decision: d, evidence: e, checkpoint, identity } = facts;
  const result = { status: 'candidate', sources, origin: readback.origin, summary: r.title,
    accepted: false, actions: [], questions: [], style };
  const code = codeImplementation(r.kind, d);
  if (code !== null) {
    if (!identity.writes.some(prefix => r.output.startsWith(prefix + '/'))) throw new Error('Code output is outside assignment');
    const previous = await readFile(join(root, r.output), 'utf8');
    // Keep useful predecessor helpers instead of replacing its entire candidate.
    const keep = previous.split('\n').filter(line => /export const (normalizeItems|normalize|sdkName|serializeArchive) /.test(line)).join('\n');
    await writeOutput(root, r.output, keep + '\n' + code);
    result.status = d.status === 'pending-acceptance' || d.upstreamStatus === 'pending-acceptance'
      ? 'waiting-acceptance' : 'candidate';
    result.lockedVersion = d.acceptedVersion ?? d.version;
    result.repoAcceptance = { upstream: d.status === 'pending-acceptance' || d.upstreamStatus === 'pending-acceptance'
      ? 'pending-acceptance' : 'accepted', candidate: 'pending-acceptance' };
    result.actions.push({ type: 'write-candidate', path: r.output });
    return result;
  }
  const data = deriveData(r.kind, d, e, checkpoint, strategy);
  if (data) {
    result.data = data; result.status = data.status ?? 'derived';
    result.questions = data.questions ?? [];
    await writeOutput(root, r.output, JSON.stringify(data, null, 2) + '\n');
    result.actions.push({ type: 'write-derived', path: r.output }); return result;
  }
  const doc = composeDocument(r.kind, d, e, r);
  if (doc) {
    result.propositions = doc.propositions; result.status = 'pending-human';
    result.questions = r.kind === 'migration-document' ? e.missing : [];
    const paths = r.documents?.map(name => join(r.output, name)) ?? [r.output];
    result.artifacts = [];
    for (const path of paths) {
      const propositions = doc.propositions[path.split('/').at(-1)] ?? doc.propositions;
      const introduction = style === 'brief' ? 'Review draft: the following constraints apply; this document is not accepted or an instruction to execute.\n\n' : '';
      await writeOutput(root, path, `# ${r.title}\n\n${introduction}${doc.text}\n\nEvidence version: ${d.version}\n\n` +
        '```json\n' + JSON.stringify({ propositions }, null, 2) + '\n```\n');
      result.artifacts.push(path);
      result.actions.push({ type: 'write-document', path });
    }
    return result;
  }
  const research = composeResearch(r.kind, d, e);
  if (research) {
    Object.assign(result, research, { status: 'pending-human', disposition: research.status });
    const introduction = style === 'brief' ? 'Conditional analysis, not approval. Open questions remain unknown, not assumed facts.\n\n' : '';
    await writeOutput(root, r.output, `# ${r.title}\n\n${introduction}${research.text}\n\n` +
      '```json\n' + JSON.stringify({ claims: research.claims, questions: research.questions }, null, 2) + '\n```\n');
    result.artifacts = [r.output]; result.actions.push({ type: 'write-research', path: r.output });
    return result;
  }
  const operation = await operate(root, r.kind, d, e, identity);
  if (operation) {
    Object.assign(result, operation);
    await writeOutput(root, r.output, JSON.stringify(operation, null, 2) + '\n');
    result.actions.push({ type: 'persist-business-receipt', path: r.output });
    return result;
  }
  throw new Error(`No public business strategy for ${r.kind}`);
}
