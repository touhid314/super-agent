import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '../types';
import { log } from '../log';
import { CLI_META, commandLine } from './cli';

/**
 * An error that means "this CLI build is too old" (provider-agnostic wording, no versions or messages pinned):
 * "does not support this model; version X or newer is required", "upgrade required", "client is outdated", …
 */
export const OUTDATED =
  /\bversion\b[^\n]{0,60}\b(or newer|or later|or above|is required|required)\b|\b(newer|later) version\b|\b(update|upgrade) (is )?required\b|\btoo old\b|\bout of date\b|\boutdated\b|version_too_old|unsupported (cli |client )?version|\b(run|try) [`'"]?[\w-]+ (update|upgrade)\b/i;

export interface UpdateResult {
  ok: boolean;
  /** Versions before and after (as the CLI prints them), when it reported them. */
  from?: string;
  to?: string;
  error?: string;
}

/**
 * Keeps the agent CLIs current with each CLI's own updater (`<cli> update`: Codex, Claude Code and Antigravity all
 * have one). One update per CLI at a time; `before` stops what would lock the binary, `after` restarts the rest.
 */
export class CliUpdater {
  private running = new Map<AgentKind, Promise<UpdateResult>>();

  constructor(
    private cliPath: (kind: AgentKind) => string | null,
    private hooks: { before?(kind: AgentKind): void; after?(kind: AgentKind, r: UpdateResult): void } = {},
    private platform: NodeJS.Platform = process.platform,
  ) {}

  update(kind: AgentKind): Promise<UpdateResult> {
    let p = this.running.get(kind);
    if (!p) {
      p = this.run(kind).finally(() => this.running.delete(kind));
      this.running.set(kind, p);
    }
    return p;
  }

  private async run(kind: AgentKind): Promise<UpdateResult> {
    const cli = this.cliPath(kind);
    const name = CLI_META[kind].name;
    if (!cli) return { ok: false, error: `${name} is not installed` };
    const from = await version(cli);
    // Installed for all users (e.g. npm -g into root-owned /usr): its updater can only fail without sudo, and the
    // agents would be restarted for nothing (losing their warm start).
    const locked = this.platform !== 'win32' ? notWritable(cli) : undefined;
    if (locked) {
      const error = `${name} is installed in ${locked}, which this user can't write to: update it there yourself (e.g. with sudo)`;
      log('update', `skipped: ${error}`);
      return { ok: false, from, error };
    }
    log('update', `updating ${name} (${from ?? 'version unknown'})`);
    // Windows locks a running program's files, so its agents stop for the update. Elsewhere they keep running and
    // are only replaced when a new version actually arrived.
    const windows = this.platform === 'win32';
    if (windows) this.hooks.before?.(kind);
    let r: UpdateResult;
    try {
      const out = await exec(cli, ['update'], 5 * 60000);
      const to = await version(cli);
      r = { ok: true, from, to };
      log('update', `${name}: ${from === to ? 'already up to date' : `${from} → ${to}`}`, { output: out.slice(-400) });
    } catch (err) {
      r = { ok: false, from, error: (err as Error).message.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) };
      log('update', `${name} update failed: ${r.error}`);
    }
    if (windows || (r.ok && r.from !== r.to)) this.hooks.after?.(kind, r);
    return r;
  }
}

/** The folder a CLI is really installed in (symlinks followed), when this user can't write to it. */
function notWritable(cli: string): string | undefined {
  try {
    const dir = path.dirname(fs.realpathSync(cli));
    fs.accessSync(dir, fs.constants.W_OK);
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EACCES' && (err as NodeJS.ErrnoException).code !== 'EPERM') return undefined;
    try {
      return path.dirname(fs.realpathSync(cli));
    } catch {
      return undefined;
    }
  }
}

function exec(cli: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(commandLine(cli, args), { shell: true, timeout, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(`${stderr || ''}\n${stdout || ''}\n${err.message}`)) : resolve(`${stdout}${stderr}`),
    ),
  );
}

async function version(cli: string): Promise<string | undefined> {
  try {
    return (await exec(cli, ['--version'], 20000)).trim().split(/\r?\n/).pop()?.trim();
  } catch {
    return undefined;
  }
}
