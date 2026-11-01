import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexUsage } from '../src/core/agents/usage';

function codexHome(lines: unknown[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-usage-'));
  const dir = path.join(home, 'sessions', '2026', '11', '01');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return home;
}

const acc = (home: string) => ({ id: 'c', kind: 'codex' as const, label: 'c', home, role: 'worker' as const, createdAt: 0 });

describe('codex usage', () => {
  it('reads the latest rate limits from the session log', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const home = codexHome([
      { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 1, window_minutes: 300, resets_at: future } } } },
      { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 4, window_minutes: 300, resets_at: future }, secondary: { used_percent: 41, window_minutes: 10080, resets_at: future }, plan_type: 'plus' } } },
    ]);
    const u = codexUsage(acc(home));
    expect(u.plan).toBe('plus');
    expect(u.windows).toEqual([
      { label: '5h', percent: 4, resetsAt: future * 1000 },
      { label: 'week', percent: 41, resetsAt: future * 1000 },
    ]);
  });

  it('treats a window whose reset time passed as fresh', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const home = codexHome([{ payload: { rate_limits: { primary: { used_percent: 97, window_minutes: 300, resets_at: past } } } }]);
    expect(codexUsage(acc(home)).windows[0].percent).toBe(0);
  });

  it('copes with accounts that never ran', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-usage-empty-'));
    expect(codexUsage(acc(home)).windows).toEqual([]);
  });
});
