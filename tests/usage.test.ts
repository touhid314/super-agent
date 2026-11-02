import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agyWindows, codexUsage } from '../src/core/agents/usage';

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

describe('Antigravity /usage', () => {
  const groups = [
    { name: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro', buckets: [
      { window: 'weekly', remaining_fraction: 0.83, reset_time: '2099-11-03T00:18:14Z' },
      { window: '5h', remaining_fraction: 0.99, reset_time: '2099-11-02T10:09:52Z' },
    ] },
    { name: 'Claude and GPT models', description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS', buckets: [{ window: '5h', remaining_fraction: 0.4, reset_time: '2099-11-02T11:11:56Z' }] },
    { name: 'Gemini 4 Argon', description: 'For paid Pro plans, Argon quota is separate.', buckets: [{ window: 'weekly', remaining_fraction: 0.77 }] },
  ];
  it('turns each group limit into a window, with reset times', () => {
    const w = agyWindows(groups);
    expect(w.map((x) => [x.label, x.percent, !!x.other])).toEqual([
      ['week · Gemini', 17, false],
      ['5h · Gemini', 1, false],
      ['5h · Claude and GPT', 60, false],
      ['week · Gemini 4 Argon', 23, false],
    ]);
    expect(w[0].resetsAt).toBe(Date.parse('2099-11-03T00:18:14Z'));
  });
  it("marks groups for models the account isn't using, so they don't count as its load", () => {
    expect(agyWindows(groups, 'gemini-3.8-flash').map((x) => !!x.other)).toEqual([false, false, true, true]);
    expect(agyWindows(groups, 'claude-sonnet-4-6').map((x) => !!x.other)).toEqual([true, true, false, true]);
    expect(agyWindows(groups, 'gemini-4-argon').map((x) => !!x.other)).toEqual([true, true, true, false]);
  });
});
