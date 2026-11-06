import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountPool } from '../src/core/agents/pool';
import type { RunRequest, RunResult } from '../src/core/agents/runner';
import type { Account } from '../src/core/types';
import { ChangeTracker } from '../src/engine/changes';
import { Engine, type EngineDeps } from '../src/engine/engine';
import { projectDir } from '../src/core/store/paths';
import type { Thread } from '../src/engine/types';

const acc = (id: string, kind: Account['kind'] = 'codex', role: Account['role'] = 'worker'): Account => ({ id, kind, label: id, home: null, role, createdAt: 0 });
const ok = (text: string, sessionId: string): RunResult => ({ code: 0, finalText: text, sessionId, rateLimited: false, cancelled: false, timedOut: false });

function setup(accounts: Account[], agent: (req: RunRequest, n: number) => Promise<RunResult>, deps: Partial<EngineDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ext-'));
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd);
  const pool = new AccountPool();
  const runs: RunRequest[] = [];
  const finished: string[] = [];
  const cancels = new Map<string, () => void>();
  const engine = new Engine({
    config: { accounts, settings: { taskTimeoutMin: 5 } } as never,
    pool,
    dataDir: dir,
    cliPath: () => 'fake',
    // Like the real runner: a cancelled run ends right away as cancelled, keeping its session.
    runAgent: async (req) => {
      runs.push(req);
      const cancelled = new Promise<RunResult>((resolve) =>
        cancels.set(req.runId, () => resolve({ code: null, finalText: '', sessionId: req.resume ?? `s-${req.account.id}`, rateLimited: false, cancelled: true, timedOut: false })),
      );
      return Promise.race([agent(req, runs.length), cancelled]);
    },
    cancelRun: (id) => cancels.get(id)?.(),
    usageLoad: () => 0,
    usageResetAt: () => undefined,
    autonomy: () => 'standard',
    onChange: () => undefined,
    onOutput: () => undefined,
    onFinished: (t) => finished.push(t.title),
    ...deps,
  });
  const idle = async (pred: () => boolean = () => engine.threads.every((t) => t.status === 'idle')) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
  };
  // Super Agent's files for the project (hand-offs, team status) live outside it, in its data folder.
  const work = projectDir(cwd, dir);
  return { engine, runs, finished, cwd, pool, idle, work };
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
    expect(h.runs[0].prompt).toContain('To give a teammate a task, write a Markdown file'); // knows how to spin off helpers
    expect(h.runs[1].resume).toBe('sess-1'); // exact context: same CLI session
    expect(msgs(t, 'agent')).toEqual(['answer 1', 'answer 2']);
    expect(h.finished).toHaveLength(2); // chime + notification each time
  });
});

