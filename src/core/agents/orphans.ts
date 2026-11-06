import { execFile, execFileSync } from 'node:child_process';
import { log } from '../log';

/**
 * Stops process trees right now, waiting until they're gone. For shutdown: VS Code ends the extension host soon after
 * deactivating, and a kill started in the background (killTree) may never run, leaving agents working on their own.
 */
export function killTreesNow(pids: number[]): void {
  const live = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (!live.length || process.platform !== 'win32') return;
  try {
    execFileSync('taskkill', [...live.flatMap((p) => ['/pid', String(p)]), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  } catch {
    /* some were already gone */
  }
}

interface Proc {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CommandLine: string | null;
}

/**
 * Agents left running by an earlier VS Code session (it ended without stopping them): they keep working on their own,
 * so a new run in the same conversation would edit the same files at the same time. They are Super Agent's (their
 * command line points into its data folder: config, screenshots, added folders) and whoever started them is gone.
 * Agents of another open VS Code window still have their parent, so they're left alone.
 */
export function killOrphans(dataDir: string): Promise<number> {
  if (process.platform !== 'win32') return Promise.resolve(0);
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (err, out) => {
      if (err) return resolve(0);
      let procs: Proc[] = [];
      try {
        procs = JSON.parse(out) as Proc[];
      } catch {
        return resolve(0);
      }
      const orphans = orphansIn(procs, dataDir, process.pid);
      if (orphans.length) {
        log('hot', 'stopping agents left running by an earlier session', { orphans: orphans.map((p) => ({ pid: p.ProcessId, name: p.Name })) });
        killTreesNow(orphans.map((p) => p.ProcessId));
      }
      resolve(orphans.length);
    });
  });
}

/** The orphaned Super Agent processes among `procs` (exported for tests). Only the top of each orphaned tree. */
export function orphansIn(procs: Proc[], dataDir: string, self: number): Proc[] {
  const alive = new Set(procs.map((p) => p.ProcessId));
  const marker = dataDir.toLowerCase();
  const ours = (p: Proc) => p.ProcessId !== self && !!p.CommandLine && p.CommandLine.toLowerCase().includes(marker) && /^(cmd|claude|codex|agy|node)\.exe$/i.test(p.Name);
  return procs.filter((p) => ours(p) && !alive.has(p.ParentProcessId));
}
