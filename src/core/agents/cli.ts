import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account, AgentKind, Autonomy, CliInfo } from '../types';

/** read-only: planning/review (master). write: implementing a task inside a worktree (worker). */
export type RunMode = 'read-only' | 'write';

export const CLI_META: Record<AgentKind, { name: string; bin: string; npm: string; brand: string }> = {
  codex: { name: 'Codex', bin: 'codex', npm: '@openai/codex', brand: 'OpenAI' },
  claude: { name: 'Claude Code', bin: 'claude', npm: '@anthropic-ai/claude-code', brand: 'Anthropic' },
  // Installed with Google's script, not npm (see installCommand).
  antigravity: { name: 'Antigravity', bin: 'agy', npm: '', brand: 'Google' },
};

/** Shell command that installs a CLI. */
export function installCommand(kind: AgentKind): string {
  return kind === 'antigravity'
    ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"'
    : `npm install -g ${CLI_META[kind].npm}`;
}

const EXTRA_LOCATIONS: Record<AgentKind, string[]> = {
  codex: [],
  claude: [path.join(os.homedir(), '.local', 'bin', 'claude.exe')],
  antigravity: [path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')],
};

export function resolveCli(kind: AgentKind, override?: string): CliInfo {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  try {
    const out = execFileSync('where.exe', [CLI_META[kind].bin], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const found = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // Prefer launchers cmd.exe can run directly.
    candidates.push(...found.filter((f) => /\.(exe|cmd|bat)$/i.test(f)));
  } catch {
    /* not on PATH */
  }
  candidates.push(...EXTRA_LOCATIONS[kind]);
  const hit = candidates.find((c) => c && fs.existsSync(c)) ?? null;
  let version: string | undefined;
  if (hit) {
    try {
      version = execFileSync(quote(hit) + ' --version', {
        encoding: 'utf8',
        shell: 'cmd.exe',
        windowsHide: true,
        timeout: 20000,
      })
        .trim()
        .split(/\r?\n/)
        .pop();
    } catch {
      /* leave version unknown */
    }
  }
  return { kind, path: hit, version };
}

/** Environment that points the CLI at this account's own config home. */
export function accountEnv(account: Account, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: '1', FORCE_COLOR: '0' };
  // Electron-hosted parents (VS Code etc.) leak this, which would turn Node-based CLIs into plain node.
  delete env.ELECTRON_RUN_AS_NODE;
  if (!account.home) return env;
  if (account.kind === 'codex') env.CODEX_HOME = account.home;
  if (account.kind === 'claude') env.CLAUDE_CONFIG_DIR = account.home;
  return env;
}

const CLAUDE_SAFE_BASH = [
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'py', 'pip', 'pytest', 'uv',
  'dotnet', 'cargo', 'go', 'java', 'javac', 'mvn', 'gradle', 'tsc', 'ls', 'dir', 'cat', 'mkdir', 'echo',
].map((c) => `Bash(${c}:*)`);

export interface ArgsInput {
  kind: AgentKind;
  mode: RunMode;
  autonomy: Autonomy;
  cwd: string;
  model?: string;
  /** Codex writes its final message here. */
  lastMessageFile: string;
  /** Continue this CLI session (Codex session id / Claude session id / Antigravity conversation id). */
  resume?: string;
  /** Claude only: id to give a new session, so it can be resumed later. */
  newSessionId?: string;
  /** Give the agent browser tools. Claude reads them from configFile (see writeBrowserConfig). */
  browser?: { outputDir: string; configFile: string };
}

/** Pinned so every agent gets the same, known-good browser tools. */
export const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.83';

/**
 * The Playwright MCP server: navigate, click, type, read pages and take screenshots.
 * Isolated (in-memory profile) and headless, so several agents can browse at once without clashing.
 */
export function browserServer(outputDir?: string): { command: string; args: string[] } {
  const programs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const chrome = programs.some((p) => fs.existsSync(path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')));
  return {
    command: 'cmd',
    args: ['/c', 'npx', '-y', PLAYWRIGHT_MCP, '--isolated', '--headless', '--browser', chrome ? 'chrome' : 'msedge', ...(outputDir ? ['--output-dir', outputDir] : [])],
  };
}

/** Claude Code takes MCP servers from a JSON file. */
export function writeBrowserConfig(file: string, outputDir: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { playwright: browserServer(outputDir) } }));
}

