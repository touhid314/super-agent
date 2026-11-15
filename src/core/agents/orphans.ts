import { execFile, execFileSync } from 'node:child_process';
import { log } from '../log';

/**
 * Stops process trees right now, waiting until they're gone. For shutdown: VS Code ends the extension host soon after
 * deactivating, and a kill started in the background (killTree) may never run, leaving agents working on their own.
 */
export function killTreesNow(pids: number[]): void {
  const live = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (!live.length) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', [...live.flatMap((p) => ['/pid', String(p)]), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    } catch {
      /* some were already gone */
    }
    return;
  }
  for (const p of live) {
    try {
      process.kill(-p, 'SIGKILL');
    } catch {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

export interface Proc {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CommandLine: string | null;
}

/** Parse `ps -eo pid=,ppid=,comm=,args=` output into process records (exported for tests). */
export function parsePsOutput(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    procs.push({
      ProcessId: Number(m[1]),
      ParentProcessId: Number(m[2]),
      Name: m[3],
      CommandLine: m[4] || null,
    });
  }
  return procs;
}

/**
 * Agents left running by an earlier VS Code session (it ended without stopping them): they keep working on their own,
 * so a new run in the same conversation would edit the same files at the same time. They are Super Agent's (their
 * command line points into its data folder: config, screenshots, added folders) and whoever started them is gone.
 * Agents of another open VS Code window still have their parent, so they're left alone.
 */
export function killOrphans(dataDir: string): Promise<number> {
  return new Promise((resolve) => {
    const finish = (procs: Proc[]) => {
      const orphans = orphansIn(procs, dataDir, process.pid);
      if (orphans.length) {
        log('hot', 'stopping agents left running by an earlier session', { orphans: orphans.map((p) => ({ pid: p.ProcessId, name: p.Name })) });
        killTreesNow(orphans.map((p) => p.ProcessId));
      }
      resolve(orphans.length);
    };

    if (process.platform === 'win32') {
      const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (err, out) => {
        if (err) return resolve(0);
        try {
          finish(JSON.parse(out) as Proc[]);
        } catch {
          resolve(0);
        }
      });
      return;
    }

    execFile('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (err, out) => {
      if (err) return resolve(0);
      finish(parsePsOutput(out));
    });
  });
}

/** The orphaned Super Agent processes among `procs` (exported for tests). Only the top of each orphaned tree. */
export function orphansIn(procs: Proc[], dataDir: string, self: number, caseInsensitive = process.platform === 'win32'): Proc[] {
  const alive = new Set(procs.map((p) => p.ProcessId));
  const marker = caseInsensitive ? dataDir.toLowerCase() : dataDir;
  const ours = (p: Proc) => {
    if (p.ProcessId === self || !p.CommandLine) return false;
    const cmd = caseInsensitive ? p.CommandLine.toLowerCase() : p.CommandLine;
    return cmd.includes(marker) && /^(cmd|sh|bash|claude|codex|agy|node)(\.exe)?$/i.test(p.Name);
  };
  return procs.filter((p) => ours(p) && (!alive.has(p.ParentProcessId) || (!caseInsensitive && p.ParentProcessId === 1)));
}
