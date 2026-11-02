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
    expect(h.runs[0].prompt).toContain('To give a teammate a task, write a Markdown file'); // knows how to spin off helpers
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
  it('a lead spins off a helper by writing a hand-off file; a free agent does it and reports back', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'claude')], async (req) => {
      if (req.prompt.includes('Helper report')) return ok('tests integrated', 'sa');
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
    expect(h.runs.find((r) => r.account.id === 'b')!.prompt).toContain('a hand-off from');
    expect(fs.readFileSync(path.join(h.cwd, '.super-agent', 'handoff', 'tests.result.md'), 'utf8')).toContain('tests written');
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
      const dir = /`(\.super-agent\/handoff\/[^`/]+)\/?`/.exec(req.prompt)![1];
      const handOff = (name: string, body: string) => {
        fs.mkdirSync(path.join(req.cwd, dir), { recursive: true });
        fs.writeFileSync(path.join(req.cwd, dir, name), body);
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
    expect(h.runs[0].prompt).toMatch(/Team right now: free: b, c\. Hand-offs: `\.super-agent\/handoff\/[^`]+\/` · live status: `\.super-agent\/team\.md`/);
  });

  it('keeps a live team status every agent can read: who is free or busy, and each hand-off', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = setup([acc('a', 'codex', 'master'), acc('b', 'claude'), acc('c', 'claude')], async (req) => {
      if (req.prompt.includes('a hand-off from')) return ok('reviewed', 'sb');
      const dir = /`(\.super-agent\/handoff\/[^`/]+)\//.exec(req.prompt)![1];
      fs.mkdirSync(path.join(req.cwd, dir), { recursive: true });
      fs.writeFileSync(path.join(req.cwd, dir, 'p2.md'), '# Review paper 2');
      await gate;
      return ok('done', 'sa');
    });
    const t = h.engine.send(undefined, 'review papers', h.cwd);
    await h.idle(() => h.engine.threads.some((x) => x.helperFile && x.status === 'idle' && x.messages.some((m) => m.role === 'agent')));
    const status = h.engine.teamStatus(h.cwd);
    expect(status).toContain(`- a: busy on "${t.title}"`);
    expect(status).toMatch(/- \[done: b\] Review paper 2 \(for "review papers"\): \.super-agent\/handoff\/[^/]+\/p2\.md → .*p2\.result\.md/);
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
      const dir = /`(\.super-agent\/handoff\/[^`/]+)\//.exec(req.prompt)![1];
      fs.mkdirSync(path.join(req.cwd, dir), { recursive: true });
      fs.writeFileSync(path.join(req.cwd, dir, 'p2.md'), '# Review paper 2');
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
      const dir = /`(\.super-agent\/handoff\/[^`/]+)\/?`/.exec(req.prompt)![1];
      fs.mkdirSync(path.join(req.cwd, dir), { recursive: true });
      fs.writeFileSync(path.join(req.cwd, dir, 'paper-b.md'), '# Review paper B');
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
      const dir = /`(\.super-agent\/handoff\/[^`/]+)\/?`/.exec(req.prompt)![1];
      fs.mkdirSync(path.join(req.cwd, dir), { recursive: true });
      for (let i = 2; i <= 7; i++) fs.writeFileSync(path.join(req.cwd, dir, `p${i}.md`), `# Review paper ${i}`);
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
