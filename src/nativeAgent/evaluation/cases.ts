/** Versioned, deliberately tiny repositories. No downloaded task data. */
export type CaseId = 'repair' | 'refactor' | 'tests';
export type EvaluationCase = Readonly<{
  id: CaseId;
  revision: '1';
  category: 'repair' | 'refactor' | 'test-addition';
  input: string;
  allowedChanges: readonly string[];
}>;
const mean = 'function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }\nmodule.exports = { mean };\n';
const correctMean = mean.replace('return values.reduce', 'if (values.length === 0) return 0; return values.reduce');
const refactor = 'function twice(value) { return value * 2; }\nfunction fourTimes(value) { return value * 2 * 2; }\nmodule.exports = { twice, fourTimes };\n';
export const evaluationCases: readonly EvaluationCase[] = Object.freeze([
  Object.freeze({ id: 'repair' as const, revision: '1' as const, category: 'repair' as const,
    input: 'Fix mean([]) to return 0, preserving arithmetic mean for nonempty numeric arrays. Only math.cjs may change.',
    allowedChanges: Object.freeze(['math.cjs']) }),
  Object.freeze({ id: 'refactor' as const, revision: '1' as const, category: 'refactor' as const,
    input: 'Extract a shared function double(value). twice must call it once and fourTimes twice. Preserve numeric behavior and both exports. Only math.cjs may change.',
    allowedChanges: Object.freeze(['math.cjs']) }),
  Object.freeze({ id: 'tests' as const, revision: '1' as const, category: 'test-addition' as const,
    input: 'Add math.test.cjs with executable node:assert/strict assertions protecting the mean([]) === 0 boundary. Require ./math.cjs. Do not change production code or other files.',
    allowedChanges: Object.freeze(['math.test.cjs']) }),
]);
export function getCase(id: CaseId): EvaluationCase {
  const found = evaluationCases.find(c => c.id === id);
  if (!found) throw new Error('Unknown fixed evaluation case');
  return found;
}
export function baselineFiles(id: CaseId): Readonly<Record<string, string>> {
  return Object.freeze({
    'package.json': '{"name":"disposable-evaluation-repository","private":true,"version":"1.0.0"}\n',
    'README.md': 'Controlled evaluation fixture. No downloaded dependencies or external services.\n',
    'math.cjs': id === 'refactor' ? refactor : id === 'repair' ? mean : correctMean,
  });
}
export function solution(id: CaseId, good: boolean): { path: string; content: string } {
  if (id === 'tests') return { path: 'math.test.cjs', content: good
    ? 'const assert = require("node:assert/strict");\nconst { mean } = require("./math.cjs");\nassert.equal(mean([]), 0);\nassert.equal(mean([2, 4]), 3);\n'
    : 'console.log("PASS");\n' };
  return { path: 'math.cjs', content: id === 'repair' ? good ? correctMean
    : mean.replace('return values.reduce', 'if (values.length === 0) return 1; return values.reduce')
    : good ? 'function double(value) { return value * 2; }\nfunction twice(value) { return double(value); }\nfunction fourTimes(value) { return double(double(value)); }\nmodule.exports = { twice, fourTimes };\n'
      // A real file edit, but not the requested extraction.
      : `${refactor}// Refactor claimed complete.\n` };
}