describe('changes each turn made', () => {
  it('puts the files a turn changed (+/-) on its answer, and only when something changed', async () => {
    const h = setup(
      [acc('a', 'codex', 'master')],
      async (req, n) => {
        if (n === 1) fs.writeFileSync(path.join(req.cwd, 'out.py'), 'print(1)\nprint(2)\n');
        return ok(`answer ${n}`, 's');
      },
      { changes: new ChangeTracker(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-snap-'))) },
    );
    fs.writeFileSync(path.join(h.cwd, 'keep.txt'), 'already here\n');
    const t = h.engine.send(undefined, 'write out.py', h.cwd);
    await h.idle(() => !!t.messages.at(-1)?.changes);
    expect(t.messages.at(-1)).toMatchObject({ role: 'agent', text: 'answer 1', changes: { files: [{ path: 'out.py', add: 2, del: 0 }] } });
    h.engine.send(t.id, 'just answer', h.cwd);
    await h.idle(() => msgs(t, 'agent').length === 2);
    await new Promise((r) => setTimeout(r, 1500)); // the diff runs after the answer is in
    expect(t.messages.at(-1)?.changes).toBeUndefined();
  }, 30000);
});

describe('out-of-date CLI', () => {
  it('shows the error, updates the CLI, and runs the turn again on the same agent', async () => {
    const updates: string[] = [];
    const tooOld = "Claude Code 1.0 does not support this model; version 2.0 or newer is required. Run 'claude update'";
    const h = setup(
      [acc('c', 'claude', 'master'), acc('x', 'codex')],
      async (req, n) => (n === 1 ? { code: 1, finalText: '', error: tooOld, rateLimited: false, cancelled: false, timedOut: false } : ok('fixed', 's')),
      { updateCli: async (k) => (updates.push(k), { ok: true, from: '1.0', to: '2.0' }) },
    );
    const t = h.engine.send(undefined, 'do it', h.cwd);
    await h.idle(() => msgs(t, 'agent').length > 0);
    expect(updates).toEqual(['claude']);
    expect(h.runs.map((r) => r.account.id)).toEqual(['c', 'c']);
    expect(msgs(t, 'system').join(' | ')).toContain(`c failed: ${tooOld}`);
    expect(msgs(t, 'system').join(' | ')).toContain('Claude Code updated (1.0 → 2.0). Trying again.');
    expect(msgs(t, 'agent')).toEqual(['fixed']);
  });

  it('when the update fails, says how to fix it and hands the turn to another kind of agent', async () => {
    const h = setup(
      [acc('c', 'claude', 'master'), acc('x', 'codex')],
      async (req) => (req.account.id === 'c' ? { code: 1, finalText: '', error: 'Upgrade required', rateLimited: false, cancelled: false, timedOut: false } : ok('done by codex', 's')),
      { updateCli: async () => ({ ok: false, error: 'access denied' }) },
    );
    const t = h.engine.send(undefined, 'do it', h.cwd);
    await h.idle(() => msgs(t, 'agent').length > 0);
    expect(msgs(t, 'system').join(' | ')).toContain("Couldn't update Claude Code: access denied. Run `claude update` in a terminal. x takes over meanwhile.");
    expect(msgs(t, 'agent')).toEqual(['done by codex']);
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
    expect(msgs(t, 'system').join(' ')).toContain('a is out of usage: c takes over as the lead, with the full context.');
    expect(h.pool.get('a').cooldownUntil).toBeGreaterThan(Date.now());
    expect(t.session).toEqual({ accountId: 'c', kind: 'claude', id: 'sc' });
  });
});

describe('harmonic delegation', () => {
  it('a lead spins off a helper by writing a hand-off file; a free agent does it and reports back', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'claude')], async (req) => {
      if (req.prompt.includes('Helper report')) return ok('tests integrated', 'sa');
      if (req.account.id === 'a') {
        fs.mkdirSync(path.join(h.work, 'handoff'), { recursive: true });
        fs.writeFileSync(path.join(h.work, 'handoff', 'tests.md'), '# Write tests\nFiles: tests/**\nCover the parser.');
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
    expect(h.runs.find((r) => r.account.id === 'b')!.prompt).toContain('a hand-off from');
    expect(fs.readFileSync(path.join(h.work, 'handoff', 'tests.result.md'), 'utf8')).toContain('tests written');
    // Leading comes first: the lead (whose CLI can't take messages mid-turn) stops and resumes with the report at once.
    await h.idle(() => msgs(t, 'agent').length > 0);
    const report = h.runs.find((r) => r.prompt.includes('Helper report'))!;
    expect(report.account.id).toBe('a');
    expect(report.prompt).toMatch(/### Write tests \(by b; saved in .*tests\.result\.md\)\ntests written/);
    expect(msgs(t, 'agent')).toEqual(['tests integrated']);
    expect(msgs(t, 'system')).toEqual([]); // the work graph shows helpers; no status lines in the conversation
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

describe('coordination with minimal friction', () => {
  it('a helper can bring in its own helper, and each report goes back to the thread that asked', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'claude'), acc('c', 'codex')], async (req) => {
      if (req.prompt.includes('Helper report')) return ok('integrated', 'x');
      // Each agent finds its own hand-off folder in its instructions (follow-ups resume the session, so they have none).
      const dir = /`([^`]*\/handoff\/[^`/]+)\/?`/.exec(req.prompt)![1];
      const handOff = (name: string, body: string) => {
        fs.mkdirSync(path.join(dir), { recursive: true });
        fs.writeFileSync(path.join(dir, name), body);
      };
      if (req.prompt.includes('# Test the API')) return ok('tests written', 'sc');
      if (req.prompt.includes('# Build the API')) {
        handOff('tests.md', '# Test the API\nFiles: tests/**');
        await sleep(900);
        return ok('api built', 'sb');
      }
      handOff('api.md', '# Build the API\nFiles: api/**');
      await sleep(1500);
      return ok('lead part done', 'sa');
    });
    const t = h.engine.send(undefined, 'build the service', h.cwd);
    await h.idle(() => h.runs.length >= 5 && h.engine.threads.every((x) => x.status === 'idle' && x.queue.length === 0));
    const api = h.engine.threads.find((x) => x.title === 'Build the API')!;
    const tests = h.engine.threads.find((x) => x.title === 'Test the API')!;
    expect(h.engine.threads).toHaveLength(3);
    expect(api.parentId).toBe(t.id);
    expect(tests.parentId).toBe(api.id); // nested: the helper's helper
    expect([api.leadId, tests.leadId]).toEqual(['b', 'c']); // each on a free agent, in parallel with the busy ones
    // Each parent got its helper's report right away, without the user doing anything:
    // the API helper first folds in its tests helper, and only its final (integrated) answer reaches the lead.
    const reports = h.runs.filter((r) => r.prompt.includes('Helper report')).map((r) => r.prompt);
    expect(reports.some((p) => /### Test the API \(by c; saved in [^)]+\)\ntests written/.test(p))).toBe(true);
    expect(reports.some((p) => /### Build the API \(by b; saved in [^)]+\)\nintegrated/.test(p))).toBe(true);
    expect(msgs(t, 'agent')).toEqual(['integrated']); // one final answer for the user
    h.engine.dispose();
  });

  it('a run that ends with no answer is retried once on another free agent', async () => {
    const h = setup([acc('a', 'antigravity', 'master'), acc('b', 'claude')], async (req) =>
      req.account.id === 'a' ? { ...ok('', ''), finalText: '' } : ok('done by b', 'sb'),
    );
    const t = h.engine.send(undefined, 'review the paper', h.cwd);
    await h.idle(() => msgs(t, 'agent').length > 0);
    expect(h.runs.map((r) => r.account.id)).toEqual(['a', 'b']);
    expect(msgs(t, 'system').join(' ')).toMatch(/a stopped without an answer \(exit code 0\), so b takes over/);
    expect(msgs(t, 'agent')).toEqual(['done by b']);
    expect(t.retried).toBeUndefined();
  });
});

describe('the whole team, and one final answer', () => {
  it('tells the lead which teammates are free so it spreads independent items', async () => {
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'claude'), acc('c', 'antigravity')], async () => ok('done', 's'));
    h.engine.send(undefined, 'review all candidate papers', h.cwd);
    await h.idle();
    expect(h.runs[0].prompt).toMatch(/Team right now: free: b, c\. Hand-offs: `[^`]*\/handoff\/[^`]+\/` · live status: `[^`]*\/team\.md`/);
  });

  it('keeps a live team status every agent can read: who is free or busy, and each hand-off', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'claude'), acc('c', 'claude')], async (req) => {
      if (req.prompt.includes('a hand-off from')) return ok('reviewed', 'sb');
      const dir = /`([^`]*\/handoff\/[^`/]+)\//.exec(req.prompt)![1];
      fs.mkdirSync(path.join(dir), { recursive: true });
      fs.writeFileSync(path.join(dir, 'p2.md'), '# Review paper 2');
      await gate;
      return ok('done', 'sa');
    });
    const t = h.engine.send(undefined, 'review papers', h.cwd);
    await h.idle(() => h.engine.threads.some((x) => x.helperFile && x.status === 'idle' && x.messages.some((m) => m.role === 'agent')));
    const status = h.engine.teamStatus(h.cwd);
    expect(status).toContain(`- a: busy on "${t.title}"`);
    expect(status).toMatch(/- \[done: b\] Review paper 2 \(for "review papers"\): .*\/handoff\/[^/]+\/p2\.md → .*p2\.result\.md/);
    expect(status).toContain('- c: free');
    release();
    await h.idle();
    h.engine.dispose();
  });

  it('a Codex parent hears about a finished helper inside its running turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const steered: string[] = [];
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'claude')], async (req) => {
      if (req.prompt.includes('a hand-off from')) return ok('paper 2: included', 'sb');
      const dir = /`([^`]*\/handoff\/[^`/]+)\//.exec(req.prompt)![1];
      fs.mkdirSync(path.join(dir), { recursive: true });
      fs.writeFileSync(path.join(dir, 'p2.md'), '# Review paper 2');
      await gate;
      return ok('all done, paper 2 included', 'sa');
    });
    (h.engine as any).d.steer = async (_id: string, text: string) => (steered.push(text), true);
    const t = h.engine.send(undefined, 'review papers', h.cwd);
    await h.idle(() => steered.length > 0);
    expect(steered[0]).toMatch(/^Helper report:\n\n### Review paper 2 \(by b; saved in .*p2\.result\.md\)\npaper 2: included\n\nFree now: .*Leading comes first/s);
    release();
    await h.idle(() => msgs(t, 'agent').length > 0);
    // Already delivered in-turn: no extra turn, the lead's own answer is final.
    expect(h.runs.filter((r) => r.prompt.includes('Helper report'))).toHaveLength(0);
    expect(msgs(t, 'agent')).toEqual(['all done, paper 2 included']);
    h.engine.dispose();
  });

  it('holds the lead\'s answer until its helpers finish, then answers once with their work folded in', async () => {
    let release!: () => void;
    const helperGate = new Promise<void>((r) => (release = r));
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'claude')], async (req) => {
      if (req.prompt.includes('Helper report')) return ok('final: 2 papers reviewed', 'sa');
      if (req.prompt.includes('a hand-off from')) {
        await helperGate;
        return ok('paper B reviewed', 'sb');
      }
      const dir = /`([^`]*\/handoff\/[^`/]+)\/?`/.exec(req.prompt)![1];
      fs.mkdirSync(path.join(dir), { recursive: true });
      fs.writeFileSync(path.join(dir, 'paper-b.md'), '# Review paper B');
      await new Promise((r) => setTimeout(r, 600)); // the helper is picked up while the lead works
      return ok('paper A reviewed', 'sa');
    });
    const t = h.engine.send(undefined, 'review papers A and B', h.cwd);
    await h.idle(() => !!t.awaitingHelpers);
    expect(t.status).toBe('waiting');
    expect(msgs(t, 'agent')).toEqual([]); // no premature final answer
    expect(h.finished).toEqual([]);
    release();
    await h.idle(() => msgs(t, 'agent').length > 0);
    expect(msgs(t, 'agent')).toEqual(['final: 2 papers reviewed']);
    expect(h.runs.at(-1)!.prompt).toContain('paper B reviewed');
    expect(t.status).toBe('idle');
    // What the lead said before the end isn't lost: it's in the turn's activity ("Worked for …") above the answer.
    const final = t.messages.find((m) => m.role === 'agent')!;
    expect(final.activity).toContain('💬 paper A reviewed');
    expect(final.workedMs).toBeGreaterThan(0);
    h.engine.dispose();
  });
});

describe('work is spread over the whole team', () => {
  it('rotates helpers so an account with higher (but fine) usage is not starved', async () => {
    const accounts = [acc('lead', 'codex', 'master'), acc('cx2', 'codex'), acc('cl1', 'claude'), acc('ag', 'antigravity')];
    const h = setup(accounts, async () => ok('done', 's'));
    (h.engine as any).d.usageLoad = (id: string) => ({ cx2: 30, cl1: 5, ag: 0 })[id] ?? 0; // cx2 used to always come last
    h.engine.send(undefined, 'a task', h.cwd); // the crowned lead does it, so it was just given work
    await h.idle();
    const free = (h.engine as any).free().map((a: Account) => a.id);
    expect(free).toContain('cx2');
    expect(free.indexOf('cx2')).toBeLessThan(free.indexOf('lead')); // never given work beats just used
  });

  it('agents near their limit go last', () => {
    const h = setup([acc('a'), acc('b'), acc('c')], async () => ok('x', 's'));
    (h.engine as any).d.usageLoad = (id: string) => (id === 'a' ? 95 : 10);
    expect((h.engine as any).free().map((a: Account) => a.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('batches flow through one queue', () => {
  it('the lead queues every item, agents (the lead included) pull the next one as they free up, one final answer', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const started: { who: string; what: string; at: number }[] = [];
    const h = setup([acc('lead', 'codex', 'master'), acc('b', 'claude'), acc('c', 'antigravity')], async (req) => {
      if (req.prompt.includes('Helper report')) return ok('final: 7 papers reviewed', 'sl');
      const item = /# (Review paper \d+)/.exec(req.prompt)?.[1];
      if (item && req.prompt.includes('a hand-off from')) {
        started.push({ who: req.account.id, what: item, at: Date.now() });
        await sleep(400);
        return ok(`${item}: done`, `s-${item}`);
      }
      // The lead: queue papers 2..7 first, then review paper 1 itself (quickly, so items are still queued after).
      const dir = /`([^`]*\/handoff\/[^`/]+)\/?`/.exec(req.prompt)![1];
      fs.mkdirSync(path.join(dir), { recursive: true });
      for (let i = 2; i <= 7; i++) fs.writeFileSync(path.join(dir, `p${i}.md`), `# Review paper ${i}`);
      await sleep(600);
      return ok('paper 1 reviewed', 'sl');
    });
    const t = h.engine.send(undefined, 'review papers 1-7', h.cwd);
    await h.idle(() => msgs(t, 'agent').length > 0);
    expect(started.map((s) => s.what).sort()).toEqual([2, 3, 4, 5, 6, 7].map((i) => `Review paper ${i}`).sort());
    // Each agent pulls the next item the moment it is free, the lead included once it's free.
    for (const who of ['b', 'c', 'lead']) expect(started.some((s) => s.who === who)).toBe(true);
    // Queued in order: items start oldest first.
    expect(started.map((s) => s.what)).toEqual([2, 3, 4, 5, 6, 7].map((i) => `Review paper ${i}`));
    // Every report reached the lead as it landed (no rounds), and only the answer after the last one is final.
    const delivered = h.runs.filter((r) => r.prompt.includes('Helper report')).map((r) => r.prompt).join('\n');
    for (let i = 2; i <= 7; i++) expect(delivered).toContain(`Review paper ${i}: done`);
    expect(msgs(t, 'agent')).toEqual(['final: 7 papers reviewed']);
    h.engine.dispose();
  });
});

