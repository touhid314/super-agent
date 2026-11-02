import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account, AgentKind, CliInfo, LoginState } from '../types';
import type { ConfigStore } from '../store/config';
import { newId, paths, readJson } from '../store/paths';
import { CLI_META, commandLine, installCommand, loginArgs, resolveCli, accountEnv } from './cli';
import type { AccountPool } from './pool';
import { runAgent } from './runner';

const HOME = os.homedir();
const DEFAULT_HOME: Record<AgentKind, string> = {
  codex: path.join(HOME, '.codex'),
  claude: path.join(HOME, '.claude'),
  antigravity: path.join(HOME, '.gemini', 'antigravity-cli'),
};

/** Accounts: separate config homes per CLI login, sign-in windows, login detection, CLI discovery. */
export class AccountService {
  clis: CliInfo[] = [];

  constructor(
    private config: ConfigStore,
    private pool: AccountPool,
    /** How to show sign-in/install consoles (a new console window by default; VS Code passes a terminal). */
    private openConsoleFn: ConsoleOpener = openConsole,
  ) {}

  refreshClis(): void {
    this.clis = (['codex', 'claude', 'antigravity'] as AgentKind[]).map((k) => resolveCli(k, this.config.settings.cliPaths[k]));
  }

  cliPath(kind: AgentKind): string | null {
    return this.clis.find((c) => c.kind === kind)?.path ?? null;
  }

  add(kind: AgentKind, label: string): Account {
    if (kind === 'antigravity' && this.config.accounts.some((a) => a.kind === 'antigravity')) {
      throw new Error('Antigravity keeps one Google login per PC (in Windows Credential Manager), so only one Antigravity account can be on the team. To use a different Google account, click Re-login on it and switch with /logout and /login.');
    }
    const id = newId();
    const home = kind === 'antigravity' ? null : paths.accountHome(id);
    if (home) fs.mkdirSync(home, { recursive: true });
    if (kind === 'codex' && home) prepareCodexHome(home);
    const account: Account = {
      id,
      kind,
      label: label.trim() || `${CLI_META[kind].name} ${this.config.accounts.filter((a) => a.kind === kind).length + 1}`,
      home,
      role: this.config.master() ? 'worker' : 'master',
      createdAt: Date.now(),
    };
    this.config.accounts.push(account);
    this.config.saveAccounts();
    this.refreshStatus(account.id);
    return account;
  }

  /** Register the CLIs' default logins (~/.codex, ~/.claude, Antigravity) if they are signed in. */
  importDefaults(): number {
    let added = 0;
    for (const kind of ['codex', 'claude', 'antigravity'] as AgentKind[]) {
      if (this.config.accounts.some((a) => a.kind === kind && a.home === null)) continue;
      const probe: Account = { id: 'probe', kind, label: '', home: null, role: 'off', createdAt: 0 };
      const login = detectLogin(probe);
      if (login.login !== 'signed-in') continue;
      this.config.accounts.push({
        id: newId(),
        kind,
        label: labelFor(kind, login.email, 'default'),
        home: null,
        role: this.config.master() ? 'worker' : 'master',
        createdAt: Date.now(),
      });
      added++;
    }
    // Also pick up sibling Codex homes such as ~/.codex-acct2.
    for (const name of fs.readdirSync(HOME)) {
      if (!/^\.codex-.+/.test(name)) continue;
      const home = path.join(HOME, name);
      if (!fs.existsSync(path.join(home, 'auth.json'))) continue;
      if (this.config.accounts.some((a) => a.home && path.resolve(a.home) === path.resolve(home))) continue;
      const probe: Account = { id: 'probe', kind: 'codex', label: '', home, role: 'off', createdAt: 0 };
      this.config.accounts.push({ id: newId(), kind: 'codex', label: labelFor('codex', detectLogin(probe).email, name.slice(7)), home, role: 'worker', createdAt: Date.now() });
      added++;
    }
    this.refreshAll();
    this.ensureMaster();
    if (added) this.config.saveAccounts();
    return added;
  }

