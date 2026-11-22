// Regression coverage for deletion while asynchronous work still holds the thread.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountPool } from '../src/core/agents/pool';
import { Engine } from '../src/engine/engine';
import { projectDir } from '../src/core/store/paths';

const acc = (id: string, role = 'worker') => ({ id, kind: 'codex', label: id, home: null, role, createdAt: 0 });
const ok = (text: string) => ({ code: 0, finalText: text, sessionId: 's', rateLimited: false, cancelled: false, timedOut: false });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(accounts: any[], agent: (req: any, n: number) => Promise<any>, deps: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-del-'));
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd);
  const runs: any[] = [];
  const finished: string[] = [];
  const cancels = new Map<string, () => void>();
  const engine = new Engine({
    config: { accounts, settings: { taskTimeoutMin: 5 } }, pool: new AccountPool(), dataDir: dir, cliPath: () => 'fake',
    runAgent: async (req: any) => {
      runs.push(req);
      const c = new Promise((resolve) => cancels.set(req.runId, () => resolve({ code: null, finalText: '', sessionId: 's', rateLimited: false, cancelled: true, timedOut: false })));
      return Promise.race([agent(req, runs.length), c]);
    },
    // Like the real runner/hot: cancelling a run not registered yet is a no-op.
    cancelRun: (id: string) => cancels.get(id)?.(),
    usageLoad: () => 0, usageResetAt: () => undefined, autonomy: () => 'standard',
    onChange: () => undefined, onOutput: () => undefined, onFinished: (t: any) => finished.push(t.title),
    ...deps,
  });
  return { engine, runs, finished, cwd, dir };
}
const forever = () => new Promise(() => undefined);

describe('deleteThread lifecycle', () => {
  it('A: delete during the pre-run snapshot prevents the agent run', async () => {
    const h = setup([acc('a', 'master')], async () => ok('done'), {
      changes: { snapshot: () => sleep(150).then(() => 'snap'), diff: async () => undefined },
    });
    const t = h.engine.send(undefined, 'go', h.cwd);
    await sleep(10);
    h.engine.deleteThread(t.id);
    await sleep(400);
    expect(h.runs.length).toBe(0);
    expect(h.finished).toEqual([]);
    h.engine.dispose();
  });

  it('B: delete during the 3s transient-retry wait prevents retry', async () => {
    const h = setup([acc('a', 'master')], async (_r, n) => (n === 1 ? { ...ok(''), code: 1, error: 'stream disconnected' } : ok('done')));
    const t = h.engine.send(undefined, 'go', h.cwd);
    await sleep(100);
    h.engine.deleteThread(t.id);
    await sleep(3500);
    expect(h.runs.length).toBe(1);
    expect(h.finished).toEqual([]);
    h.engine.dispose();
  }, 10000);

  it('C: delete during CLI auto-update prevents rerunning the turn', async () => {
    const h = setup([acc('a', 'master')], async (_r, n) => (n === 1 ? { ...ok(''), code: 1, error: 'this version is too old' } : ok('done')), {
      updateCli: () => sleep(200).then(() => ({ ok: true })),
    });
    const t = h.engine.send(undefined, 'go', h.cwd);
    await sleep(50);
    h.engine.deleteThread(t.id);
    await sleep(500);
    expect(h.runs.length).toBe(1);
    expect(h.finished).toEqual([]);
    h.engine.dispose();
  });

  it('D: a hand-off written by a just-deleted lead is not attached to another working thread', async () => {
    const h = setup([acc('a', 'master'), acc('b'), acc('c')], () => forever());
    const x = h.engine.send(undefined, 'other work', h.cwd);
    const l = h.engine.send(undefined, 'lead work', h.cwd);
    await sleep(100);
    const folder = path.join(projectDir(h.cwd, h.dir), 'handoff', l.id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'task.md'), '# Side task\ndo it');
    h.engine.deleteThread(l.id); // before the 400ms debounced scan
    await sleep(1000);
    const helper = h.engine.threads.find((t: any) => t.helperFile);
    expect(helper).toBeUndefined();
    expect(h.engine.get(x.id)).toBeDefined();
    h.engine.dispose();
  });

  it('E: deleting a parent mid-run does not start orphan runs (sanity)', async () => {
    const h = setup([acc('a', 'master')], () => forever());
    const t = h.engine.send(undefined, 'go', h.cwd);
    await sleep(50);
    h.engine.deleteThread(t.id);
    await sleep(200);
    expect(h.runs.length).toBe(1);
    h.engine.dispose();
  });
});