describe('messages while the agent works', () => {
  const slowAgent = (runs: { prompt: string }[]) => async (req: RunRequest) => {
    runs.push(req);
    if (runs.length === 1) {
      await new Promise((r) => setTimeout(r, 400));
      return { ...ok('first done', 's1'), cancelled: cancelled.has(req.runId) };
    }
    return ok('second done', 's1');
  };
  const cancelled = new Set<string>();

  it('queue: runs as the next turn of the same thread, with the same agent', async () => {
    const seen: { prompt: string }[] = [];
    const h = setup([acc('a', 'codex', 'master'), acc('b')], slowAgent(seen));
    const t = h.engine.send(undefined, 'big task', h.cwd);
    await h.idle(() => t.status === 'working');
    expect(h.engine.send(t.id, 'also fix the typo', h.cwd, [], 'queue')).toBe(t); // same thread, not a new one
    await h.idle(() => msgs(t, 'agent').length === 2);
    expect(h.runs.map((r) => r.account.id)).toEqual(['a', 'a']);
    expect(h.runs[1].prompt).toContain('also fix the typo');
    expect(h.runs[1].resume).toBe('s1');
  });

  it('send now: added to the running turn when the CLI can take it', async () => {
    const steered: string[] = [];
    const h = setup([acc('a', 'codex', 'master')], async () => {
      await new Promise((r) => setTimeout(r, 300));
      return ok('done with both', 's1');
    });
    (h.engine as any).d.steer = async (_id: string, text: string) => (steered.push(text), true);
    const t = h.engine.send(undefined, 'big task', h.cwd);
    await h.idle(() => t.status === 'working');
    h.engine.send(t.id, 'use tabs, not spaces', h.cwd);
    await h.idle();
    expect(steered).toEqual(['use tabs, not spaces']);
    expect(h.runs).toHaveLength(1); // no restart
    expect(msgs(t, 'system').join(' ')).toMatch(/Sent to a while it works/);
  });

  it('send now: otherwise the agent stops and resumes the same session with the message (no "Stopped")', async () => {
    const h = setup([acc('a', 'claude', 'master')], async (req) => {
      if (h.runs.length === 1) {
        await new Promise((r) => setTimeout(r, 2000));
        return { ...ok('', 's1'), finalText: '', cancelled: true };
      }
      return ok('handled the new message', 's1');
    });
    (h.engine as any).d.cancelRun = () => undefined; // the fake run ends itself as cancelled
    const t = h.engine.send(undefined, 'big task', h.cwd);
    await h.idle(() => t.status === 'working');
    h.engine.send(t.id, 'actually, target Python 3.12', h.cwd);
    await h.idle(() => msgs(t, 'agent').length > 0);
    expect(h.runs).toHaveLength(2);
    expect(h.runs[1].prompt).toContain('interrupted by a new message from the user');
    expect(h.runs[1].prompt).toContain('actually, target Python 3.12');
    expect(h.runs[1].resume).toBe('s1');
    expect(msgs(t, 'system').join(' ')).not.toMatch(/Stopped/);
  });
});

