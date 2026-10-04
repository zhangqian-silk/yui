import { runProductRuntime } from './runtime.js';
import { ProductError, resolveCredential, resolveProductArguments, createProductBinding, publicConfiguration } from './config.js';
export { productFailure } from './config.js';

export const productHelp = `Independent coding Agent (no Controller or Yui Home)
  yui agent check-config [options]
  yui agent start [options] [--session ID]
  yui agent run [options] --input TEXT [--session ID]

Required: --endpoint COMPLETE_URL --model NAME --credential-ref env:NAME|anonymous --state-dir PATH
Optional: --config FILE --cwd PATH --adapter chat-completions
          --tools read,list,find,search --max-steps 8
          --context-bytes 1048576 --output-reserve-bytes 0
          --model-timeout-ms 30000 --stream true|false
Explicit opt-ins on EVERY invocation: --allow-write --allow-command --allow-http
Only loopback HTTP is allowed. --command-config JSON supplies explicit env and reviewed specs.
Command authorization is exact executable/argv/cwd/effect; no arbitrary model scripts.
Complete env permits only PATH/LANG/LC_ALL/TZ; nothing is inherited.
start uses the existing line UI: text, /cancel, /history, /use ID, /new, /quit.
Ctrl-C cancels the active turn (or exits when idle); SIGTERM/EOF close owned execution.
run emits result + exact save receipt; exit 0 completed, 1 error, 3 budget, 130 cancelled.
CLI > NATIVE_AGENT_* environment > explicit version-1 JSON file > safe defaults.
No automatic config discovery, account fallback, tool replay or inherited grants.
Real local tools/permission/environment are created together; reopen rebuilds current authority.
Persistent catalog/cwd metadata await the real producer module;
/sessions currently lists this process's explicit selections, not persisted discovery.
`;

export async function runProductCommand(args: string[]): Promise<number> {
  const helpArguments = args.filter(argument => argument !== '--json');
  if (helpArguments.length === 0 || (helpArguments.length === 1 && ['help', '--help', '-h'].includes(helpArguments[0]))) {
    process.stdout.write(args.includes('--json') ? `${JSON.stringify({ help: productHelp })}\n` : productHelp);
    return 0;
  }
  const invocation = await resolveProductArguments(args, process.env, process.cwd());
  const credential = resolveCredential(invocation.config, process.env);
  if (credential && invocation.input?.includes(credential)) {
    throw new ProductError('agent_config', 'input', 'Do not submit the configured credential as conversation text.');
  }
  if (invocation.command === 'check-config') {
    const binding = createProductBinding(invocation, credential);
    process.stdout.write(`${JSON.stringify({ configuration: publicConfiguration(invocation.config),
      binding: binding.binding, credential: 'resolved-in-memory',
      network: 'not-contacted', state: 'not-opened' })}\n`);
    return 0;
  }
  return runProductRuntime(invocation, credential);
}