  update(id: string, patch: Partial<Pick<Account, 'label' | 'role' | 'model' | 'effort'>>): void {
    const acc = this.config.account(id);
    if (!acc) return;
    if (patch.role === 'master') {
      for (const a of this.config.accounts) if (a.role === 'master') a.role = 'worker';
    }
    Object.assign(acc, patch);
    if (acc.model === '') delete acc.model;
    this.ensureMaster();
    this.config.saveAccounts();
  }

  setMaster(id: string): void {
    this.update(id, { role: 'master' });
  }

  /** In the team <-> off the team. Removing the master hands the crown to another member. */
  toggleTeam(id: string): void {
    const acc = this.config.account(id);
    if (!acc) return;
    this.update(id, { role: acc.role === 'off' ? 'worker' : 'off' });
  }

  /**
   * There is always a master while anyone is on the team: prefer a signed-in member, then any member,
   * then (if the team is empty) the first signed-in account.
   */
  ensureMaster(): void {
    const accs = this.config.accounts;
    if (accs.some((a) => a.role === 'master')) return;
    const signedIn = (a: Account) => this.pool.get(a.id).login !== 'signed-out';
    const pick =
      accs.find((a) => a.role === 'worker' && signedIn(a)) ??
      accs.find((a) => a.role === 'worker') ??
      accs.find((a) => a.role === 'off' && signedIn(a) && !accs.some((b) => b.role === 'worker'));
    if (pick) pick.role = 'master';
  }

  /** First run: pick up existing CLI logins and choose a master, so the team works out of the box. */
  bootstrap(): void {
    this.refreshAll();
    if (this.config.accounts.length === 0) this.importDefaults();
    const before = this.config.master()?.id;
    this.ensureMaster();
    if (this.config.master()?.id !== before) this.config.saveAccounts();
  }

  remove(id: string): void {
    const acc = this.config.account(id);
    if (!acc) return;
    this.config.accounts = this.config.accounts.filter((a) => a.id !== id);
    this.ensureMaster();
    this.config.saveAccounts();
    this.pool.delete(id);
    // Only delete homes Super-Agent created; never touch the user's default CLI folders.
    if (acc.home && path.resolve(acc.home).startsWith(path.resolve(paths.data))) {
      fs.rmSync(acc.home, { recursive: true, force: true });
    }
  }

  /** Open a console window running the CLI's sign-in flow with this account's config home. */
  signIn(id: string): void {
    const acc = this.config.account(id);
    if (!acc) throw new Error('Unknown account');
    const cli = this.cliPath(acc.kind);
    if (!cli) throw new Error(`${CLI_META[acc.kind].name} is not installed.`);
    const hint =
      acc.kind === 'codex'
        ? 'Complete the sign-in in your browser. This window closes itself when done.'
        : acc.kind === 'claude'
          ? 'Follow the prompts to log in (type /login if asked). When signed in, type /exit.'
          : 'Antigravity keeps ONE Google login for this PC. To use a different account: type /logout, then /login, choose Google OAuth and sign in with the new account. Then type /exit.';
    this.openConsoleFn(`Sign in: ${acc.label}`, hint, commandLine(cli, loginArgs(acc.kind)), accountEnv(acc), acc.kind === 'codex');
    // Poll for the login to land so the UI updates by itself.
    let n = 0;
    const timer = setInterval(() => {
      this.refreshStatus(id);
      if (this.pool.get(id).login === 'signed-in' || ++n > 150) clearInterval(timer);
    }, 2000);
  }

  installCli(kind: AgentKind): void {
    this.openConsoleFn(`Install ${CLI_META[kind].name}`, `Installing ${CLI_META[kind].name}...`, installCommand(kind), process.env, false);
  }

  refreshStatus(id: string): void {
    const acc = this.config.account(id);
    if (!acc) return;
    const s = detectLogin(acc);
    this.pool.patch(id, { login: s.login, email: s.email });
    // Accounts added with "+" start with a placeholder name; once signed in, name them after the login.
    if (s.email && /^(Codex|Claude Code|Antigravity) \d+$/.test(acc.label)) {
      acc.label = labelFor(acc.kind, s.email, acc.label);
      this.config.saveAccounts();
    }
  }

  refreshAll(): void {
    for (const a of this.config.accounts) this.refreshStatus(a.id);
  }