describe('a lone agent', () => {
  it('gets no team instructions when nobody else is on the team', async () => {
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'claude', 'off')], async () => ok('done', 's'));
    h.engine.send(undefined, 'build it', h.cwd);
    await h.idle();
    expect(h.runs[0].prompt).toBe('build it');
  });
});

describe('conversations are kept on disk', () => {
  const deps = (dataDir: string): EngineDeps => ({
    config: { accounts: [acc('a', 'codex', 'master')], settings: { taskTimeoutMin: 5 } } as never,
    pool: new AccountPool(),
    dataDir,
    cliPath: () => 'fake',
    runAgent: async () => ok('the answer', 's1'),
    cancelRun: () => undefined,
    usageLoad: () => 0,
    usageResetAt: () => undefined,
    autonomy: () => 'standard',
    onChange: () => undefined,
    onOutput: () => undefined,
    onFinished: () => undefined,
  });
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it('every thread comes back after a restart, even changes made just before it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-keep-'));
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(cwd);
    const e1 = new Engine(deps(dir));
    const t = e1.send(undefined, 'remember me', cwd);
    await until(() => msgs(t, 'agent').length > 0);
    for (let i = 0; i < 250; i++) e1.newThread(cwd); // more than the old 200-thread cap
    e1.dispose(); // VS Code reloads before the delayed save runs
    const e2 = new Engine(deps(dir));
    expect(e2.threads).toHaveLength(251);
    expect(e2.get(t.id)?.messages.map((m) => m.text)).toEqual(['remember me', 'the answer']);
  });

  it('starts with a thread that was mid-run when VS Code closed, without calling back into the host', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-keep-'));
    const saved = [{ id: 't1', title: 'busy one', cwd: dir, status: 'working', queue: [], messages: [{ at: 1, role: 'user', text: 'go' }], createdAt: 1, updatedAt: 1 }];
    fs.writeFileSync(path.join(dir, 'vscode-threads.json'), JSON.stringify(saved));
    // Like the extension: its change handler can't run until the engine exists.
    const e = new Engine({ ...deps(dir), onChange: () => { throw new ReferenceError("Cannot access 'eng' before initialization"); } });
    expect(e.get('t1')?.status).toBe('idle');
    expect(e.get('t1')?.messages.map((m) => m.text)).toEqual(['go', 'Interrupted (VS Code was closed). Send "continue" to pick up from where it stopped.']);
  });

  it("deleting a conversation also deletes its helpers' threads (and theirs)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-keep-'));
    const e = new Engine(deps(dir));
    const lead = e.newThread(dir);
    const other = e.newThread(dir);
    const mk = (id: string, parentId: string) => ({ id, title: id, cwd: dir, status: 'idle' as const, queue: [], messages: [], parentId, helperFile: 'h.md', createdAt: 1, updatedAt: 1 });
    e.threads.push(mk('h1', lead.id), mk('h2', 'h1'), mk('x1', other.id));
    e.deleteThread(lead.id);
    expect(e.threads.map((t) => t.id).sort()).toEqual([other.id, 'x1'].sort());
  });

  it('"last used" is the last message from you or an agent, not a status note', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-keep-'));
    const msgs = [{ at: 100, role: 'user', text: 'go' }, { at: 200, role: 'agent', text: 'done' }, { at: 900, role: 'system', text: 'Stopped.' }];
    fs.writeFileSync(path.join(dir, 'vscode-threads.json'), JSON.stringify([{ id: 't1', title: 'x', cwd: dir, status: 'working', queue: [], messages: msgs, createdAt: 50, updatedAt: 900 }]));
    const e = new Engine(deps(dir));
    expect(e.get('t1')?.updatedAt).toBe(200); // neither the old note nor the new "Interrupted" one counts
  });

  it('work cut off by a reload keeps its steps ("Worked for …"), and "continue" carries on from them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-keep-'));
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(cwd);
    // First session: the agent is mid-way when VS Code reloads (its run never finishes here).
    const e1 = new Engine({
      ...deps(dir),
      runAgent: (req) => {
        req.onText("I'll split the parser.\n\n→ Edit src/parser.py\n\n→ Bash pytest -q\n");
        return new Promise(() => undefined);
      },
    });
    const t = e1.send(undefined, 'refactor the parser', cwd);
    await until(() => (t.work?.items.length ?? 0) > 0 || !!e1.liveActivity(t.id).length);
    await new Promise((r) => setTimeout(r, 50));
    e1.dispose(); // reload: the work so far is saved

    // After the reload: the cut-off turn shows what it did, with how long it worked.
    const runs: RunRequest[] = [];
    const e2 = new Engine({ ...deps(dir), config: { accounts: [acc('a', 'codex', 'master'), acc('c', 'claude')], settings: { taskTimeoutMin: 5 } } as never, runAgent: async (req) => (runs.push(req), ok('finished', 's2')) });
    const cut = e2.get(t.id)!.messages.at(-1)!;
    expect(cut.text).toMatch(/^Interrupted/);
    expect(cut.activity).toEqual(["💬 I'll split the parser.\n", '🔧 Edit src/parser.py', '🔧 Bash pytest -q']);
    expect(cut.workedMs).toBeGreaterThanOrEqual(0);

    // "continue" on another agent: it is told exactly where things stood.
    e2.setLead(t.id, 'c');
    e2.send(t.id, 'continue', cwd);
    await until(() => runs.length > 0);
    expect(runs[0].account.id).toBe('c');
    expect(runs[0].prompt).toContain("- I'll split the parser.\n- Edit src/parser.py\n- Bash pytest -q");
    expect(runs[0].prompt).toContain('continue');
  });

  it('an unreadable file is set aside (never overwritten) and the backup is used', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-keep-'));
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(cwd);
    const e1 = new Engine(deps(dir));
    const t = e1.send(undefined, 'precious', cwd);
    await until(() => msgs(t, 'agent').length > 0);
    e1.dispose();
    new Engine(deps(dir)).dispose(); // next session start: backs up the good file
    fs.writeFileSync(path.join(dir, 'vscode-threads.json'), '[{"id": "broken'); // crash mid-write
    const e3 = new Engine(deps(dir));
    expect(e3.get(t.id)?.messages[0].text).toBe('precious');
    expect(fs.readdirSync(dir).some((f) => f.startsWith('vscode-threads.json.corrupt-'))).toBe(true);
  });
});

