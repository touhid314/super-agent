import { EventEmitter } from 'node:events';
import * as cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HotAgents } from '../src/core/agents/hot';
import { cancelRun, runAgent, type ApprovalAnswer, type RunRequest, type RunResult } from '../src/core/agents/runner';
import { AccountPool } from '../src/core/agents/pool';
import type { AgentKind } from '../src/core/types';
import { Engine } from '../src/engine/engine';
import { DEFAULT_SETTINGS } from '../src/core/store/config';

vi.mock('node:child_process', { spy: true });

const kinds: AgentKind[] = ['claude', 'codex', 'antigravity'];
const roots: string[] = [];
const cleanup: (() => void)[] = [];
const testRoot = path.resolve('..', '_operations', 'deliverables', 'super-agent-unlimited-runs-2026-11-25', 'test-runs');
function temp() {
  fs.mkdirSync(testRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(testRoot, 'case-'));
  roots.push(dir);
  return dir;
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

afterEach(async () => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await new Promise<void>(resolve => setImmediate(resolve));
  for (const dir of roots.splice(0)) {
    // Only remove this test's resolved case directories under the operations output folder.
    if (path.dirname(dir) !== testRoot) throw new Error('Unexpected test cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.each(kinds)('normal %s engine work', kind => {
  it('disables the run deadline even when existing settings still contain 30 minutes', async () => {
    expect(DEFAULT_SETTINGS.taskTimeoutMin).toBe(0);
    const dir = temp();
    const requests: RunRequest[] = [];
    const account = { id: kind, kind, label: kind, role: 'master' as const, home: null, createdAt: 0 };
    let complete!: (result: RunResult) => void;
    const engine = new Engine({
      config: { accounts: [account], settings: { taskTimeoutMin: 30 } } as never,
      pool: new AccountPool(), dataDir: dir, cliPath: () => 'fake',
      runAgent: req => { requests.push(req); return new Promise(resolve => { complete = resolve; }); },
      cancelRun: () => undefined, usageLoad: () => 0, usageResetAt: () => undefined,
      autonomy: () => 'standard', onChange: () => undefined, onOutput: () => undefined, onFinished: () => undefined,
    });
    cleanup.push(() => engine.dispose());
    const main = engine.send(undefined, 'do a long task', dir);
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0].timeoutMs).toBe(0);
    complete({ code: 0, finalText: 'Done.', rateLimited: false, cancelled: false, timedOut: false });
    await flush();
    engine.send(main.id, '/btw quick check', dir);
    await flush();
    expect(requests[1].timeoutMs).toBe(0);
    complete({ code: 0, finalText: 'Side answer.', rateLimited: false, cancelled: false, timedOut: false });
    await flush();
    engine.sendCommand(main.id, '/compact', dir);
    await flush();
    expect(requests[2].timeoutMs).toBe(0);
    complete({ code: 0, finalText: 'Compacted.', rateLimited: false, cancelled: false, timedOut: false });
    await flush();
  });
});

function runner(kind: AgentKind, mode: 'hot' | 'one-shot', timeoutMs = 0, onApproval?: RunRequest['onApproval']) {
  vi.useFakeTimers();
  const dir = temp();
  const child = new EventEmitter() as any;
  child.pid = 4242;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const send = (message: object) => child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
  const close = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 1;
    child.emit('close', 1);
  };
  child.stdin = {
    on: vi.fn(), end: vi.fn(),
    write: vi.fn((line: string) => {
      const m = JSON.parse(line);
      if (kind !== 'codex' || mode !== 'hot' || m.id === undefined || !m.method) return;
      queueMicrotask(() => {
        const result = m.method === 'thread/start' ? { thread: { id: 'thread' } } :
          m.method === 'turn/start' ? { turn: { id: 'turn' } } : {};
        send({ id: m.id, result });
        if (m.method === 'turn/interrupt') send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } });
      });
    }),
  };
  vi.spyOn(cp, 'spawn').mockReturnValue(child);
  vi.spyOn(cp, 'execFile').mockImplementation((() => close()) as any);
  vi.spyOn(process, 'kill').mockImplementation((() => { close(); return true; }) as any);
  const req: RunRequest = {
    runId: dir, account: { id: kind, kind, label: kind, home: null, role: 'master', createdAt: 0 },
    cliPath: 'fake', mode: 'write', autonomy: 'standard', cwd: dir, prompt: 'do a long task',
    logFile: path.join(dir, 'run.log'), timeoutMs, onText: vi.fn(), onApproval,
  };
  const hot = mode === 'hot' ? new HotAgents(dir) : undefined;
  const promise = hot ? hot.run(req) : runAgent(req);
  cleanup.push(() => { close(); hot?.dispose(); });
  const cancel = () => hot ? hot.cancel(req.runId) : cancelRun(req.runId);
  return { child, req, promise, send, cancel };
}

describe.each(['hot', 'one-shot'] as const)('%s runs', mode => {
  it.each(kinds)('%s can stay silent for hours and still be stopped by the user', async kind => {
    const h = runner(kind, mode);
    await flush();
    let settled = false;
    void h.promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(6 * 3600000);
    if (kind === 'antigravity') {
      h.send({ event: 'step_update', step_update: { step_index: 1, step_type: 'tool', state: 'ACTIVE' } });
      await vi.advanceTimersByTimeAsync(6 * 3600000);
    }
    expect(settled).toBe(false);
    expect(h.child.exitCode).toBeNull();
    h.cancel();
    await flush();
    expect(await h.promise).toMatchObject({ cancelled: true, timedOut: false });
  });

  it.each(kinds)('still enforces an explicitly bounded %s probe', async kind => {
    const h = runner(kind, mode, 1000);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await h.promise).toMatchObject({ timedOut: true, cancelled: false });
  });
});

describe('unlimited hot approval waits', () => {
  it.each(['claude', 'codex'] as const)('%s approval does not re-enable a run timer', async kind => {
    let answer!: (value: ApprovalAnswer) => void;
    const onApproval = vi.fn(() => new Promise<ApprovalAnswer>(resolve => { answer = resolve; }));
    const h = runner(kind, 'hot', 0, onApproval);
    await flush();
    if (kind === 'claude') {
      h.send({ type: 'control_request', request_id: 'approval', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' } } });
    } else {
      h.send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'command', command: 'npm test', cwd: h.req.cwd } });
    }
    await flush();
    expect(onApproval).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2 * 3600000);
    expect(h.child.exitCode).toBeNull();
    answer('accept');
    await flush();
    await vi.advanceTimersByTimeAsync(2 * 3600000);
    expect(h.child.exitCode).toBeNull();
    h.cancel();
    await flush();
    expect(await h.promise).toMatchObject({ cancelled: true, timedOut: false });
  });
});
