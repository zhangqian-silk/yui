import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockProvider, createTextTools } from './index.js';
import { createMemoryDemoSessions, openCli } from './interaction/index.js';

// This program owns its disposable files and execution service. The CLI itself
// only detaches; this owner explicitly cancels and settles turns on process exit.
let root: string | undefined;
let sessions: ReturnType<typeof createMemoryDemoSessions> | undefined;
let cli: Awaited<ReturnType<typeof openCli>> | undefined;
let stopping = false;
const interrupt = () => { stopping = true; cli?.close(); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  root = await mkdtemp(path.join(tmpdir(), 'independent-agent-cli-'));
  await writeFile(path.join(root, 'input.txt'), 'Disposable mock CLI example.\n');
  let draw = 0;
  sessions = createMemoryDemoSessions({
    provider: createMockProvider({ toolCallProbability: 0.5, random: () => [0.1, 0.2, 0.9][draw++ % 3] }),
    tools: createTextTools({ root }),
  });
  cli = await openCli({ sessions, input: process.stdin, output: process.stdout });
  if (stopping) cli.close();
  const end = await cli.done;
  if (end.reason === 'display-error' || end.reason === 'input-error') process.exitCode = 1;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
  cli?.close();
  await sessions?.close();
  if (root) await rm(root, { recursive: true, force: true });
}