describe('out of usage with nobody else on the team', () => {
  const outOfUsage = (req: RunRequest): RunResult => {
    req.onText("I'll move the helpers into src/.\n\n→ Edit src/app.py\n\n→ Bash pytest -q\n");
    return { code: 1, finalText: '', sessionId: 'sc', rateLimited: true, cancelled: false, timedOut: false };
  };

  it('the added account with the most usage left takes over (off the team), with a clean hand-over', async () => {
    const load: Record<string, number> = { c: 0, x1: 70, x2: 20 };
    const h = setup(
      [acc('c', 'claude', 'master'), acc('x1', 'codex', 'off'), acc('x2', 'codex', 'off')],
      async (req) => (req.account.id === 'c' ? outOfUsage(req) : ok('finished it', 'sx')),
      { usageLoad: (id) => load[id] ?? 0 },
    );
    const t = h.engine.send(undefined, 'reorganize the repo', h.cwd);
    await h.idle(() => msgs(t, 'agent').length > 0);
    expect(h.runs.map((r) => r.account.id)).toEqual(['c', 'x2']); // most usage left
    expect(msgs(t, 'system').join(' ')).toContain('c is out of usage: x2 takes over as the lead, with the full context.');
    expect(h.engine['d'].config.accounts.map((a: Account) => [a.id, a.role])).toEqual([['c', 'worker'], ['x1', 'off'], ['x2', 'master']]); // the crown moved
    const brief = h.runs[1].prompt;
    expect(brief).toContain('reorganize the repo');
    expect(brief).toContain('The previous agent stopped in the middle of this request');
    expect(brief).toMatch(/- I'll move the helpers into src\/\.\n- Edit src\/app\.py\n- Bash pytest -q/);
    expect(msgs(t, 'agent')).toEqual(['finished it']);
    // The next message stays with the stand-in while the team is still out.
    h.engine.send(t.id, 'and update the README', h.cwd);
    await h.idle(() => msgs(t, 'agent').length > 1);
    expect(h.runs[2].account.id).toBe('x2');
  });

  it('a message to a thread whose lead is already out says who carries on', async () => {
    const load: Record<string, number> = { c: 0, x: 30 };
    const h = setup([acc('c', 'claude', 'master'), acc('x', 'antigravity', 'off')], async (req) => ok(`done by ${req.account.id}`, 's'), { usageLoad: (id) => load[id] ?? 0 });
    const t = h.engine.send(undefined, 'first', h.cwd);
    await h.idle(() => msgs(t, 'agent').length === 1);
    load.c = 100; // the lead runs out between messages (e.g. found on reload)
    h.engine.send(t.id, 'continue', h.cwd);
    await h.idle(() => msgs(t, 'agent').length === 2);
    expect(msgs(t, 'agent')).toEqual(['done by c', 'done by x']);
    expect(msgs(t, 'system').join(' ')).toContain('c is out of usage: x takes over as the lead, with the full context.');
  });

  it('says so when the next message goes to another team member because the lead is out', async () => {
    const load: Record<string, number> = { c: 0, k: 10 };
    const h = setup([acc('c', 'claude', 'master'), acc('k', 'codex')], async (req) => ok(`done by ${req.account.id}`, 's'), { usageLoad: (id) => load[id] ?? 0 });
    const t = h.engine.send(undefined, 'first', h.cwd);
    await h.idle(() => msgs(t, 'agent').length === 1);
    load.c = 100;
    h.engine.send(t.id, 'continue', h.cwd);
    await h.idle(() => msgs(t, 'agent').length === 2);
    expect(msgs(t, 'agent')).toEqual(['done by c', 'done by k']);
    expect(msgs(t, 'system').filter((m) => m.includes('is out of usage'))).toEqual(['c is out of usage: k takes over as the lead, with the full context.']);
  });

  it('the lead passes once to the agent taking over, which then stays the lead', async () => {
    const load: Record<string, number> = { c: 0, x: 30 };
    const h = setup([acc('c', 'claude', 'master'), acc('x', 'antigravity', 'off')], async (req) => ok(`done by ${req.account.id}`, 's'), { usageLoad: (id) => load[id] ?? 0 });
    const t = h.engine.send(undefined, 'first', h.cwd);
    await h.idle(() => msgs(t, 'agent').length === 1);
    // Another agent was already on it (e.g. it took over before this note existed), with no note in the thread.
    t.leadId = 'x';
    load.c = 100;
    const note = 'c is out of usage: x takes over as the lead, with the full context.';
    h.engine.send(t.id, 'continue', h.cwd);
    await h.idle(() => msgs(t, 'agent').length === 2);
    h.engine.send(t.id, 'and then?', h.cwd);
    await h.idle(() => msgs(t, 'agent').length === 3);
    expect(msgs(t, 'system').filter((m) => m === note)).toHaveLength(1); // said once, not on every message
    load.c = 0; // the old lead has usage again: the new lead keeps leading (the crown moved)
    h.engine.send(t.id, 'next', h.cwd);
    await h.idle(() => msgs(t, 'agent').length === 4);
    expect(msgs(t, 'agent').at(-1)).toBe('done by x');
  });

  it("an off-team account isn't used while the team is merely busy", async () => {
    let release!: () => void;
    const h = setup([acc('c', 'claude', 'master'), acc('x', 'codex', 'off')], (req) =>
      req.prompt.includes('first') ? new Promise((r) => (release = () => r(ok('done 1', 's1')))) : Promise.resolve(ok('done 2', 's2')),
    );
    h.engine.send(undefined, 'first task', h.cwd);
    await h.idle(() => h.runs.length === 1);
    const t2 = h.engine.send(undefined, 'second task', h.cwd);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.runs.map((r) => r.account.id)).toEqual(['c']); // waits for the team
    release();
    await h.idle(() => msgs(t2, 'agent').length > 0);
    expect(h.runs.map((r) => r.account.id)).toEqual(['c', 'c']);
  });
});

