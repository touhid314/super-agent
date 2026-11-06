import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { AGENT_KINDS, type Account, type Settings } from '../types';
import { paths, readJson, writeJson } from './paths';

export const DEFAULT_SETTINGS: Settings = {
  workspaceRoot: path.join(os.homedir(), 'Documents', 'Super-Agent Projects'),
  autonomy: 'standard',
  requirePlanApproval: true,
  // Workers are trusted to own their tasks; review is opt-in so work isn't slowed down by default.
  masterReview: false,
  // Agents work live in the project folder; isolated worktrees are opt-in.
  workspace: 'shared',
  soundOnDone: true,
  maxFixAttempts: 3,
  taskTimeoutMin: 30,
  verifyTimeoutMin: 10,
  cliPaths: {},
};

/** A folder Super Agent created (under its data folder), as opposed to a CLI's default or another tool's login. */
export function ownsHome(home: string | null, dataDir = paths.data): boolean {
  if (!home) return false;
  const rel = path.relative(path.resolve(dataDir), path.resolve(home));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Codex and Claude Code accounts must sign in to a folder of their own: one using the CLI's default login (~/.claude,
 * ~/.codex) or a folder outside Super Agent's switches account whenever anything else on the PC signs in there.
 * Antigravity has one login per PC anyway, so it is the exception.
 */
export function sharesLogin(a: Account, dataDir = paths.data): boolean {
  return a.kind !== 'antigravity' && !ownsHome(a.home, dataDir);
}

export class ConfigStore {
  settings: Settings;
  accounts: Account[];
  /** Accounts dropped on load because they used a shared login: the user is told once, to add them again. */
  droppedShared: Account[] = [];

  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(paths.settings, {}) };
    const saved = readJson<Account[]>(paths.accounts, []);
    // Drop accounts of CLIs Super-Agent no longer supports (Gemini CLI), with the profile folders it created for them.
    this.accounts = saved.filter((a) => AGENT_KINDS.includes(a.kind));
    for (const a of saved.filter((x) => !AGENT_KINDS.includes(x.kind))) {
      if (ownsHome(a.home)) fs.rmSync(a.home!, { recursive: true, force: true });
    }
    // Drop accounts on a shared login (older versions imported the CLIs' default logins). Their folders aren't ours:
    // left untouched, so the CLI stays signed in for everything else that uses it.
    this.droppedShared = this.accounts.filter((a) => sharesLogin(a));
    this.accounts = this.accounts.filter((a) => !sharesLogin(a));
    if (this.accounts.length !== saved.length) this.saveAccounts();
  }

  saveSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    writeJson(paths.settings, this.settings);
  }

  saveAccounts(): void {
    writeJson(paths.accounts, this.accounts);
  }

  account(id: string): Account | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  master(): Account | undefined {
    return this.accounts.find((a) => a.role === 'master');
  }

  /** Team members that take tasks. A team of one: the master does the work itself. */
  workers(): Account[] {
    const w = this.accounts.filter((a) => a.role === 'worker');
    if (w.length) return w;
    const m = this.master();
    return m ? [m] : [];
  }
}