/** Antigravity only has a per-PC MCP list, so the browser is registered there once. */
export function ensureAgyBrowser(agyPath: string): void {
  try {
    const list = execFileSync(agyPath, ['mcp', 'list'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (/playwright/i.test(list)) return;
    const s = browserServer();
    execFileSync(agyPath, ['mcp', 'add', 'playwright', '--', s.command, ...s.args], { windowsHide: true, timeout: 20000 });
  } catch {
    /* agy missing or too old: it just runs without a browser */
  }
}

function codexBrowser(outputDir: string): string[] {
  const s = browserServer(outputDir);
  // TOML literal strings ('...') need no escaping, which keeps the cmd.exe quoting simple.
  return [
    '-c', `mcp_servers.playwright.command='${s.command}'`,
    '-c', `mcp_servers.playwright.args=[${s.args.map((a) => `'${a}'`).join(',')}]`,
    '-c', 'mcp_servers.playwright.startup_timeout_sec=120',
    // Nobody can answer an approval prompt in a headless run, so the browser tools are pre-approved.
    '-c', `mcp_servers.playwright.default_tools_approval_mode='approve'`,
    // Codex's bundled plugins (browser, computer use…) need the Codex desktop app running; headless they only
    // fail, and the model tends to pick them over Playwright.
    '-c', 'features.plugins=false',
    '-c', 'features.browser_use=false',
    '-c', 'features.computer_use=false',
  ];
}

/** CLI arguments for a headless run. The prompt itself is always sent on stdin. */
export function buildArgs(i: ArgsInput): string[] {
  const model = i.model ? (i.kind === 'claude' || i.kind === 'antigravity' ? ['--model', i.model] : ['-m', i.model]) : [];
  if (i.kind === 'codex') {
    const browser = i.browser ? codexBrowser(i.browser.outputDir) : [];
    const sandbox =
      i.mode === 'read-only'
        ? ['--sandbox', 'read-only']
        : i.autonomy === 'full'
          ? ['--dangerously-bypass-approvals-and-sandbox']
          : ['--sandbox', 'workspace-write'];
    if (i.resume) {
      // "exec resume" has no --sandbox/-C: set the sandbox through config; the cwd comes from the process.
      const mode = i.mode === 'read-only' ? ['-c', 'sandbox_mode="read-only"'] : i.autonomy === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-c', 'sandbox_mode="workspace-write"'];
      return ['exec', 'resume', i.resume, '--skip-git-repo-check', ...mode, ...browser, ...model, '-o', i.lastMessageFile, '-'];
    }
    return ['exec', '--skip-git-repo-check', '--color', 'never', '-C', i.cwd, ...sandbox, ...browser, ...model, '-o', i.lastMessageFile, '-'];
  }
  if (i.kind === 'claude') {
    const browserTools = i.browser ? ['mcp__playwright'] : [];
    const perms =
      i.mode === 'read-only'
        ? ['--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', ...browserTools]
        : i.autonomy === 'full'
          ? ['--dangerously-skip-permissions']
          : ['--permission-mode', 'acceptEdits', '--allowedTools', ...CLAUDE_SAFE_BASH, ...browserTools];
    // Variadic options (--mcp-config, --allowedTools) end at the next flag, so --allowedTools comes last.
    const session = i.resume ? ['--resume', i.resume] : i.newSessionId ? ['--session-id', i.newSessionId] : [];
    const browser = i.browser ? ['--mcp-config', i.browser.configFile] : [];
    return [...browser, '-p', '--output-format', 'stream-json', '--verbose', ...session, ...model, ...perms];
  }
  // Antigravity: the runner appends "-p <prompt>" (agy ignores stdin).
  const perms = i.mode === 'read-only' ? ['--mode', 'plan'] : i.autonomy === 'full' ? ['--dangerously-skip-permissions'] : ['--mode', 'accept-edits'];
  // Headless agy auto-denies MCP calls, so the browser (registered by ensureAgyBrowser) is allowed per run.
  const browser = i.browser ? ['--settings', JSON.stringify({ permissions: { allow: ['mcp(playwright/*)'] } })] : [];
  return ['--output-format', 'stream-json', ...(i.resume ? ['--conversation', i.resume] : []), ...perms, ...browser, ...model];
}

/** Arguments that start the CLI's interactive sign-in flow. */
export function loginArgs(kind: AgentKind): string[] {
  return kind === 'codex' ? ['login'] : [];
}

export function quote(arg: string): string {
  return /[\s"&|<>^()*%!,;=]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

export function commandLine(bin: string, args: string[]): string {
  return [quote(bin), ...args.map(quote)].join(' ');
}