describe('every agent out of usage: the work resumes by itself', () => {
  afterEach(() => vi.useRealTimers());
  const limited = (): RunResult => ({ code: 1, finalText: '', sessionId: 'sc', rateLimited: true, cancelled: false, timedOut: false });

  it('waits for the soonest reset, then the agent back first carries on where it stopped', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = Date.now();
    const resets: Record<string, number> = { c: t0 + 3 * 3600000, x: t0 + 2 * 3600000 };
    let spent = false;
    const h = setup(
      [acc('c', 'claude', 'master'), acc('x', 'codex', 'off')],
      async (req) => {
        if (!spent) {
          spent = true;
          req.onText('→ Edit src/app.py\n');
          return limited();
        }
        return ok(`done by ${req.account.id}`, 's2');
      },
      {
        // Out until each one's reset time (x is already out; c runs out on its first turn).
        usageLoad: (id) => (id === 'x' || spent) && Date.now() < resets[id] ? 100 : 0,
        usageResetAt: (id) => resets[id],
      },
    );
    const t = h.engine.send(undefined, 'big refactor', h.cwd);
    await h.idle(() => t.status === 'waiting');
    expect(t.resumeAt).toBe(resets.x);
    expect(msgs(t, 'system').at(-1)).toMatch(/^Every agent is out of usage\. x gets usage back at .+: the task resumes on it automatically then\.$/);
    await vi.advanceTimersByTimeAsync(2 * 3600000 - 60000);
    expect(h.runs).toHaveLength(1); // not before the reset
    await vi.advanceTimersByTimeAsync(2 * 60000);
    await h.idle(() => msgs(t, 'agent').length > 0);
    expect(h.runs.map((r) => r.account.id)).toEqual(['c', 'x']);
    expect(msgs(t, 'system')).toContain('x has usage again: resuming the task where it stopped.');
    expect(h.runs[1].prompt).toContain('Edit src/app.py'); // with what was done so far
    expect(msgs(t, 'agent')).toEqual(['done by x']);
    expect(t.resumeAt).toBeUndefined();
  });

  it('with no reset time known, checks again regularly (asking for fresh usage numbers)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let out = true;
    const refreshed: string[] = [];
    const h = setup([acc('c', 'claude', 'master')], async () => (out ? limited() : ok('finished', 's')), {
      usageLoad: () => (out ? 100 : 0),
      refreshUsage: async (id) => void refreshed.push(id),
    });
    const t = h.engine.send(undefined, 'task', h.cwd);
    await h.idle(() => t.status === 'waiting');
    expect(msgs(t, 'system').at(-1)).toContain('no reset time is known: checking again every 20 minutes');
    await vi.advanceTimersByTimeAsync(21 * 60000);
    expect(refreshed).toContain('c');
    expect(t.status).toBe('waiting'); // still out
    out = false; // the next check finds usage again
    await vi.advanceTimersByTimeAsync(21 * 60000);
    await h.idle(() => msgs(t, 'agent').length > 0);
    expect(msgs(t, 'agent')).toEqual(['finished']);
  });

  it('a usage refresh that shows usage back resumes at once; a reload keeps the work waiting', async () => {
    let load = 100;
    const h = setup([acc('c', 'claude', 'master')], async () => (load >= 100 ? limited() : ok('finished', 's')), { usageLoad: () => load, usageResetAt: () => Date.now() + 3600000 });
    const t = h.engine.send(undefined, 'task', h.cwd);
    await h.idle(() => t.status === 'waiting');
    h.engine.dispose();
    // Next session (VS Code reloaded): the thread is still waiting, and runs once usage is back.
    const runs: string[] = [];
    const e2 = new Engine({ ...h.engine['d'], runAgent: async (req: RunRequest) => (runs.push(req.account.id), ok('finished', 's')) });
    const t2 = e2.get(t.id)!;
    expect(t2.status).toBe('waiting');
    load = 0;
    e2.usageChanged();
    for (let i = 0; i < 100 && !msgs(t2, 'agent').length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(msgs(t2, 'agent')).toEqual(['finished']);
    e2.dispose();
  });
});

