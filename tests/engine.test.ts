import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountPool } from '../src/core/agents/pool';
import type { RunRequest, RunResult } from '../src/core/agents/runner';
import type { Account } from '../src/core/types';
import { Engine } from '../src/engine/engine';
import type { Thread } from '../src/engine/types';

const acc = (id: string, kind: Account['kind'] = 'codex', role: Account['role'] = 'worker'): Account => ({ id, kind, label: id, home: null, role, createdAt: 0 });
const ok = (text: string, sessionId: string): RunResult => ({ code: 0, finalText: text, sessionId, rateLimited: false, cancelled: false, timedOut: false });

function setup(accounts: Account[], agent: (req: RunRequest, n: number) => Promise<RunResult>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ext-'));
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd);
  const pool = new AccountPool();
  const runs: RunRequest[] = [];
  const finished: string[] = [];
  const engine = new Engine({
    config: { accounts, settings: { taskTimeoutMin: 5 } } as never,
    pool,
    dataDir: dir,
    cliPath: () => 'fake',
    runAgent: async (req) => {
      runs.push(req);
      return agent(req, runs.length);
    },
    cancelRun: () => undefined,
    usageLoad: () => 0,
    usageResetAt: () => undefined,
    autonomy: () => 'standard',
    onChange: () => undefined,
    onOutput: () => undefined,
    onFinished: (t) => finished.push(t.title),
  });
  const idle = async (pred: () => boolean = () => engine.threads.every((t) => t.status === 'idle')) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
  };
  return { engine, runs, finished, cwd, pool, idle };
}

const msgs = (t: Thread, role: string) => t.messages.filter((m) => m.role === role).map((m) => m.text);

describe('lead works itself and keeps its context', () => {
  it('starts work immediately (no planning) and resumes its own session on the next message', async () => {
    const h = setup([acc('a', 'codex', 'master'), acc('b')], async (req, n) => ok(`answer ${n}`, 'sess-1'));
    const t = h.engine.send(undefined, 'build the thing', h.cwd);
    await h.idle();
    h.engine.send(t.id, 'now add tests', h.cwd);
    await h.idle();
    expect(h.runs.map((r) => r.account.id)).toEqual(['a', 'a']); // preferred lead, then the same agent again
    expect(h.runs[0].prompt).toContain('hand it off'); // knows how to spin off helpers
    expect(h.runs[1].resume).toBe('sess-1'); // exact context: same CLI session
    expect(msgs(t, 'agent')).toEqual(['answer 1', 'answer 2']);
    expect(h.finished).toHaveLength(2); // chime + notification each time
  });
});

describe('attachments and browser', () => {
  it('passes attached file paths to the agent and gives it a browser', async () => {
    const h = setup([acc('a', 'codex', 'master')], async () => ok('looked', 's'));
    const shot = path.join(h.cwd, '.super-agent', 'attachments', 'bug.png');
    const t = h.engine.send(undefined, 'what is wrong here?', h.cwd, [shot]);
    await h.idle();
    expect(h.runs[0].prompt).toContain(`Attached files (read them):\n- ${shot}`);
    expect(h.runs[0].browser).toBe(true);
    expect(t.messages[0]).toMatchObject({ role: 'user', text: 'what is wrong here?', attachments: [shot] });
  });
});

describe('seamless hand-over when usage runs out', () => {
  it('a free agent continues with a context brief (different CLI)', async () => {
    const h = setup([acc('a', 'codex', 'master'), acc('c', 'claude')], async (req) =>
      req.account.id === 'a' ? { code: 1, finalText: '', sessionId: 'sa', rateLimited: true, cancelled: false, timedOut: false } : ok('finished it', 'sc'),
    );
    const t = h.engine.send(undefined, 'refactor the parser', h.cwd);
    await h.idle(() => msgs(t, 'agent').length > 0);
    expect(h.runs.map((r) => r.account.id)).toEqual(['a', 'c']);
    expect(h.runs[1].prompt).toContain('Context hand-over');
    expect(h.runs[1].prompt).toContain('refactor the parser');
    expect(h.runs[1].prompt).toContain('taking over mid-task');
    expect(msgs(t, 'system').join(' ')).toMatch(/a ran out of usage, so c takes over/);
    expect(h.pool.get('a').cooldownUntil).toBeGreaterThan(Date.now());
    expect(t.session).toEqual({ accountId: 'c', kind: 'claude', id: 'sc' });
  });
});

