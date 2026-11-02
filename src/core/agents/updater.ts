import { execFile } from 'node:child_process';
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
    log('update', `updating ${name} (${from ?? 'version unknown'})`);
    this.hooks.before?.(kind);
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
    this.hooks.after?.(kind, r);
    return r;
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
