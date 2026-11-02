import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HotAgents } from '../src/core/agents/hot';
import { AccountPool } from '../src/core/agents/pool';
import type { Account } from '../src/core/types';
import { Engine } from '../src/engine/engine';

describe('an agent that carries on by itself after replying', () => {
  it.runIf(process.platform === 'win32')('shows that work as a new turn and its next reply as the answer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-wake-'));
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(cwd);
    // A claude "CLI" that wakes up by itself once after its first reply (like a Monitor event).
    const cli = path.join(dir, 'claude.cmd');
    fs.writeFileSync(cli, `@node "${path.resolve('tests/fixtures/fake-claude.js')}" %*\r\n`);
    const account: Account = { id: 'c', kind: 'claude', label: 'Claude · test', home: null, role: 'master', createdAt: 0 };
    const hot = new HotAgents(dir);
    const engine = new Engine({
      config: { accounts: [account], settings: { taskTimeoutMin: 5, browserTools: false } } as never,
      pool: new AccountPool(),
      dataDir: dir,
      cliPath: () => cli,
      runAgent: (req) => hot.run(req),
      cancelRun: (id) => void hot.cancel(id),
      usageLoad: () => 0,
      usageResetAt: () => undefined,
      autonomy: () => 'standard',
      onChange: () => undefined,
      onOutput: () => undefined,
      onFinished: () => undefined,
    });
    hot.onWake = (w) => void engine.wake(w.account.id, w.sessionId);
    try {
      const t = engine.send(undefined, 'run the smoke test', cwd);
      const agent = () => t.messages.filter((m) => m.role === 'agent');
      for (let i = 0; i < 300 && agent().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
      expect(agent().map((m) => m.text)).toEqual(['Started (run the smoke test). I\'ll report as events arrive.', 'Done: all 5 courses downloaded.']);
      // What it did on its own is the second turn's work, not lost.
      expect(agent()[1].activity?.join('\n')).toContain('The run finished: all 5 courses downloaded.');
      expect(t.status).toBe('idle');

      // And it keeps working normally afterwards: the next message resumes the same session.
      engine.send(t.id, 'thanks', cwd);
      for (let i = 0; i < 300 && agent().length < 3; i++) await new Promise((r) => setTimeout(r, 50));
      expect(agent()[2].text).toBe("Started (thanks). I'll report as events arrive.");

      // A turn Claude runs before getting to our message (a queued notice) is not our answer: ours still arrives.
      engine.send(t.id, '[queued-notice] what is this folder?', cwd);
      for (let i = 0; i < 300 && agent().length < 4; i++) await new Promise((r) => setTimeout(r, 50));
      expect(agent()[3].text).toBe("Started ([queued-notice] what is this folder?). I'll report as events arrive.");
      expect(t.messages.some((m) => /stopped without an answer/.test(m.text))).toBe(false);
    } finally {
      engine.dispose();
      hot.dispose();
    }
  }, 30000);
});
