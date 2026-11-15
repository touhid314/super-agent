import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../types';
import { accountEnv, commandLine } from './cli';
import { log } from '../log';
import { killTree } from './runner';

/** One slash command the panel offers. `super-agent`: handled by Super Agent itself, not sent to the agent. */
export interface SlashCommand {
  name: string;
  description?: string;
  /** What goes after the name, e.g. "[instructions]". */
  hint?: string;
  source: 'cli' | 'super-agent';
}

/** Commands Super Agent runs itself: they change its own state (threads, the lead's settings), which the CLI can't. */
export const OWN_COMMANDS: SlashCommand[] = [
  { name: 'new', description: 'Start a new thread', source: 'super-agent' },
  { name: 'clear', description: 'Start a new thread with empty context', source: 'super-agent' },
  { name: 'model', hint: '[model id]', description: "Choose the lead's model", source: 'super-agent' },
  { name: 'effort', hint: '[low|medium|high|xhigh|max]', description: "Set the lead's reasoning effort", source: 'super-agent' },
  { name: 'export', hint: '[md|json]', description: 'Export this conversation to a file', source: 'super-agent' },
];

/** Codex's built-in commands that work without its terminal UI (each maps to its app-server, see HotAgents). */
export const CODEX_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context', source: 'cli' },
  { name: 'review', hint: '[base <branch> | commit <sha> | instructions]', description: 'Review your changes and find issues', source: 'cli' },
  { name: 'init', description: 'Create an AGENTS.md file with instructions for Codex', source: 'cli' },
  { name: 'mcp', description: 'List the configured MCP servers and their status', source: 'cli' },
];

/** Interactive-only or internal commands that do nothing useful from the panel. */
const HIDDEN = new Set(['color', 'focus', 'heapdump', 'exit', 'quit', 'vim', 'terminal-setup', 'keybindings', 'statusline']);

/** `/name args` → its parts; undefined when the text isn't a slash command (a path like /src/x isn't one). */
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], args: (m[2] ?? '').trim() } : undefined;
}

const TTL_MS = 5 * 60000;
const FAILED_TTL_MS = 30000;
const PROBE_TIMEOUT_MS = 45000;

/**
 * The slash commands each account's CLI offers in a folder, asked of the CLI itself (they include the user's own
 * commands, skills and plugins, so nothing is hard-coded except Codex's built-ins). Cached for a few minutes.
 */
export class CommandCatalog {
  private cache = new Map<string, { at: number; ttl: number; list: Promise<SlashCommand[]> }>();

