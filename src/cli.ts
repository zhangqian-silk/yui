#!/usr/bin/env node

import { unsupportedPlatformMessage } from "./runtime/platform.js";

// No static control-plane imports: the product never resolves/initializes Yui Home.
const arguments_ = process.argv.slice(2);
let commandOffset = 0;
while (arguments_[commandOffset] === '--json') commandOffset++;
const commandArguments = arguments_.slice(commandOffset);
const platformFailure = unsupportedPlatformMessage();
if (platformFailure !== undefined) {
  process.stderr.write(`${arguments_.includes("--json")
    ? JSON.stringify({ ok: false, code: "unsupported_platform", message: platformFailure })
    : platformFailure}\n`);
  process.exitCode = 1;
} else if (commandArguments[0] === 'agent' || (commandArguments[0] === 'help' && commandArguments[1] === 'agent')) {
  let outputFailed = false;
  // Cover early help/config writes as well as execution UI disconnection.
  process.stdout.on('error', () => { outputFailed = true; process.exitCode = 1; });
  process.stderr.on('error', () => { process.exitCode = 1; });
  let failure = { code: 'agent_execution', field: 'startup', nextAction: 'Check the local installation; no execution was replayed.' };
  try {
    const { runProductCommand, productFailure } = await import('./nativeAgent/product/index.js');
    try {
      const productArguments = commandArguments[0] === 'help' ? ['--help'] : commandArguments.slice(1);
      const code = await runProductCommand([...productArguments, ...(commandOffset ? ['--json'] : [])]);
      process.exitCode = outputFailed ? 1 : code;
    } catch (error) { failure = productFailure(error); throw error; }
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = failure.code === 'agent_config' ? 2 : 1;
  }
} else {
  await import('./controlPlaneCli.js');
}