  /** Run a tiny prompt to prove the account works end to end. */
  async verify(id: string): Promise<void> {
    const acc = this.config.account(id);
    const cli = acc && this.cliPath(acc.kind);
    if (!acc || !cli) throw new Error('Account or CLI missing');
    this.pool.patch(id, { verifying: true, lastError: undefined });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-verify-'));
    try {
      const res = await runAgent({
        runId: `verify-${id}`,
        account: acc,
        cliPath: cli,
        mode: 'read-only',
        autonomy: 'standard',
        cwd,
        // Some agents (Antigravity) otherwise try a shell command first, which headless mode denies.
        prompt: 'Answer directly, without using any tools or running any commands: reply with exactly SUPER-AGENT OK',
        logFile: path.join(paths.data, 'verify', `${id}.log`),
        timeoutMs: 180000,
        onText: () => undefined,
      });
      const ok = /SUPER-AGENT OK/i.test(res.finalText);
      this.pool.patch(id, {
        verifying: false,
        lastError: ok ? undefined : res.rateLimited ? 'Rate limited' : `Check failed (exit ${res.code}). See ${path.join(paths.data, 'verify', `${id}.log`)}`,
        login: ok ? 'signed-in' : this.pool.get(id).login,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
}

/** "Codex · alice" from the login email, so several accounts of one CLI are easy to tell apart. */
function labelFor(kind: AgentKind, email: string | undefined, fallback: string): string {
  const short = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity' }[kind];
  const who = email?.split('@')[0];
  return `${short} · ${who ? who.slice(0, 18) : fallback}`;
}

export type ConsoleOpener = (title: string, hint: string, command: string, env: NodeJS.ProcessEnv, closeOnExit: boolean) => void;

function openConsole(title: string, hint: string, command: string, env: NodeJS.ProcessEnv, closeOnExit: boolean): void {
  const safe = (s: string) => s.replace(/[&|<>^"]/g, '');
  const inner = `title ${safe(title)} & echo. & echo   ${safe(hint)} & echo. & ${command}${closeOnExit ? ' & timeout /t 4' : ''}`;
  spawn('cmd.exe', ['/d', '/c', `start "${safe(title)}" cmd.exe ${closeOnExit ? '/c' : '/k'} "${inner}"`], {
    env,
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
    windowsHide: false,
  }).unref();
}

/** Codex accounts on Windows share the elevated sandbox users, so they must share its credentials. */
function prepareCodexHome(home: string): void {
  const def = DEFAULT_HOME.codex;
  for (const f of ['config.toml', 'AGENTS.md']) {
    const src = path.join(def, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(home, f));
  }
  const shared = path.join(def, '.sandbox-secrets');
  const target = fs.existsSync(shared) ? fs.realpathSync(shared) : path.join(paths.data, 'codex-sandbox-secrets');
  fs.mkdirSync(target, { recursive: true });
  try {
    fs.symlinkSync(target, path.join(home, '.sandbox-secrets'), 'junction');
  } catch {
    /* non-fatal: Codex will ask for sandbox setup once */
  }
}

export function detectLogin(acc: Account): { login: LoginState; email?: string } {
  const home = acc.home ?? DEFAULT_HOME[acc.kind];
  try {
    if (acc.kind === 'codex') {
      const auth = readJson<any>(path.join(home, 'auth.json'), null);
      if (!auth) return { login: 'signed-out' };
      return { login: 'signed-in', email: jwtEmail(auth?.tokens?.id_token) };
    }
    if (acc.kind === 'claude') {
      const meta = readJson<any>(acc.home ? path.join(home, '.claude.json') : path.join(HOME, '.claude.json'), null);
      const email = meta?.oauthAccount?.emailAddress as string | undefined;
      const creds = fs.existsSync(path.join(home, '.credentials.json'));
      return { login: creds || email ? 'signed-in' : 'signed-out', email };
    }
    // Antigravity: agy keeps its login outside this folder; its state files only appear once it has been used/signed in.
    const used = fs.existsSync(path.join(home, 'jetski_state.pbtxt')) || fs.existsSync(path.join(home, 'conversations'));
    return { login: used ? 'signed-in' : 'unknown' };
  } catch {
    return { login: 'unknown' };
  }
}

function jwtEmail(token?: string): string | undefined {
  if (!token) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.email;
  } catch {
    return undefined;
  }
}
