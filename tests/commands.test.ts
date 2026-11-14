import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandCatalog, OWN_COMMANDS, codexPrompts, expandPrompt, parseCommand } from '../src/core/agents/commands';
import type { Account } from '../src/core/types';

describe('parseCommand', () => {
  it('splits a slash command into its name and arguments', () => {
    expect(parseCommand('/compact')).toEqual({ name: 'compact', args: '' });
    expect(parseCommand('  /review base main ')).toEqual({ name: 'review', args: 'base main' });
    expect(parseCommand('/sparc:tdd write\nthe tests')).toEqual({ name: 'sparc:tdd', args: 'write\nthe tests' });
    expect(parseCommand('/code-review high --fix')).toEqual({ name: 'code-review', args: 'high --fix' });
  });

  it('leaves paths and plain text alone', () => {
    expect(parseCommand('/src/app.ts is broken')).toBeUndefined();
    expect(parseCommand('please /compact')).toBeUndefined();
    expect(parseCommand('/')).toBeUndefined();
  });
});

describe('Codex custom prompts', () => {
  it('lists <home>/prompts/*.md and fills in their arguments', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-codex-'));
    fs.mkdirSync(path.join(home, 'prompts'));
    const file = path.join(home, 'prompts', 'fix.md');
    fs.writeFileSync(file, '---\ndescription: "Fix an issue"\n---\nFix issue $1 in $2. All: $ARGUMENTS');
    const acc: Account = { id: 'x', kind: 'codex', label: 'x', home, role: 'worker', createdAt: 0 };
    expect(codexPrompts(acc)).toEqual([{ name: 'prompts:fix', description: 'Fix an issue', file }]);
    expect(expandPrompt(file, '42 parser.ts')).toBe('Fix issue 42 in parser.ts. All: 42 parser.ts');
  });
});

describe('CommandCatalog', () => {
  it("offers Super Agent's own commands even when the CLI can't be asked", async () => {
    const acc: Account = { id: 'c', kind: 'claude', label: 'c', home: null, role: 'master', createdAt: 0 };
    const list = await new CommandCatalog().list(acc, null, os.tmpdir());
    expect(list).toEqual(OWN_COMMANDS);
  });
});
