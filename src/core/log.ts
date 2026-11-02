import fs from 'node:fs';
import path from 'node:path';

/**
 * Super Agent's own activity log: what the engine decided and why (threads, scheduling, hand-offs, reports,
 * hot processes, usage checks). One file per day in `<data>/logs/`, kept for a week; also mirrored to a sink
 * (VS Code's "Super Agent" output channel). Silent until configured, so tests stay quiet.
 */
let dir: string | undefined;
let sink: ((line: string) => void) | undefined;
const KEEP_DAYS = 7;

export function configureLog(dataDir: string, mirror?: (line: string) => void): string {
  dir = path.join(dataDir, 'logs');
  sink = mirror;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const f of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, f)).mtimeMs < cutoff) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    /* logging is best effort */
  }
  return file();
}

function file(): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(dir!, `super-agent-${day}.log`);
}

/** `scope`: engine, hot, usage, ext… · `data`: anything extra worth seeing (kept on one line, trimmed). */
export function log(scope: string, message: string, data?: unknown): void {
  if (!dir) return;
  const extra = data === undefined ? '' : ` ${oneLine(data)}`;
  const line = `${new Date().toISOString()} [${scope}] ${message}${extra}`;
  try {
    fs.appendFileSync(file(), line + '\n');
  } catch {
    /* best effort */
  }
  sink?.(line);
}

function oneLine(data: unknown): string {
  let s: string;
  try {
    s = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    s = String(data);
  }
  s = s.replace(/\s+/g, ' ');
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}
