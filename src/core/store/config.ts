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
  browserTools: true,
  maxFixAttempts: 3,
  taskTimeoutMin: 30,
  verifyTimeoutMin: 10,
  cliPaths: {},
};

export class ConfigStore {
  settings: Settings;
  accounts: Account[];

  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(paths.settings, {}) };
    const saved = readJson<Account[]>(paths.accounts, []);
    // Drop accounts of CLIs Super-Agent no longer supports (Gemini CLI), with the profile folders it created for them.
    this.accounts = saved.filter((a) => AGENT_KINDS.includes(a.kind));
    if (this.accounts.length !== saved.length) {
      for (const a of saved.filter((x) => !AGENT_KINDS.includes(x.kind))) {
        if (a.home && path.resolve(a.home).startsWith(path.resolve(paths.data))) fs.rmSync(a.home, { recursive: true, force: true });
      }
      this.saveAccounts();
    }
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
