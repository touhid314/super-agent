import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../core/log';
import type { RunChanges } from './types';

/** How long a snapshot may take before the turn goes ahead without change tracking. */
const SNAPSHOT_TIMEOUT_MS = 20000;
/** Never tracked: our own files, VCS folders, and dependency/build folders a .gitignore usually covers anyway. */
const EXCLUDE = ['.super-agent/', '.git/', '.hg/', '.svn/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.DS_Store'];
/** How many of a workspace's most recent turns (across all its threads) stay undoable; older snapshots are deleted. */
export const UNDO_TURNS = 3;
/** A turn's starting snapshot that never got its end (extension closed mid-turn) is dropped after this long. */
const PENDING_MAX_MS = 24 * 3600 * 1000;
const PENDING = 'refs/sa/pending/';
const TURNS = 'refs/sa/turns/';

/**
 * What each turn changed in the workspace, and undoing it. A hidden git store per workspace
 * (`<dataDir>/snapshots/<hash>`, never the workspace's own .git) records the files before and after a turn;
 * the workspace's .gitignore files are respected. Undo applies the turn's diff in reverse, and refuses when a file
 * has changed since, instead of overwriting newer work.
 *
 * The store only keeps what's still needed: refs pin the starting snapshot of each running turn and the before/after
 * of the last UNDO_TURNS turns; everything else is pruned when a turn ends, so the store stays small.
 */
export class ChangeTracker {
  /** One git command at a time per workspace (they share an index). */
  private locks = new Map<string, Promise<unknown>>();

  constructor(private dataDir: string) {}

  /** A turn is starting: the workspace's current files, as a tree id; undefined if it can't be taken (no git, too big, …). */
  snapshot(cwd: string): Promise<string | undefined> {
    return this.serial(cwd, async () => {
      const tree = await this.take(cwd);
      if (tree) await this.refs(cwd, [`create ${PENDING}${Date.now()}-${tree} ${tree}`]).catch(() => undefined);
      return tree;
    });
  }

