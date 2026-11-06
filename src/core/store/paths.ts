import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

/** Root for all Super-Agent data. Kept short because Windows worktrees hit MAX_PATH quickly. */
export const DATA_DIR = process.env.SUPER_AGENT_HOME || path.join(os.homedir(), '.super-agent');

export const paths = {
  data: DATA_DIR,
  settings: path.join(DATA_DIR, 'settings.json'),
  accounts: path.join(DATA_DIR, 'accounts.json'),
  accountHome: (id: string) => path.join(DATA_DIR, 'accounts', id),
  jobDir: (id: string) => path.join(DATA_DIR, 'jobs', id),
  jobEvents: (id: string) => path.join(DATA_DIR, 'jobs', id, 'events.jsonl'),
  runLog: (jobId: string, runId: string) => path.join(DATA_DIR, 'jobs', jobId, 'logs', `${runId}.log`),
  prompts: (jobId: string) => path.join(DATA_DIR, 'jobs', jobId, 'prompts'),
  worktree: (jobId: string, taskId: string) => path.join(DATA_DIR, 'wt', `${jobId.slice(0, 6)}-${taskId}`),
  jobsRoot: path.join(DATA_DIR, 'jobs'),
};

/**
 * Super Agent's own files for one project folder (hand-offs, live team status, attachments, screenshots): kept here,
 * outside the project, so it stays clean. Every agent is given write access to it (it isn't in their workspace).
 */
export function projectDir(cwd: string, root = DATA_DIR): string {
  const full = path.resolve(cwd);
  const key = process.platform === 'win32' ? full.toLowerCase() : full;
  const name = (path.basename(full) || 'root').replace(/[^\w.-]+/g, '_').slice(0, 40);
  return path.join(root, 'work', `${name}-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`);
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic-ish JSON write: write a temp file then rename over the target. */
export function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
