import { describe, expect, it } from 'vitest';
import { buildExport, exportFileName, helpersOf, render } from '../src/engine/export';
import type { Thread } from '../src/engine/types';

const T0 = Date.UTC(2026, 10, 13, 15, 0, 0);

const thread = (over: Partial<Thread>): Thread => ({
  id: 't1',
  title: 'Fix the login bug',
  cwd: '/work/app',
  status: 'idle',
  queue: [],
  messages: [],
  createdAt: T0,
  updatedAt: T0,
  session: { accountId: 'a1', kind: 'codex', id: 'secret-session' },
  runId: 'run-1',
  lastLog: '/logs/run-1.log',
  ...over,
});

const label = (id?: string) => (id === 'a1' ? 'Codex · work' : id === 'a2' ? 'Claude · home' : 'unknown');

const threads: Thread[] = [
  thread({
    messages: [
      { at: T0, role: 'user', text: 'Login fails on Safari', attachments: ['/a/shot.png'] },
      { at: T0 + 1000, role: 'system', text: 'Codex · work is on it.' },
      {
        at: T0 + 60000,
        role: 'agent',
        accountId: 'a1',
        text: 'Fixed the cookie flag.',
        activity: ['Read src/auth.ts', 'Edited src/auth.ts'],
        workedMs: 59000,
        changes: { before: 'b', after: 'a', files: [{ path: 'src/auth.ts', add: 3, del: 1 }] },
      },
    ],
  }),
  thread({ id: 'h2', title: 'Nested helper', parentId: 'h1', createdAt: T0 + 3000, messages: [{ at: T0 + 3000, role: 'agent', accountId: 'a2', text: 'deep' }] }),
  thread({ id: 'h1', title: 'Write tests', parentId: 't1', createdAt: T0 + 2000, messages: [{ at: T0 + 2000, role: 'agent', accountId: 'a2', text: 'Tests added.' }] }),
  thread({ id: 'other', title: 'Unrelated', createdAt: T0 + 5000 }),
];

describe('conversation export', () => {
  it('finds helper threads at any depth, oldest first, and nothing unrelated', () => {
    expect(helpersOf(threads, 't1').map((t) => t.id)).toEqual(['h1', 'h2']);
  });

  it('builds JSON with authors and turn details, without internal session state', () => {
    const x = buildExport(threads, 't1', label, T0 + 99000);
    expect(x.format).toBe('super-agent-conversation');
    expect(x.exportedAt).toBe('2026-11-13T15:01:39.000Z');
    expect(x.thread.messages.map((m) => m.author)).toEqual(['You', 'Super Agent', 'Codex · work']);
    expect(x.thread.messages[2]).toMatchObject({ workedMs: 59000, changes: [{ path: 'src/auth.ts', add: 3, del: 1 }] });
    expect(x.helpers.map((h) => h.title)).toEqual(['Write tests', 'Nested helper']);
    const json = render(x, 'json');
    expect(JSON.parse(json)).toEqual(x);
    expect(json).not.toContain('secret-session');
    expect(json).not.toContain('run-1');
  });

  it('renders readable Markdown', () => {
    const md = render(buildExport(threads, 't1', label, T0), 'markdown');
    expect(md).toMatch(/^# Fix the login bug\n/);
    expect(md).toContain('## You · 2026-11-13 15:00:00 UTC');
    expect(md).toContain('> Codex · work is on it.');
    expect(md).toContain('- `src/auth.ts` +3 -1');
    expect(md).toContain('<summary>Worked for 59s</summary>');
    expect(md).toContain('## Helper threads');
    expect(md).toContain('### Write tests');
    expect(md).not.toContain('Unrelated');
  });

  it('throws for an unknown thread', () => {
    expect(() => buildExport(threads, 'nope', label)).toThrow();
  });

  it('makes safe file names', () => {
    expect(exportFileName('Fix: the "login" bug / Safari?', 'markdown', T0)).toBe('fix-the-login-bug-safari-2026-11-13.md');
    expect(exportFileName('???', 'json', T0)).toBe('conversation-2026-11-13.json');
  });
});
