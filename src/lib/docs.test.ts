// The documents have a shape, and a written rule was not enough to keep it: three rounds produced three
// styles, a 1,900-line CLAUDE.md and pointers to sections that had been renamed. This is the guard.
//
// It reads the real files, so a change that breaks the agreement fails here rather than at the next
// reader.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');

const CLAUDE = 'CLAUDE.md';
const CHANGELOG = 'CHANGELOG.md';
const SPEC = 'docs/SPEC.md';
const DECISIONS = 'docs/DECISIONS.md';
const DOCS = [CLAUDE, CHANGELOG, 'README.md', SPEC, DECISIONS];

function read(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

/**
 * The document with its code fences and inline code spans removed. An example inside a fence is not a
 * live pointer, and the template in CLAUDE.md is written out of literal `§ *Name*` placeholders.
 */
function prose(file: string): string {
  return read(file)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
}

function headings(file: string): string[] {
  return [...read(file).matchAll(/^#{2,4} (.+)$/gm)].map((match) => match[1].trim());
}

/** `## ` sections with their bodies, which is the unit the template applies to. */
function sections(file: string): Array<{ title: string; body: string }> {
  const parts = read(file).split(/^## /m).slice(1);
  return parts.map((part) => ({ title: part.split('\n')[0].trim(), body: part }));
}

describe('the documents exist where the agreement says', () => {
  it.each(DOCS)('%s', (file) => {
    expect(fs.existsSync(path.join(root, file))).toBe(true);
  });
});

describe('every pointer resolves', () => {
  it('names a heading that exists, wherever a `§ *Name*` appears', () => {
    const known = [...headings(SPEC), ...headings(DECISIONS)];
    const broken: string[] = [];
    for (const file of DOCS) {
      for (const match of prose(file).matchAll(/§ \*([^*]+)\*/g)) {
        const name = match[1].trim();
        if (!known.some((heading) => heading.startsWith(name))) broken.push(`${file} → ${name}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('links a file that exists, wherever a markdown link is relative', () => {
    const broken: string[] = [];
    for (const file of DOCS) {
      for (const match of read(file).matchAll(/\[[^\]]+\]\(([^)#][^)]*)\)/g)) {
        const target = match[1];
        if (target.startsWith('http')) continue;
        const resolved = path.resolve(path.dirname(path.join(root, file)), target);
        if (!fs.existsSync(resolved)) broken.push(`${file} → ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('docs/SPEC.md describes the screen that exists', () => {
  /**
   * The two controls the spec described before the month calendar and the typed hour replaced them.
   * A spec naming a component that is not in the tree sends the next reader to a file that is not
   * there — and it was the pointer this file already caught once, under a different name.
   */
  const RETIRED = ['DateSelect', 'TimeSelect'];

  it('names the day picker and the time field, and neither control they replaced', () => {
    for (const file of [SPEC, DECISIONS]) {
      const text = read(file);
      for (const name of RETIRED) expect(text).not.toContain(name);
    }
    const spec = read(SPEC);
    expect(spec).toContain('DayPicker');
    expect(spec).toContain('TimeField');
  });
});

describe('docs/DECISIONS.md keeps one shape', () => {
  /** Every entry opens the same way, so a reader knows where the rule is without reading the prose. */
  const LEAD_IN = /^\*\*(Rule\*\* — |Rejected)/;

  /** `Open Decisions` is a list of questions rather than a decision, and is exempt by design. */
  const entries = () => sections(DECISIONS).filter((section) => section.title !== 'Open Decisions');

  it('opens every entry with the rule itself', () => {
    const offenders = entries()
      .filter((section) => !LEAD_IN.test(section.body.split('\n').slice(1).find((line) => line.trim()) ?? ''))
      .map((section) => section.title);
    expect(offenders).toEqual([]);
  });

  it('explains every entry under a `**Why**`', () => {
    const offenders = entries()
      .filter((section) => !/^\*\*Why/m.test(section.body))
      .map((section) => section.title);
    expect(offenders).toEqual([]);
  });

  it('states the rule before explaining it, never the other way round', () => {
    const outOfOrder = entries()
      .filter((section) => section.body.includes('**Rule**'))
      .filter((section) => section.body.indexOf('**Rule**') > section.body.search(/^\*\*Why/m))
      .map((section) => section.title);
    expect(outOfOrder).toEqual([]);
  });

  it('is not a history: no entry is marked superseded or annotated as former', () => {
    // A superseded decision is deleted, because an agent reading "this used to be X" may restore X.
    const banned = /SUPERSEDED|\bDEPRECATED\b|no longer true|used to be the rule/i;
    const offenders = entries()
      .filter((section) => banned.test(section.body))
      .map((section) => section.title);
    expect(offenders).toEqual([]);
  });
});

describe('CLAUDE.md stays what it is for', () => {
  it('does not grow back into a specification', () => {
    // It was 1,906 lines once, most of it behaviour that belongs in SPEC.md. The budget is the guard:
    // a rule that needs more room than this is a rule that belongs in the spec.
    expect(read(CLAUDE).split('\n').length).toBeLessThan(320);
  });

  it('points at the other three documents by name', () => {
    const text = read(CLAUDE);
    for (const file of [CHANGELOG, SPEC, DECISIONS]) expect(text).toContain(file);
  });

  it('still carries the invariants, which are the reason it is loaded at all', () => {
    const text = read(CLAUDE);
    expect(text).toContain('## The invariants');
    // Numbered, so a new one is added to the list rather than buried in prose.
    expect(text).toMatch(/^1\. \*\*/m);
  });
});

describe('CHANGELOG.md answers for the version that is shipping', () => {
  it('has an entry for the version in package.json', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    const entries = headings(CHANGELOG);
    expect(entries.some((heading) => heading.startsWith(version))).toBe(true);
  });

  it('keeps the desktop package on the same version', () => {
    const app = JSON.parse(read('package.json')) as { version: string };
    const desktop = JSON.parse(read('desktop/package.json')) as { version: string };
    expect(desktop.version).toBe(app.version);
  });

  it('keeps both lockfiles on that version too', () => {
    // `npm install` writes the manifest's version into the lockfile in two places, and the installer
    // workflow keys its cache on those files. Left behind, the lockfile answers a version the app has
    // not been for three releases.
    for (const [manifest, lock] of [
      ['package.json', 'package-lock.json'],
      ['desktop/package.json', 'desktop/package-lock.json'],
    ]) {
      const { version } = JSON.parse(read(manifest)) as { version: string };
      const locked = JSON.parse(read(lock)) as {
        version: string;
        packages: Record<string, { version?: string }>;
      };
      expect([locked.version, locked.packages[''].version]).toEqual([version, version]);
    }
  });

  it('rules off the preamble and nothing else', () => {
    // Every entry below 0.22.1 is separated from the next by a blank line alone, and the one `---` in
    // the file sits between the preamble and the newest version. Seven crept in above it — one of them
    // written by an agent reordering the file — and nothing caught them, because shape is only a rule
    // here when it is a test.
    const rules = read(CHANGELOG)
      .split('\n')
      .flatMap((line, index) => (line.trim() === '---' ? [index + 1] : []));
    const firstEntry =
      read(CHANGELOG)
        .split('\n')
        .findIndex((line) => line.startsWith('## ')) + 1;

    expect(rules).toHaveLength(1);
    expect(rules[0]).toBeLessThan(firstEntry);
  });

  it('lists its versions newest first', () => {
    const versions = headings(CHANGELOG)
      .map((heading) => /^(\d+)\.(\d+)\.(\d+)/.exec(heading))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])] as const);
    const descending = [...versions].sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
    expect(versions).toEqual(descending);
  });
});

describe('the code does not point back at the documents', () => {
  it('carries no `SPEC.md §` or `DECISIONS.md §` pointer in a comment', () => {
    // That the rules and the reasoning live in those files is understood; repeating it on every symbol
    // is the noise the comment rule exists to stop.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
          continue;
        }
        if (!/\.(ts|tsx|mjs)$/.test(entry.name)) continue;
        if (full.endsWith('docs.test.ts')) continue;
        const source = fs.readFileSync(full, 'utf8');
        for (const [index, line] of source.split('\n').entries()) {
          const trimmed = line.trim();
          const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');
          if (isComment && /(SPEC|DECISIONS|CLAUDE)\.md\s*§/.test(line)) {
            offenders.push(`${path.relative(root, full)}:${index + 1}`);
          }
        }
      }
    };
    for (const dir of ['src', 'app', 'desktop', 'scripts']) walk(path.join(root, dir));
    expect(offenders).toEqual([]);
  });
});
