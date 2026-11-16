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
/** A workspace found too big to track is not tried again for this long (it rarely shrinks). */
const SKIP_MS = 24 * 3600 * 1000;
/**
 * Before the first snapshot of a workspace: if it has more files or bytes than this (or merely counting takes longer),
 * change tracking is off for it. A snapshot copies every file into the store, so a huge workspace (a home folder, a
 * dataset drive) would delay every turn by the whole timeout and fill the disk with partial copies.
 */
export const TRACK_LIMITS = { files: 100_000, bytes: 1024 ** 3, ms: 3000 };
const SKIP_DIRS = new Set(EXCLUDE.filter((e) => e.endsWith('/')).map((e) => e.slice(0, -1)));
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

  /** Workspaces not tracked (too big, or snapshots failed), until when. */
  private skip = new Map<string, number>();

  constructor(
    private dataDir: string,
    private limits = TRACK_LIMITS,
  ) {}

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
    if (this.skipped(cwd)) return undefined;
    try {
      // The first snapshot copies everything; later ones only what changed. So size up a workspace until one worked
      // (a store left by snapshots that never finished, from before this check, is sized up and cleared too).
      const ok = path.join(this.gitDir(cwd), 'sa-ok');
      if (!fs.existsSync(ok)) {
        const tooBig = await this.tooBig(cwd);
        if (tooBig) {
          this.markSkip(cwd, tooBig);
          return undefined;
        }
      }
      await this.init(cwd);
      await this.git(cwd, ['add', '-A', '--ignore-errors'], SNAPSHOT_TIMEOUT_MS);
      const tree = (await this.git(cwd, ['write-tree'])).trim();
      if (!fs.existsSync(ok)) fs.writeFileSync(ok, '');
      return tree;
    } catch (err) {
      // Not retried every turn: a failing snapshot (usually the timeout) would delay each turn just the same.
      this.markSkip(cwd, `snapshot failed: ${(err as Error).message.split('\n')[0]}`);
      return undefined;
    }
  }

  /** Whether change tracking is off for this workspace (remembered across restarts). */
  private skipped(cwd: string): boolean {
    let until = this.skip.get(cwd);
    if (until === undefined) {
      try {
        until = Number(JSON.parse(fs.readFileSync(this.gitDir(cwd) + '.skip', 'utf8')).until) || 0;
      } catch {
        until = 0;
      }
      this.skip.set(cwd, until);
    }
    return until > Date.now();
  }

  private markSkip(cwd: string, reason: string): void {
    const until = Date.now() + SKIP_MS;
    this.skip.set(cwd, until);
    log('changes', `change tracking off for ${cwd} for 24 h: ${reason}`);
    try {
      fs.mkdirSync(path.dirname(this.gitDir(cwd)), { recursive: true });
      fs.writeFileSync(this.gitDir(cwd) + '.skip', JSON.stringify({ until, reason }));
      // Partial copies from a snapshot that never finished are dead weight.
      fs.rmSync(this.gitDir(cwd), { recursive: true, force: true });
    } catch {
      /* remembered in memory at least */
    }
  }

  /** Why the workspace is too big to snapshot, or undefined. Stops counting as soon as a limit is passed. */
  private async tooBig(cwd: string): Promise<string | undefined> {
    const { files: maxFiles, bytes: maxBytes, ms } = this.limits;
    const deadline = Date.now() + ms;
    let files = 0;
    let bytes = 0;
    // A git repo: exactly the files a snapshot would take (its .gitignore applies), listed by git itself.
    if (fs.existsSync(path.join(cwd, '.git'))) {
      const list = await new Promise<string[] | undefined>((resolve) =>
        execFile('git', ['-C', cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeout: ms, windowsHide: true, maxBuffer: 512 * 1024 * 1024 }, (err, out) =>
          resolve(err ? undefined : String(out).split('\0').filter(Boolean)),
        ),
      );
      if (list) {
        if (list.length > maxFiles) return `more than ${maxFiles} files`;
        for (const f of list) {
          if (Date.now() > deadline) return `more than ${ms / 1000} s just to size its files`;
          try {
            bytes += (await fs.promises.stat(path.join(cwd, f))).size;
          } catch {
            /* deleted but still in the index */
          }
          if (bytes > maxBytes) return `more than ${Math.round(maxBytes / 1024 ** 3)} GB of files`;
        }
        return undefined;
      }
    }
    const stack = [cwd];
    while (stack.length) {
      if (Date.now() > deadline) return `more than ${ms / 1000} s just to list its files`;
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable: git skips it too (--ignore-errors)
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) stack.push(p);
        } else if (e.isFile()) {
          if (++files > maxFiles) return `more than ${maxFiles} files`;
          try {
            bytes += (await fs.promises.stat(p)).size;
          } catch {
            /* vanished or unreadable */
          }
          if (bytes > maxBytes) return `more than ${Math.round(maxBytes / 1024 ** 3)} GB of files`;
        }
      }
    }
    return undefined;
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