  /** Super Agent's own commands, then the CLI's (a CLI command with the same name as ours is ours). */
  list(account: Account, cliPath: string | null, cwd: string): Promise<SlashCommand[]> {
    const key = `${account.id}|${path.resolve(cwd).toLowerCase()}|${account.model ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.list;
    const entry = { at: Date.now(), ttl: TTL_MS, list: Promise.resolve<SlashCommand[]>([]) };
    entry.list = (cliPath ? this.fromCli(account, cliPath, cwd) : Promise.resolve([]))
      .catch((err) => {
        log('commands', `listing ${account.kind} commands failed: ${(err as Error).message}`);
        return [] as SlashCommand[];
      })
      .then((cli) => {
        if (!cli.length) entry.ttl = FAILED_TTL_MS;
        const own = new Set(OWN_COMMANDS.map((c) => c.name));
        const seen = new Set<string>();
        // (A skill whose name has spaces can't be typed as a command: its CLI offers it to the model, not as /name.)
        const usable = (c: SlashCommand) => !!parseCommand(`/${c.name}`) && !own.has(c.name) && !HIDDEN.has(c.name) && !c.name.startsWith('_');
        const fromCli = cli.filter((c) => usable(c) && !seen.has(c.name) && seen.add(c.name));
        return [...OWN_COMMANDS, ...fromCli];
      });
    this.cache.set(key, entry);
    return entry.list;
  }

  /** Forget cached lists (a CLI was updated, or skills changed). */
  clear(): void {
    this.cache.clear();
  }

  private fromCli(account: Account, cliPath: string, cwd: string): Promise<SlashCommand[]> {
    if (account.kind === 'claude') return claudeCommands(account, cliPath, cwd);
    if (account.kind === 'antigravity') return agyCommands(account, cliPath, cwd);
    return codexCommands(account, cliPath, cwd);
  }
}

/** Runs a JSON-lines conversation with a short-lived CLI process until `onLine` returns a result. */
function probe<T>(child: ChildProcess, start: (write: (m: object) => void) => void, onLine: (m: any, write: (m: object) => void) => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const end = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.pid && child.exitCode === null) killTree(child.pid);
      fn();
    };
    const timer = setTimeout(() => end(() => reject(new Error('timed out'))), PROBE_TIMEOUT_MS);
    const write = (m: object) => child.stdin?.write(JSON.stringify(m) + '\n');
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const r = onLine(m, write);
        if (r !== undefined) return end(() => resolve(r));
      }
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', (err) => end(() => reject(err)));
    child.on('close', (code) => end(() => reject(new Error(`exited (${code})`))));
    start(write);
  });
}

/** Claude Code lists every command it can run headless (built-ins, the user's commands, skills, plugins) on `initialize`. */
function claudeCommands(account: Account, cliPath: string, cwd: string): Promise<SlashCommand[]> {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  const child = process.platform === 'win32'
    ? spawn(commandLine(cliPath, args), { cwd, env: accountEnv(account), shell: true, windowsHide: true })
    : spawn(cliPath, args, { cwd, env: accountEnv(account), detached: true });
  return probe(
    child,
    (write) => write({ type: 'control_request', request_id: 'commands', request: { subtype: 'initialize' } }),
    (m) => {
      if (m.type !== 'control_response' || m.response?.request_id !== 'commands') return undefined;
      const r = m.response.response ?? {};
      return ((r.commands ?? []) as any[]).map((c) => ({ name: String(c.name), description: c.description || undefined, hint: c.argumentHint || undefined, source: 'cli' as const }));
    },
  );
}

/** Antigravity announces its commands (built-ins and skills) to an ACP client when a session starts. */
function agyCommands(account: Account, cliPath: string, cwd: string): Promise<SlashCommand[]> {
  const child = spawn(cliPath, ['acp'], { cwd, env: accountEnv(account), windowsHide: true, detached: process.platform !== 'win32' });
  let sessionId: string | undefined;
  return probe(
    child,
    (write) => write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } }),
    (m, write) => {
      if (m.id === 1) write({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
      if (m.id === 2) sessionId = m.result?.sessionId;
      const u = m.method === 'session/update' ? m.params?.update : undefined;
      if (u?.sessionUpdate !== 'available_commands_update') return undefined;
      // Not kept in its conversation list: the probe's session is closed right away.
      if (sessionId) write({ jsonrpc: '2.0', id: 3, method: 'session/close', params: { sessionId } });
      return ((u.availableCommands ?? []) as any[]).map((c) => ({ name: String(c.name), description: c.description || undefined, hint: c.input?.hint || undefined, source: 'cli' as const }));
    },
  );
}

/** Codex: its built-ins that work headless, its skills (from its app-server) and the user's custom prompts. */
async function codexCommands(account: Account, cliPath: string, cwd: string): Promise<SlashCommand[]> {
  const child = process.platform === 'win32'
    ? spawn(commandLine(cliPath, ['app-server']), { cwd, env: accountEnv(account), shell: true, windowsHide: true })
    : spawn(cliPath, ['app-server'], { cwd, env: accountEnv(account), detached: true });
  const skills = await probe<SlashCommand[]>(
    child,
    (write) => write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'super-agent', version: '1' }, capabilities: null } }),
    (m, write) => {
      if (m.id === 1) {
        write({ method: 'initialized' });
        write({ id: 2, method: 'skills/list', params: { cwds: [cwd] } });
      }
      if (m.id !== 2) return undefined;
      const all = ((m.result?.data ?? []) as any[]).flatMap((d) => d.skills ?? []);
      return all.filter((s) => s.enabled !== false).map((s) => ({ name: String(s.name), description: s.interface?.shortDescription ?? s.description ?? undefined, hint: '[what to do]', source: 'cli' as const }));
    },
  ).catch(() => [] as SlashCommand[]);
  return [...CODEX_COMMANDS, ...codexPrompts(account).map((p) => ({ name: p.name, description: p.description, hint: '[arguments]', source: 'cli' as const })), ...skills];
}

/** Codex custom prompts (`<CODEX_HOME>/prompts/*.md`), invoked as /prompts:<name>. */
export function codexPrompts(account: Account): { name: string; description?: string; file: string }[] {
  const dir = path.join(account.home ?? path.join(os.homedir(), '.codex'), 'prompts');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const file = path.join(dir, f);
        const desc = /^---[\s\S]*?^description:\s*(.+)$[\s\S]*?^---/m.exec(fs.readFileSync(file, 'utf8'))?.[1]?.trim().replace(/^["']|["']$/g, '');
        return { name: `prompts:${f.slice(0, -3)}`, description: desc || 'Custom prompt', file };
      });
  } catch {
    return [];
  }
}

/** A custom prompt's text with its arguments filled in ($ARGUMENTS, $1…$9), front matter removed. */
export function expandPrompt(file: string, args: string): string {
  const body = fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?\n---\s*\n?/, '');
  const parts = args.split(/\s+/).filter(Boolean);
  return body.replace(/\$ARGUMENTS/g, args).replace(/\$([1-9])/g, (_m, n: string) => parts[Number(n) - 1] ?? '');
}
