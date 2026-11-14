import { describe, expect, it } from 'vitest';
import { installClis } from '../src/core/agents/installer';
import { INSTALL_SCRIPT, installCommand } from '../src/core/agents/cli';

describe('installClis', () => {
  it("uses each maker's own PowerShell installer (no npm)", () => {
    expect(installCommand('codex')).toBe(`powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${INSTALL_SCRIPT.codex} | iex"`);
    expect(Object.values(INSTALL_SCRIPT)).toEqual(['https://chatgpt.com/codex/install.ps1', 'https://claude.ai/install.ps1', 'https://antigravity.google/cli/install.ps1']);
  });

  it('judges by whether the CLI can be found afterwards, and keeps the error that explains a failure', async () => {
    const ran: string[] = [];
    const found = new Set(['claude', 'antigravity']);
    const results = await installClis(
      ['codex', 'claude', 'antigravity'],
      (k) => found.has(k),
      async (cmd) => {
        ran.push(cmd);
        if (cmd.includes('chatgpt.com')) throw new Error('Downloading…\nAt line:1 char:1\n+ irm …\nInvoke-RestMethod : The remote name could not be resolved');
        if (cmd.includes('antigravity')) throw new Error('PATH update failed'); // …but agy is in place
        return 'ok';
      },
    );
    expect(ran).toHaveLength(3);
    expect(results).toEqual([
      { kind: 'codex', ok: false, error: 'Downloading… Invoke-RestMethod : The remote name could not be resolved' },
      { kind: 'claude', ok: true },
      { kind: 'antigravity', ok: true },
    ]);
  });
});