describe('an agent asks to step outside its sandbox', () => {
  it('shows the request on the thread, passes your answer back, and the turn carries on', async () => {
    const answers: string[] = [];
    const h = setup([acc('a', 'codex', 'master')], async (req) => {
      answers.push(await req.onApproval!({ kind: 'command', command: 'cp ui ../other', cwd: 'C:\app' }));
      return ok('copied', 's');
    }, { onApproval: (t) => answers.push(`asked on ${t.title}`) });
    const t = h.engine.send(undefined, 'move the ui', h.cwd);
    await h.idle(() => !!t.approval);
    expect(t.approval).toMatchObject({ kind: 'command', command: 'cp ui ../other' });
    h.engine.answerApproval(t.id, t.approval!.id, 'accept');
    await h.idle();
    expect(answers).toEqual(['asked on move the ui', 'accept']);
    expect(t.approval).toBeUndefined();
    expect(msgs(t, 'agent')).toEqual(['copied']);
  });

  it('several requests are shown one at a time; stopping withdraws the rest', async () => {
    const answers: string[] = [];
    const h = setup([acc('a', 'codex', 'master')], async (req) => {
      const both = await Promise.all([req.onApproval!({ kind: 'files', paths: ['x'] }), req.onApproval!({ kind: 'files', paths: ['y'] })]);
      answers.push(...both);
      return new Promise<RunResult>(() => undefined); // keeps working until stopped
    });
    const t = h.engine.send(undefined, 'edit', h.cwd);
    await h.idle(() => !!t.approval);
    expect(t.approval?.paths).toEqual(['x']);
    h.engine.answerApproval(t.id, t.approval!.id, 'decline');
    expect(t.approval?.paths).toEqual(['y']);
    h.engine.stop(t.id);
    await h.idle();
    expect(answers).toEqual(['decline', 'cancel']);
    expect(t.approval).toBeUndefined();
    expect(msgs(t, 'system')).toContain('Stopped.');
  });
});