describe('harmonic delegation', () => {
  it('a message sent while the lead is busy goes to a free agent as its own thread', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'claude')], async (req) => {
      if (req.account.id === 'a') await gate;
      return ok(`done by ${req.account.id}`, `s-${req.account.id}`);
    });
    const t = h.engine.send(undefined, 'long job', h.cwd);
    await h.idle(() => t.status === 'working');
    const child = h.engine.send(t.id, 'also write the README', h.cwd);
    expect(child.id).not.toBe(t.id);
    expect(child.parentId).toBe(t.id);
    await h.idle(() => msgs(child, 'agent').length > 0);
    expect(child.leadId).toBe('b');
    expect(h.runs[1].prompt).toContain('delegated from a busy teammate');
    expect(msgs(t, 'system').join(' ')).toMatch(/busy, so b took this request/);
    release();
    await h.idle();
  });

  it('queues the message when nobody else is free, and runs it after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = setup([acc('a', 'codex', 'master')], async (req, n) => {
      if (n === 1) await gate;
      return ok(`r${n}`, 's');
    });
    const t = h.engine.send(undefined, 'first', h.cwd);
    await h.idle(() => t.status === 'working');
    h.engine.send(t.id, 'second', h.cwd);
    expect(t.queue).toEqual(['second']);
    release();
    await h.idle(() => msgs(t, 'agent').length === 2);
    expect(h.runs[1].prompt).toBe('second');
    expect(h.runs[1].resume).toBe('s');
  });

  it('a lead spins off a helper by writing a hand-off file; a free agent does it and reports back', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'claude')], async (req) => {
      if (req.account.id === 'a') {
        fs.mkdirSync(path.join(req.cwd, '.super-agent', 'handoff'), { recursive: true });
        fs.writeFileSync(path.join(req.cwd, '.super-agent', 'handoff', 'tests.md'), '# Write tests\nFiles: tests/**\nCover the parser.');
        await gate;
        return ok('main work done', 'sa');
      }
      return ok('tests written', 'sb');
    });
    const t = h.engine.send(undefined, 'build parser', h.cwd);
    await h.idle(() => h.engine.threads.some((x) => x.helperFile && x.status === 'idle' && msgs(x, 'agent').length > 0));
    const helper = h.engine.threads.find((x) => x.helperFile)!;
    expect(helper.title).toBe('Write tests');
    expect(helper.parentId).toBe(t.id);
    expect(helper.leadId).toBe('b');
    expect(h.runs.find((r) => r.account.id === 'b')!.prompt).toContain('helping hand');
    expect(fs.readFileSync(path.join(h.cwd, '.super-agent', 'handoff', 'tests.result.md'), 'utf8')).toContain('tests written');
    expect(msgs(t, 'system').join(' ')).toMatch(/Helper b finished "Write tests"/);
    release();
    await h.idle();
    h.engine.dispose();
  });

  it('switching the lead carries the context to the new agent', async () => {
    const h = setup([acc('a', 'codex', 'master'), acc('c', 'claude')], async (req, n) => ok(`r${n}`, `s${n}`));
    const t = h.engine.send(undefined, 'design the schema', h.cwd);
    await h.idle();
    h.engine.setLead(t.id, 'c');
    h.engine.send(t.id, 'continue with migrations', h.cwd);
    await h.idle();
    expect(h.runs[1].account.id).toBe('c');
    expect(h.runs[1].prompt).toContain('Context hand-over');
    expect(h.runs[1].prompt).toContain('design the schema');
  });

  it('moving the crown mid-thread makes the new lead answer the next message, with the context', async () => {
    const accounts = [acc('a', 'codex', 'master'), acc('c', 'claude')];
    const h = setup(accounts, async (req, n) => ok(`r${n}`, `s${n}`));
    const t = h.engine.send(undefined, 'design the schema', h.cwd);
    await h.idle();
    accounts[0].role = 'worker';
    accounts[1].role = 'master';
    h.engine.send(t.id, 'continue with migrations', h.cwd);
    await h.idle();
    expect(h.runs.map((r) => r.account.id)).toEqual(['a', 'c']);
    expect(h.runs[1].prompt).toContain('design the schema');
    expect(t.leadId).toBe('c');
  });
});
