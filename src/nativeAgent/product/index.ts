import { runProductRuntime } from './runtime.js';
import { ProductError, resolveCredential, resolveProductArguments, createProductBinding, publicConfiguration } from './config.js';
import { catalogCommands, runCatalogCommand } from './catalog.js';
export { productFailure } from './config.js';

export const productHelp = `Independent coding Agent (no Controller or Yui Home)
  yui agent check-config [options]
  yui agent start [options] [--session ID]
  yui agent run [options] --input TEXT [--session ID]
  yui agent sessions --state-dir PATH [--limit N] [--cursor CURSOR]
  yui agent session-info|history --state-dir PATH --session ID [history: --limit N --cursor CURSOR]
  yui agent rename --state-dir PATH --session ID --title JSON_STRING_OR_NULL --expected-metadata-revision N

Required: --endpoint COMPLETE_URL --model NAME --credential-ref env:NAME|anonymous --state-dir PATH
Optional: --config FILE --cwd PATH --adapter chat-completions
          --tools read,list,find,search,project_context,project_memory --max-steps 8
          --context-bytes 1048576 --output-reserve-bytes 0
          --model-timeout-ms 30000 --stream true|false
Explicit opt-ins on EVERY invocation: --allow-write --allow-command --allow-memory-write --allow-http
Only loopback HTTP is allowed. --command-config JSON supplies explicit env and reviewed specs.
Command authorization is exact executable/argv/cwd/effect; no arbitrary model scripts.
Complete env permits only PATH/LANG/LC_ALL/TZ; nothing is inherited.
start uses the existing line UI: text, /cancel, /sessions [CURSOR], /history [CURSOR], /info,
/rename EXPECTED_METADATA_REVISION JSON_STRING_OR_NULL, /use ID, /new, /quit.
Ctrl-C cancels the active turn (or exits when idle); SIGTERM/EOF close owned execution.
run emits result + exact save receipt; exit 0 completed, 1 error, 3 budget, 130 cancelled.
CLI > NATIVE_AGENT_* environment > explicit version-1 JSON file > safe defaults.
No automatic config discovery, account fallback, tool replay or inherited grants.
Real local tools/permission/environment are created together; reopen rebuilds current authority.
Project guidance is required; Skills load completely on request as project/user data.
project_memory reads .agents/MEMORY.md; replace/delete need --allow-memory-write, not --allow-write.
Catalog commands need only the existing state directory; reads never start execution.
Duplicate titles are not identities. Stale cursors require an explicit first-page refresh.
Original root/cwd metadata are not yet persisted; no automatic location restoration is claimed.
`;

export async function runProductCommand(args: string[]): Promise<number> {
  const helpArguments = args.filter(argument => argument !== '--json');
  if (helpArguments.length === 0 || (helpArguments.length === 1 && ['help', '--help', '-h'].includes(helpArguments[0]))) {
    process.stdout.write(args.includes('--json') ? `${JSON.stringify({ help: productHelp })}\n` : productHelp);
    return 0;
  }
  if (catalogCommands.some(command => command === args[0])) return runCatalogCommand(args, process.env, process.cwd());
  const invocation = await resolveProductArguments(args, process.env, process.cwd());
  const credential = resolveCredential(invocation.config, process.env);
  if (credential && invocation.input?.includes(credential)) {
    throw new ProductError('agent_config', 'input', 'Do not submit the configured credential as conversation text.');
  }
  if (invocation.command === 'check-config') {
    const binding = createProductBinding(invocation, credential);
    process.stdout.write(`${JSON.stringify({ configuration: publicConfiguration(invocation.config),
      binding: binding.binding, projectAuthority: { allowMemoryWrite: invocation.allowMemoryWrite },
      credential: 'resolved-in-memory',
      network: 'not-contacted', state: 'not-opened' })}\n`);
    return 0;
  }
  return runProductRuntime(invocation, credential);
}