describe('Antigravity narrates its work', () => {
  it('is asked to say what it is doing as it goes (it works silently otherwise); Claude Code and Codex are not', async () => {
    const h = setup([acc('g', 'antigravity', 'master'), acc('c', 'claude', 'off')], async () => ok('done', 's'));
    h.engine.send(undefined, 'fix the tests', h.cwd);
    await h.idle();
    expect(h.runs[0].prompt).toContain('give a short progress update');
    const h2 = setup([acc('c', 'claude', 'master')], async () => ok('done', 's'));
    h2.engine.send(undefined, 'fix the tests', h2.cwd);
    await h2.idle();
    expect(h2.runs[0].prompt).not.toContain('progress update');
  });
});

describe('a teammate joins mid-turn', () => {
  it('tells the running lead (with how to hand off, since it started alone) and resumes it when its CLI cannot be steered', async () => {
    const b = acc('b', 'codex', 'off');
    let release: () => void = () => undefined;
    const h = setup([acc('a', 'claude', 'master'), b], (req, n) =>
      n === 1 ? new Promise<RunResult>((r) => (release = () => r(ok('never', 's')))) : Promise.resolve(ok(`answer ${n}`, 's')),
    );
    const t = h.engine.send(undefined, 'big batch job', h.cwd);
    await h.idle(() => t.status === 'working');
    expect(h.runs[0].prompt).not.toContain('To give a teammate a task'); // alone: no team instructions
    h.engine.teamChanged(); // first check only records the team
    b.role = 'worker';
    h.engine.teamChanged();
    h.engine.teamChanged(); // no change: nothing more
    await h.idle(() => h.runs.length === 2);
    release();
    await h.idle(() => t.status === 'idle');
    expect(h.runs).toHaveLength(2);
    expect(h.runs[1].prompt).toContain('b just joined your team');
    expect(h.runs[1].prompt).toContain('To give a teammate a task, write a Markdown file');
    expect(msgs(t, 'system')).toContain('b joined the team: a can hand work to it now.');
  });

  it('steers the news into the running turn when its CLI takes messages', async () => {
    const b = acc('b', 'codex', 'off');
    let release: () => void = () => undefined;
    const h = setup([acc('a', 'codex', 'master'), acc('c'), b], (req, n) =>
      n === 1 ? new Promise<RunResult>((r) => (release = () => r(ok('done', 's')))) : Promise.resolve(ok(`answer ${n}`, 's')),
    );
    const steered: string[] = [];
    (h.engine as any).d.steer = async (_id: string, text: string) => (steered.push(text), true);
    const t = h.engine.send(undefined, 'big batch job', h.cwd);
    await h.idle(() => t.status === 'working');
    h.engine.teamChanged();
    b.role = 'worker';
    h.engine.teamChanged();
    await h.idle(() => steered.length > 0);
    expect(steered[0]).toContain('b just joined your team');
    expect(steered[0]).not.toContain('To give a teammate a task'); // it already knows how (c was on the team)
    release();
    await h.idle();
    expect(h.runs).toHaveLength(1); // not interrupted
  });
});

describe('hand-offs with nobody else on the team', () => {
  it("aren't queued for a teammate who never comes: the lead is told to do them itself", async () => {
    let release: () => void = () => undefined;
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'codex', 'off')], (req, n) =>
      n === 1 ? new Promise<RunResult>((r) => (release = () => r(ok('done', 's')))) : Promise.resolve(ok(`answer ${n}`, 's')),
    );
    const steered: string[] = [];
    (h.engine as any).d.steer = async (_id: string, text: string) => (steered.push(text), true);
    const t = h.engine.send(undefined, 'two features', h.cwd);
    await h.idle(() => t.status === 'working');
    t.teamTold = true; // its session remembers teammates from an earlier turn
    const dir = path.join(h.work, 'handoff', t.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'voice.md'), '# Add a Change voice button\nFiles: src/voice.ts');
    await h.idle(() => steered.length > 0);
    expect(h.engine.threads.filter((x) => x.helperFile)).toHaveLength(0); // no "Next free agent" helper
    expect(steered[0]).toContain('nobody took these hand-offs');
    expect(steered[0]).toContain('Add a Change voice button');
    expect(msgs(t, 'system')).toContain('Nobody else is on the team, so a does this itself: Add a Change voice button.');
    release();
    await h.idle();
    h.engine.send(t.id, 'next', h.cwd);
    await h.idle();
    expect(h.runs.at(-1)!.prompt).toContain('You have no teammates right now'); // and every turn says so
  });
});
