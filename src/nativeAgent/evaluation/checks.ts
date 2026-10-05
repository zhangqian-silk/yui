import { createHash } from 'node:crypto';
import { createCommandTool } from '../index.js';
import type { CaseId } from './cases.js';
/** Held by the evaluator, passed as argv, NEVER read from candidate files.
 * Controlled fixture code only: vm and tool path checks are not an OS sandbox.
 * Snapshot strings are evaluated with no filesystem/process/network capability.
 * Every API invocation is inside the vm timeout, not a host-side function call.
 */
const checker = String.raw`
const vm = require('node:vm');
const data = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const mode = process.argv[2];
try {
  let source = data.source;
  if (mode === 'tests-mutant') {
    source = 'function mean(values) { if (values.length === 0) return NaN; return values.reduce((s,v)=>s+v,0)/values.length; } module.exports={mean};';
  }
  const context = vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
  const run = text => new vm.Script(text).runInContext(context, {timeout:100});
  run('var module = {exports:{}};');
  run(source);
  if (mode === 'behavior') {
    run(data.caseId === 'refactor'
      ? 'for (const v of [-7,-1,0,0.5,2,12]) { if (module.exports.twice(v) !== v*2 || module.exports.fourTimes(v) !== v*4) throw Error("behavior"); }'
      : 'for (const [v,w] of [[[],0],[[2,4],3],[[-6,2],-2],[[5],5],[[0,0],0],[[1,2,9],4]]) { if (module.exports.mean(v) !== w) throw Error("behavior"); }');
  } else if (mode === 'structure') {
    // Intervention proves actual delegation, not comments or a helper-shaped no-op.
    run('if(typeof double !== "function" || double(7)!==14) throw Error("helper"); double = value => value+100; if(module.exports.twice(3)!==103 || module.exports.fourTimes(3)!==203) throw Error("delegation");');
  } else {
    if (typeof data.tests !== 'string') throw Error('missing tests');
    // This fixed task supports equal/strictEqual assertions on primitive values.
    // Counts stay in a trusted closure, not globals writable by candidate tests.
    const assertions = run(String.raw` + "`" + String.raw`
      (() => {
        let count = 0, failed = false;
        const api = Object.freeze({
          equal(actual,expected) { count++; if(!Object.is(actual,expected)) { failed=true; throw Error('assertion'); } },
          strictEqual(actual,expected) { return api.equal(actual,expected); }
        });
        return Object.freeze({api, get count(){return count;}, get failed(){return failed;}});
      })()
    ` + "`" + String.raw`);
    context.assertionApi = assertions.api;
    run(String.raw` + "`" + String.raw`
      var require = ((api, exports) => name => {
        if(name === 'node:assert/strict') return api;
        if(name === './math.cjs') return exports;
        throw Error('require not permitted');
      })(assertionApi, module.exports);
      var console = Object.freeze({log(){}});
    ` + "`" + String.raw`);
    delete context.assertionApi;
    try { run('(function(){\n' + data.tests + '\n})()'); }
    catch { if (mode !== 'tests-mutant' || !assertions.failed) throw Error('test execution'); }
    if (!assertions.count) throw Error('no assertions');
    if (mode === 'tests-mutant') {
      if (!assertions.failed) throw Error('mutant survived');
      // Expected nonzero is evidence that an actual assertion killed the mutant.
      process.exitCode = 1;
      process.stdout.write('assertion-failed');
    } else if (assertions.failed) throw Error('test assertion');
  }
} catch {
  process.exitCode = 1;
  process.stdout.write('check-failed');
}
`;
export type CheckId = 'behavior' | 'structure' | 'tests-normal' | 'tests-mutant';
export type CheckEvidence = {
  id: CheckId;
  stage: 'baseline' | 'candidate';
  verifierDigest: string;
  inputDigest: string;
  toolOk: boolean;
  exitCode: number | null;
  assertionKilledMutant: boolean;
  processGroup: 'absent' | 'present' | 'unknown';
  directChildExited: boolean;
  durationMs: number;
  errorCode?: string;
};
export const verifierDigest = createHash('sha256').update(checker).digest('hex');
export function checkIds(caseId: CaseId): CheckId[] {
  return caseId === 'refactor' ? ['behavior', 'structure']
    : caseId === 'tests' ? ['behavior', 'tests-normal', 'tests-mutant'] : ['behavior'];
}
/** Runs the immutable check against an exact already-read snapshot. */
export async function runCheck(root: string, caseId: CaseId, source: string | undefined, tests: string | undefined,
  id: CheckId, stage: CheckEvidence['stage']): Promise<CheckEvidence> {
  const input = JSON.stringify({ caseId, source: source ?? '', tests });
  const start = performance.now();
  const outcome = await createCommandTool({ root, env: {}, timeoutMs: 2000, maxOutputBytes: 1024 })
    .execute({ command: process.execPath, argv: ['-e', checker, Buffer.from(input).toString('base64'), id], cwd: root },
      { sessionId: 'independent-check', turnId: stage, step: 1, toolCallId: id }, new AbortController().signal);
  let evidence: { exitCode: number | null; processGroup: 'absent' | 'present' | 'unknown'; directChildExited: boolean;
    stdout?: string } | undefined;
  try { evidence = JSON.parse(outcome.ok ? outcome.content : outcome.error.message); } catch { /* no invented process facts */ }
  return {
    id, stage, verifierDigest, inputDigest: createHash('sha256').update(input).digest('hex'),
    toolOk: outcome.ok, exitCode: evidence?.exitCode ?? null,
    assertionKilledMutant: id === 'tests-mutant' && evidence?.stdout === 'assertion-failed',
    processGroup: evidence?.processGroup ?? (outcome.ok ? 'unknown' : outcome.error.effect === 'none' ? 'absent' : 'unknown'),
    directChildExited: evidence?.directChildExited ?? false, durationMs: performance.now() - start,
    ...(!outcome.ok ? { errorCode: outcome.error.code } : {}),
  };
}
