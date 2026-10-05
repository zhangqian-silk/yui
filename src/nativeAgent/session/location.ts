import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SessionLocation } from './contracts.js';
import { SessionError } from './format.js';

export const locationLimits = Object.freeze({ pathBytes: 4096 });
/** Pure lexical admission. No filesystem lookup, normalization or permission. */
export function copyLocation(value: unknown): SessionLocation {
  const invalid = (): never => {
    throw new SessionError('invalid_location', 'Expected only resolved absolute root/cwd within root, each at most 4096 UTF-8 bytes');
  };
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 2
    || !Object.hasOwn(value, 'root') || !Object.hasOwn(value, 'cwd')) return invalid();
  const { root, cwd } = value as Record<string, unknown>;
  for (const path of [root, cwd]) {
    if (typeof path !== 'string' || Buffer.byteLength(path) > locationLimits.pathBytes
      || /[\p{Cc}\p{Cs}]/u.test(path) || !isAbsolute(path) || resolve(path) !== path) return invalid();
  }
  const within = relative(root as string, cwd as string);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return invalid();
  return { root: root as string, cwd: cwd as string };
}

export function decodeLocation(text: unknown): SessionLocation | null {
  if (text === null) return null;
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 6 * locationLimits.pathBytes + 64) {
      throw new Error('Oversized or non-text location');
    }
    return copyLocation(JSON.parse(text));
  } catch (cause) {
    throw new SessionError('corrupt_session', 'Malformed stored location; do not guess a working directory', { cause });
  }
}
