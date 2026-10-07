// Private oracle subprocess entry. Never place this file in participant scope.
import { scoreCode } from './oracle.mjs';
const [id, root, resultText] = process.argv.slice(2);
const checks = [];
try {
  await scoreCode(id, root, JSON.parse(resultText), (passed, criterion) => checks.push({ passed: !!passed, criterion }));
} catch (error) {
  checks.push({ passed: false, criterion: 'code-probe-error', error: String(error) });
}
process.stdout.write(JSON.stringify(checks));
