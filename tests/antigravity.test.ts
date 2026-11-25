import { EventEmitter } from 'node:events';
import * as cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgyTurnOutput, runAgent, type RunRequest } from '../src/core/agents/runner';
import { HotAgents } from '../src/core/agents/hot';

vi.mock('node:child_process', { spy: true });
const step = (index: number, text: string, state = 'DONE', type = 'agent_response') => JSON.stringify({
  event: 'step_update', step_update: { step_index: index, step_type: type, state, text_delta: text },
});
const result = (response: string, extra = {}) => JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response, ...extra } });

describe('Antigravity final response', () => {
  it('returns only the last response block, keeping progress in activity', () => {
    const turn = new AgyTurnOutput();
    expect(turn.render(step(1, 'I am checking the file.')).text).toBe('I am checking the file.');
    turn.render(step(2, '', 'DONE', 'tool'));
    expect(turn.render(step(3, 'private thought', 'DONE', 'thinking')).text).toBe('');
    turn.render(step(4, 'The fix ', 'ACTIVE'));
    turn.render(step(4, 'passes all tests.'));
    expect(turn.render(result('I am checking the file.\nThe fix passes all tests.')).final).toBe('The fix passes all tests.');
  });

  it('does not present progress as an answer when a later tool is denied', () => {
    const turn = new AgyTurnOutput();
    turn.render(step(1, 'CHECKING_FILE\n'));
    turn.render(step(2, '', 'ERROR', 'tool'));
    const r = turn.render(result('CHECKING_FILE\n', { denied_actions: [{ display_name: 'ReadFile' }] }));
    expect(r.final).toBe('');
    expect(r.text).toContain('permission denied: ReadFile');
  });

  it('keeps plain answers intact and supports older result-only streams', () => {
    const turn = new AgyTurnOutput();
    turn.render(step(1, 'I checked it: the answer is 4.'));
    expect(turn.render(result('I checked it: the answer is 4.')).final).toBe('I checked it: the answer is 4.');
    expect(new AgyTurnOutput().render(result('Answer from an older CLI')).final).toBe('Answer from an older CLI');
    expect(turn.render(result('no answer', { status: 'ERROR' })).final).toBe('');
  });
});

describe.each(['hot', 'one-shot'])('Antigravity %s runner', (mode) => {
  let hot: HotAgents | undefined;
  afterEach(() => { hot?.dispose(); hot = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

  function setup() {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-agy-'));
    const child = new EventEmitter() as any;
    child.pid = 4242;
    child.exitCode = null;
    child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    vi.spyOn(cp, 'spawn').mockReturnValue(child);
    // A stopped process closes, just as taskkill/process termination does in production.
    vi.spyOn(cp, 'execFile').mockImplementation((() => { child.exitCode = 1; child.emit('close', 1); }) as any);
    vi.spyOn(process, 'kill').mockImplementation((() => { child.exitCode = 1; child.emit('close', 1); return true; }) as any);
    const req: RunRequest = {
      runId: dir, account: { id: 'ag', kind: 'antigravity', label: 'Antigravity', home: null, role: 'master', createdAt: 0 },
      cliPath: 'agy', mode: 'write', autonomy: 'standard', cwd: dir, prompt: 'fix it',
      logFile: path.join(dir, 'run.log'), timeoutMs: 30 * 60000, onText: vi.fn(),
    };
    if (mode === 'hot') hot = new HotAgents(dir);
    const promise = hot ? hot.run(req) : runAgent(req);
    const send = (line: string) => child.stdout.emit('data', Buffer.from(line + '\n'));
    send(JSON.stringify({ event: 'init', conversation_id: 'saved-session' }));
    return { child, req, promise, send };
  }

  it('continues past 30 minutes while steps arrive and returns only the final block', async () => {
    const h = setup();
    h.send(step(1, 'Checking.'));
    await vi.advanceTimersByTimeAsync(20 * 60000);
    h.send(step(2, '', 'ACTIVE', 'tool'));
    await vi.advanceTimersByTimeAsync(20 * 60000);
    expect(h.child.exitCode).toBeNull();
    h.send(step(3, 'Fixed.'));
    h.send(result('Checking.\nFixed.'));
    h.child.exitCode = 0;
    h.child.emit('close', 0);
    expect(await h.promise).toMatchObject({ finalText: 'Fixed.', timedOut: false, sessionId: 'saved-session' });
  });

  it('still stops a silent process and preserves its session for recovery', async () => {
    const h = setup();
    h.send(step(1, 'Checking.'));
    await vi.advanceTimersByTimeAsync(29 * 60000);
    h.send(JSON.stringify({ event: 'heartbeat' })); // transport chatter is not work
    await vi.advanceTimersByTimeAsync(60000);
    expect(await h.promise).toMatchObject({ timedOut: true, finalText: '', sessionId: 'saved-session' });
  });

  it('handles a final result without a trailing newline', async () => {
    const h = setup();
    h.send(step(1, 'Final.'));
    h.child.stdout.emit('data', Buffer.from(result('Final.')));
    h.child.exitCode = 0;
    h.child.emit('close', 0);
    expect(await h.promise).toMatchObject({ finalText: 'Final.', timedOut: false });
  });
});
