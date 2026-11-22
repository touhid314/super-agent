import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliUpdater } from '../src/core/agents/updater';

// Fake CLIs are shell scripts, so these run where CI publishes from (Linux).
describe.runIf(process.platform !== 'win32')('CLI updates on Linux/macOS', () => {
  function fakeCli(version: () => string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-upd-'));
    const cli = path.join(dir, 'codex');
    const write = () => fs.writeFileSync(cli, `#!/bin/sh\necho "${version()}"\n`, { mode: 0o755 });
    write();
    return { dir, cli, write };
  }

  it('an up-to-date CLI is not restarted (its agents keep their warm start)', async () => {
    const { cli } = fakeCli(() => 'codex-cli 1.0.0');
    const calls: string[] = [];
    const u = new CliUpdater(() => cli, { before: () => calls.push('before'), after: () => calls.push('after') }, 'linux');
    expect(await u.update('codex')).toMatchObject({ ok: true, from: 'codex-cli 1.0.0', to: 'codex-cli 1.0.0' });
    expect(calls).toEqual([]);
  });

  it.runIf(process.getuid?.() !== 0)('a CLI installed where this user cannot write is not updated, and nothing restarts', async () => {
    const { dir, cli } = fakeCli(() => 'codex-cli 1.0.0');
    fs.chmodSync(dir, 0o555);
    try {
      const calls: string[] = [];
      const u = new CliUpdater(() => cli, { before: () => calls.push('before'), after: () => calls.push('after') }, 'linux');
      const r = await u.update('codex');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/can't write to/);
      expect(calls).toEqual([]);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});
