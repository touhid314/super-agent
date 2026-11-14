import { exec } from 'node:child_process';
import type { AgentKind } from '../types';
import { log } from '../log';
import { CLI_META, installCommand } from './cli';

/** How one CLI's install went; `error`: the last lines it printed, to show the user. */
export interface InstallResult {
  kind: AgentKind;
  ok: boolean;
  error?: string;
}

/** Installers download tens of MB; slow connections need a while. */
const INSTALL_TIMEOUT_MS = 10 * 60000;

/**
 * Installs the given agent CLIs in the background (no window), all at once: each uses its maker's own installer
 * (see installCommand). `installed` says afterwards whether a CLI can now be found, which is what counts: an installer
 * can exit with an error after the CLI itself is in place (e.g. a failed PATH update), or the other way round.
 */
export async function installClis(
  kinds: AgentKind[],
  installed: (kind: AgentKind) => boolean,
  run: (command: string, timeoutMs: number) => Promise<string> = runHidden,
): Promise<InstallResult[]> {
  return Promise.all(
    kinds.map(async (kind): Promise<InstallResult> => {
      const name = CLI_META[kind].name;
      log('install', `installing ${name}`);
      let error: string | undefined;
      try {
        await run(installCommand(kind), INSTALL_TIMEOUT_MS);
      } catch (err) {
        error = lastLines((err as Error).message);
      }
      const ok = installed(kind);
      log('install', `${name}: ${ok ? 'installed' : `not installed${error ? ` (${error})` : ''}`}`);
      return ok ? { kind, ok } : { kind, ok, error: error ?? `${name} was not found after its installer finished.` };
    }),
  );
}

function runHidden(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) =>
    exec(command, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${stdout}\n${stderr}\n${err.message}`)) : resolve(`${stdout}${stderr}`),
    ),
  );
}

/** The useful end of an installer's output (PowerShell errors are long). */
function lastLines(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(At line|\+ |CategoryInfo|FullyQualifiedErrorId)/.test(l));
  return lines.slice(-2).join(' ').slice(0, 300);
}
