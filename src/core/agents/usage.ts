import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account, AccountUsage, JobState, UsageWindow } from '../types';
import type { ConfigStore } from '../store/config';

const HOME = os.homedir();

/**
 * Usage limits per account.
 * - Codex: the latest `rate_limits` event in the account's own session logs (no network; as of its last run).
 * - Claude: the same OAuth usage endpoint Claude Code's /usage screen reads, with the account's own login.
 * - Antigravity: the CLI does not expose quota, so only the runs Super-Agent made today are shown.
 */
export class UsageService {
  private usage = new Map<string, AccountUsage>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private config: ConfigStore,
    private store: { all(): JobState[] },
    private onChange: () => void,
  ) {}

  all(): Record<string, AccountUsage> {
    return Object.fromEntries(this.usage);
  }

  /** Highest usage across an account's windows (0-100); unknown = 0. */
  load(id: string): number {
    const u = this.usage.get(id);
    return u ? Math.max(0, ...u.windows.map((w) => w.percent)) : 0;
  }

  /** When the account's exhausted (≥90%) limit window resets, if the provider told us. */
  resetAt(id: string): number | undefined {
    const resets = (this.usage.get(id)?.windows ?? []).filter((w) => w.percent >= 90 && w.resetsAt).map((w) => w.resetsAt!);
    return resets.length ? Math.max(...resets) : undefined;
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.config.accounts.map((a) => this.refresh(a.id)));
  }

  /** Debounced refresh after an agent run finishes on this account. */
  soon(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => void this.refresh(id), 3000));
  }

  async refresh(id: string): Promise<void> {
    const acc = this.config.account(id);
    if (!acc) return;
    let u: Omit<AccountUsage, 'runsToday'>;
    try {
      u = acc.kind === 'codex' ? codexUsage(acc) : acc.kind === 'claude' ? await claudeUsage(acc) : { windows: [], note: 'Antigravity does not report its quota' };
    } catch (err) {
      u = { windows: [], note: `Usage unavailable: ${(err as Error).message}` };
    }
    this.usage.set(id, { ...u, runsToday: this.runsToday(id) });
    this.onChange();
  }

  private runsToday(id: string): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    let n = 0;
    for (const j of this.store.all()) {
      for (const r of j.masterRuns) if (r.accountId === id && r.startedAt >= start.getTime()) n++;
      for (const t of j.tasks) for (const r of t.runs) if (r.accountId === id && r.startedAt >= start.getTime()) n++;
    }
    return n;
  }
}

const windowLabel = (minutes?: number) =>
  !minutes ? 'limit' : minutes <= 360 ? `${Math.round(minutes / 60)}h` : minutes >= 10000 ? 'week' : `${Math.round(minutes / 1440)}d`;

/** A window whose reset time has passed has started over. */
function settle(w: UsageWindow, now = Date.now()): UsageWindow {
  return w.resetsAt && w.resetsAt < now ? { ...w, percent: 0, resetsAt: undefined } : w;
}

function newestFile(dir: string, depth = 4): string | null {
  // Session logs live in sessions/YYYY/MM/DD/*.jsonl; walk newest-named folders first.
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
  if (depth === 0 || entries.some((e) => e.isFile() && e.name.endsWith('.jsonl'))) {
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => path.join(dir, e.name));
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files[0]) return files[0];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = newestFile(path.join(dir, e.name), depth - 1);
    if (f) return f;
  }
  return null;
}

export function codexUsage(acc: Account): Omit<AccountUsage, 'runsToday'> {
  const home = acc.home ?? path.join(HOME, '.codex');
  const file = newestFile(path.join(home, 'sessions'));
  if (!file) return { windows: [], note: 'No Codex runs yet on this account' };
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  const len = Math.min(stat.size, 512 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, stat.size - len);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const rl = findKey(JSON.parse(line), 'rate_limits') as any;
      if (!rl) continue;
      const windows: UsageWindow[] = [];
      for (const k of ['primary', 'secondary'] as const) {
        const w = rl[k];
        if (w && typeof w.used_percent === 'number') {
          windows.push(settle({ label: windowLabel(w.window_minutes), percent: w.used_percent, resetsAt: w.resets_at ? w.resets_at * 1000 : undefined }));
        }
      }
      return { windows, plan: rl.plan_type ?? undefined, measuredAt: stat.mtimeMs };
    } catch {
      /* partial line at the read boundary */
    }
  }
  return { windows: [], note: 'No usage reported yet', measuredAt: stat.mtimeMs };
}

function findKey(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in (obj as Record<string, unknown>)) return (obj as Record<string, unknown>)[key];
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const f = findKey(v, key);
    if (f !== undefined) return f;
  }
  return undefined;
}

export async function claudeUsage(acc: Account): Promise<Omit<AccountUsage, 'runsToday'>> {
  const credFile = path.join(acc.home ?? path.join(HOME, '.claude'), '.credentials.json');
  if (!fs.existsSync(credFile)) return { windows: [], note: 'Not signed in' };
  const oauth = JSON.parse(fs.readFileSync(credFile, 'utf8'))?.claudeAiOauth;
  if (!oauth?.accessToken) return { windows: [], note: 'Not signed in' };
  const plan = oauth.subscriptionType as string | undefined;
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    return { windows: [], plan, note: 'Login token expired — it refreshes the next time Claude runs' };
  }
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { windows: [], plan, note: `Usage unavailable (HTTP ${res.status})` };
  const data = (await res.json()) as any;
  const windows: UsageWindow[] = [];
  const at = (s?: string) => (s ? Date.parse(s) : undefined);
  if (Array.isArray(data.limits) && data.limits.length) {
    for (const l of data.limits) {
      if (typeof l.percent !== 'number') continue;
      const label = l.kind === 'session' ? '5h' : l.kind === 'weekly' ? 'week' : String(l.kind ?? 'limit').replace(/_/g, ' ');
      windows.push(settle({ label, percent: l.percent, resetsAt: at(l.resets_at) }));
    }
  } else {
    const pairs: [string, string][] = [['five_hour', '5h'], ['seven_day', 'week'], ['seven_day_opus', 'week (Opus)']];
    for (const [k, label] of pairs) {
      const w = data[k];
      if (w && typeof w.utilization === 'number') windows.push(settle({ label, percent: w.utilization, resetsAt: at(w.resets_at) }));
    }
  }
  return { windows, plan, measuredAt: Date.now() };
}