  /** The turn that started at `before` ended: what changed in the workspace since; undefined when nothing did. */
  diff(cwd: string, before: string): Promise<RunChanges | undefined> {
    return this.serial(cwd, async () => {
      const after = await this.take(cwd);
      const out = after && after !== before ? await this.git(cwd, ['diff', '--numstat', '--no-renames', before, after]).catch(() => '') : '';
      const files = out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [add, del, ...p] = l.split('\t');
          const binary = add === '-';
          return { path: p.join('\t'), add: binary ? 0 : Number(add), del: binary ? 0 : Number(del), ...(binary ? { binary } : {}) };
        });
      const changed = after && files.length ? { before, after, files } : undefined;
      await this.retire(cwd, before, changed);
      return changed;
    });
  }

  /** Whether a turn's snapshots are still kept (only the last UNDO_TURNS turns of a workspace are). */
  has(cwd: string, c: RunChanges): Promise<boolean> {
    return this.serial(cwd, () =>
      this.git(cwd, ['cat-file', '-e', `${c.before}^{tree}`])
        .then(() => this.git(cwd, ['cat-file', '-e', `${c.after}^{tree}`]))
        .then(
          () => true,
          () => false,
        ),
    );
  }

  /**
   * Reverts a turn's changes (`redo`: puts them back). All or nothing: returns an error message, and changes no file,
   * when a file has changed since in a way that conflicts.
   */
  undo(cwd: string, c: RunChanges, redo = false): Promise<string | undefined> {
    const what = redo ? 'redo' : 'undo';
    return this.serial(cwd, async () => {
      try {
        const patch = await this.git(cwd, ['diff', '--binary', '--no-renames', c.before, c.after], 30000, undefined, true);
        const args = ['apply', ...(redo ? [] : ['-R']), '--whitespace=nowarn'];
        await this.git(cwd, [...args, '--check', '-'], 30000, patch);
        await this.git(cwd, [...args, '-'], 30000, patch);
        log('changes', `${what}: ${c.files.length} file(s) in ${cwd}`);
        return undefined;
      } catch (err) {
        log('changes', `${what} refused in ${cwd}: ${(err as Error).message.split('\n')[0]}`);
        return `Some of these files have changed since, so ${what} was not applied (no file was changed).`;
      }
    });
  }

  /** A file's content before the turn (for the diff view); undefined if it didn't exist. */
  before(cwd: string, c: RunChanges, file: string): Promise<Buffer | undefined> {
    return this.serial(cwd, () => this.git(cwd, ['show', `${c.before}:${file.replace(/\\/g, '/')}`], 30000, undefined, true).then((b) => b as unknown as Buffer).catch(() => undefined));
  }

  private async take(cwd: string): Promise<string | undefined> {
    try {
      await this.init(cwd);
      await this.git(cwd, ['add', '-A', '--ignore-errors'], SNAPSHOT_TIMEOUT_MS);
      return (await this.git(cwd, ['write-tree'])).trim();
    } catch (err) {
      log('changes', `snapshot failed in ${cwd}: ${(err as Error).message.split('\n')[0]}`);
      return undefined;
    }
  }

  /**
   * A turn ended: unpin its starting snapshot (and stale ones), pin its before/after if it changed anything,
   * unpin turns beyond the last UNDO_TURNS, and delete every snapshot no longer pinned.
   */
  private async retire(cwd: string, before: string, turn?: RunChanges): Promise<void> {
    try {
      const now = Date.now();
      const refs = (await this.git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/sa/'])).split('\n').filter(Boolean);
      const pending = refs.filter((r) => r.startsWith(PENDING));
      const mine = pending.find((r) => r.endsWith(`-${before}`));
      const ops = pending.filter((r) => r === mine || now - parseInt(r.slice(PENDING.length), 10) > PENDING_MAX_MS).map((r) => `delete ${r}`);
      const turns = [...new Set(refs.filter((r) => r.startsWith(TURNS)).map((r) => r.slice(0, r.lastIndexOf('/'))))].sort();
      if (turn) {
        const id = `${TURNS}${now}-${turn.after.slice(0, 8)}`;
        ops.push(`create ${id}/before ${turn.before}`, `create ${id}/after ${turn.after}`);
        turns.push(id);
      }
      for (const t of turns.slice(0, Math.max(0, turns.length - UNDO_TURNS))) ops.push(`delete ${t}/before`, `delete ${t}/after`);
      if (ops.length) await this.refs(cwd, ops);
      // Objects still in the index (the files as they are now) are kept too, so the next snapshot is quick.
      await this.git(cwd, ['prune', '--expire=now'], 120000);
    } catch (err) {
      log('changes', `cleanup failed in ${cwd}: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  private refs(cwd: string, ops: string[]): Promise<string> {
    return this.git(cwd, ['update-ref', '--stdin'], 30000, ops.join('\n') + '\n');
  }

  private gitDir(cwd: string): string {
    const key = crypto.createHash('sha1').update(path.resolve(cwd).toLowerCase()).digest('hex').slice(0, 16);
    return path.join(this.dataDir, 'snapshots', key);
  }

  private async init(cwd: string): Promise<void> {
    const dir = this.gitDir(cwd);
    if (fs.existsSync(path.join(dir, 'HEAD'))) return;
    fs.mkdirSync(dir, { recursive: true });
    await this.git(cwd, ['init', '-q']);
    fs.mkdirSync(path.join(dir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'info', 'exclude'), EXCLUDE.join('\n') + '\n');
  }

  private serial<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const key = this.gitDir(cwd);
    const next = (this.locks.get(key) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  /** `raw`: stdout as a Buffer (exact bytes), typed as string for the common case. */
  private git(cwd: string, args: string[], timeout = 30000, input?: string | Buffer, raw = false): Promise<string> {
    const full = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.longpaths=true', '-c', 'core.quotepath=false', `--git-dir=${this.gitDir(cwd)}`, `--work-tree=${cwd}`, ...args];
    return new Promise((resolve, reject) => {
      const child = execFile('git', full, { cwd, timeout, windowsHide: true, maxBuffer: 256 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${String(stderr) || err.message}`));
        else resolve(stdout as unknown as string);
      });
      if (input !== undefined) child.stdin?.end(input);
    });
  }
}
