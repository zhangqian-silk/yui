import { FileFault } from './fileToolsSupport.js';

// Deliberately small grammars. No JavaScript backtracking regexp on caller input.
export type MatchBudget = { remaining: number };
const tick = (budget: MatchBudget) => {
  if (--budget.remaining < 0) throw new FileFault('pattern_limit', 'Pattern matching work budget exceeded; narrow scope/pattern');
};
const unsupported = (): never => { throw new FileFault('unsupported_pattern', 'Unsupported pattern syntax; see repository-tool grammar'); };
type Atom = { test: (character: string) => boolean; repeat: boolean; optional: boolean };
function characterClass(pattern: string, start: number, globClass = false): { test: Atom['test']; end: number } {
  let end = start + 1;
  const negative = pattern[end] === '^' || (globClass && pattern[end] === '!');
  if (negative) end++;
  const ranges: [number, number][] = [];
  while (end < pattern.length && pattern[end] !== ']') {
    const first = String.fromCodePoint(pattern.codePointAt(end)!);
    end += first.length;
    if (first === '\\' || first === '[') unsupported();
    let last = first;
    if (pattern[end] === '-' && pattern[end + 1] !== ']') {
      end++;
      if (end >= pattern.length) unsupported();
      last = String.fromCodePoint(pattern.codePointAt(end)!);
      end += last.length;
      if (last.codePointAt(0)! < first.codePointAt(0)!) unsupported();
    }
    ranges.push([first.codePointAt(0)!, last.codePointAt(0)!]);
  }
  if (pattern[end] !== ']' || !ranges.length) unsupported();
  return { test: ch => negative !== ranges.some(([first, last]) => ch.codePointAt(0)! >= first && ch.codePointAt(0)! <= last), end };
}
function boundedPattern(pattern: string) {
  if (!pattern || pattern.length > 256 || /[\0\r\n]/.test(pattern)) unsupported();
}
function sequence(atoms: Atom[], text: string, budget: MatchBudget, startAnchor = true, endAnchor = true): boolean {
  let active = new Uint8Array(atoms.length + 1);
  active[0] = 1;
  const closure = (states: Uint8Array) => {
    for (let i = 0; i < atoms.length; i++) {
      tick(budget);
      if (states[i] && atoms[i].optional) states[i + 1] = 1;
    }
  };
  closure(active);
  if (!endAnchor && active[atoms.length]) return true;
  for (const ch of text) {
    const next = new Uint8Array(atoms.length + 1);
    if (!startAnchor) next[0] = 1;
    for (let i = 0; i < atoms.length; i++) {
      tick(budget);
      if (active[i] && atoms[i].test(ch)) {
        next[i + 1] = 1;
        if (atoms[i].repeat) next[i] = 1;
      }
    }
    closure(next);
    active = next;
    if (!endAnchor && active[atoms.length]) return true;
  }
  return !!active[atoms.length];
}
/** *, ?, classes, backslash literal escapes; ** is only a complete path segment. */
export function glob(pattern: string): (text: string, budget: MatchBudget) => boolean {
  boundedPattern(pattern);
  const segments = pattern.split('/').map(segment => {
    if (segment === '**') return null;
    const atoms: Atom[] = [];
    for (let i = 0; i < segment.length; i++) {
      const ch = String.fromCodePoint(segment.codePointAt(i)!);
      if (ch === '*' && segment[i + 1] === '*') unsupported();
      if (ch === '*') atoms.push({ test: () => true, repeat: true, optional: true });
      else if (ch === '?') atoms.push({ test: () => true, repeat: false, optional: false });
      else if (ch === '[') {
        const cls = characterClass(segment, i, true); i = cls.end;
        atoms.push({ test: cls.test, repeat: false, optional: false });
      } else {
        if (ch === '\\' && ++i >= segment.length) unsupported();
        const literal = ch === '\\' ? String.fromCodePoint(segment.codePointAt(i)!) : ch;
        if (ch !== '\\' && '{}]'.includes(literal)) unsupported();
        i += literal.length - 1;
        atoms.push({ test: value => value === literal, repeat: false, optional: false });
      }
    }
    return atoms;
  });
  return (text, budget) => {
    const parts = text.split('/');
    let active = new Uint8Array(parts.length + 1); active[0] = 1;
    for (const segment of segments) {
      const next = new Uint8Array(parts.length + 1);
      for (let j = 0; j <= parts.length; j++) {
        tick(budget);
        if (segment === null) {
          if (active[j] || (j > 0 && next[j - 1])) next[j] = 1;
        } else if (j < parts.length && active[j] && sequence(segment, parts[j], budget)) next[j + 1] = 1;
      }
      active = next;
    }
    return !!active[parts.length];
  };
}
/** Single-line regex: literals, . classes, ^ $, escapes, * + ?. No groups/alternation/counts/lookaround/backrefs. */
export function regex(pattern: string): (text: string, budget: MatchBudget) => boolean {
  boundedPattern(pattern);
  const startAnchor = pattern.startsWith('^');
  let endAnchor = false;
  const atoms: Atom[] = [];
  for (let i = startAnchor ? 1 : 0; i < pattern.length; i++) {
    const ch = String.fromCodePoint(pattern.codePointAt(i)!);
    if (ch === '$' && i === pattern.length - 1) { endAnchor = true; break; }
    let test: Atom['test'] = () => false;
    if (ch === '.') test = () => true;
    else if (ch === '[') { const cls = characterClass(pattern, i); test = cls.test; i = cls.end; }
    else if (ch === '\\') {
      const escaped = pattern[++i] ?? unsupported();
      if (/[0-9]/.test(escaped)) unsupported();
      if (escaped === 'd') test = value => value >= '0' && value <= '9';
      else if (escaped === 'w') test = value => /^[A-Za-z0-9_]$/.test(value);
      else if (escaped === 's') test = value => /^\s$/.test(value);
      else if ('\\.^$*+?[](){}|'.includes(escaped)) test = value => value === escaped;
      else unsupported();
    } else {
      if ('^$*+?(){}|]'.includes(ch)) unsupported();
      test = value => value === ch;
    }
    if (ch.length > 1) i += ch.length - 1;
    const quantifier = '*+?'.includes(pattern[i + 1] ?? '\0') ? pattern[++i] : '';
    atoms.push({ test, repeat: quantifier === '*' || quantifier === '+', optional: quantifier === '*' || quantifier === '?' });
  }
  return (text, budget) => sequence(atoms, text, budget, startAnchor, endAnchor);
}
