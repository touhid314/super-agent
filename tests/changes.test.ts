import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChangeTracker, UNDO_TURNS } from '../src/engine/changes';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-changes-'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(ws, 'sub', 'd.txt'), 'x\n');
  fs.writeFileSync(path.join(ws, '.gitignore'), '*.log\n');
  return { root, ws, tracker: new ChangeTracker(path.join(root, 'data')) };
}
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

describe('ChangeTracker', () => {
  it('reports per-file +/- for a turn, ignoring .gitignore files and our own folder', async () => {
    const { ws, tracker } = setup();
    const before = (await tracker.snapshot(ws))!;
    fs.writeFileSync(path.join(ws, 'a.txt'), 'a\nB\nc\nd\n');
    fs.rmSync(path.join(ws, 'sub', 'd.txt'));
    fs.writeFileSync(path.join(ws, 'n.txt'), 'new\n');
    fs.writeFileSync(path.join(ws, 'x.log'), 'ignored\n');
    fs.mkdirSync(path.join(ws, '.super-agent'));
    fs.writeFileSync(path.join(ws, '.super-agent', 'team.md'), 'ours\n');
    const c = (await tracker.diff(ws, before))!;
    expect(c.files).toEqual([
      { path: 'a.txt', add: 2, del: 1 },
      { path: 'n.txt', add: 1, del: 0 },
      { path: 'sub/d.txt', add: 0, del: 1 },
    ]);
  }, 30000);

  it('reports nothing when nothing changed', async () => {
    const { ws, tracker } = setup();
    const before = (await tracker.snapshot(ws))!;
    expect(await tracker.diff(ws, before)).toBeUndefined();
  }, 30000);

  it('undoes and redoes a turn exactly', async () => {
    const { ws, tracker } = setup();
    const before = (await tracker.snapshot(ws))!;
    fs.writeFileSync(path.join(ws, 'a.txt'), 'changed\n');
    fs.rmSync(path.join(ws, 'sub', 'd.txt'));
    fs.writeFileSync(path.join(ws, 'n.txt'), 'new\n');
    const c = (await tracker.diff(ws, before))!;
    expect(await tracker.undo(ws, c)).toBeUndefined();
    expect([read(path.join(ws, 'a.txt')), read(path.join(ws, 'sub', 'd.txt')), read(path.join(ws, 'n.txt'))]).toEqual(['a\nb\nc\n', 'x\n', null]);
    expect(await tracker.undo(ws, c, true)).toBeUndefined();
    expect([read(path.join(ws, 'a.txt')), read(path.join(ws, 'sub', 'd.txt')), read(path.join(ws, 'n.txt'))]).toEqual(['changed\n', null, 'new\n']);
  }, 30000);

  it('refuses to undo over later edits, changing no file', async () => {
    const { ws, tracker } = setup();
    const before = (await tracker.snapshot(ws))!;
    fs.writeFileSync(path.join(ws, 'a.txt'), 'turn\n');
    fs.writeFileSync(path.join(ws, 'n.txt'), 'new\n');
    const c = (await tracker.diff(ws, before))!;
    fs.writeFileSync(path.join(ws, 'a.txt'), 'edited later\n');
    expect(await tracker.undo(ws, c)).toMatch(/changed since/);
    expect([read(path.join(ws, 'a.txt')), read(path.join(ws, 'n.txt'))]).toEqual(['edited later\n', 'new\n']);
  }, 30000);

  it('keeps only the last UNDO_TURNS turns, and deletes older snapshots', async () => {
    const { ws, tracker } = setup();
    const turns = [];
    for (let i = 0; i < UNDO_TURNS + 2; i++) {
      const before = (await tracker.snapshot(ws))!;
      fs.writeFileSync(path.join(ws, 'a.txt'), `turn ${i}\n`);
      turns.push((await tracker.diff(ws, before))!);
    }
    const kept = await Promise.all(turns.map((c) => tracker.has(ws, c)));
    expect(kept).toEqual([false, false, ...Array(UNDO_TURNS).fill(true)]);
    expect(await tracker.undo(ws, turns.at(-1)!)).toBeUndefined();
    expect(read(path.join(ws, 'a.txt'))).toBe(`turn ${UNDO_TURNS}\n`);
  }, 60000);

  it("keeps a running turn's starting snapshot while other turns end", async () => {
    const { ws, tracker } = setup();
    const long = (await tracker.snapshot(ws))!;
    for (let i = 0; i < UNDO_TURNS + 1; i++) {
      const before = (await tracker.snapshot(ws))!;
      fs.writeFileSync(path.join(ws, 'a.txt'), `other ${i}\n`);
      await tracker.diff(ws, before);
    }
    fs.writeFileSync(path.join(ws, 'n.txt'), 'new\n');
    const c = (await tracker.diff(ws, long))!;
    expect(String(await tracker.before(ws, c, 'a.txt'))).toBe('a\nb\nc\n');
  }, 60000);

  it('shows a file as it was before the turn', async () => {
    const { ws, tracker } = setup();
    const before = (await tracker.snapshot(ws))!;
    fs.writeFileSync(path.join(ws, 'sub', 'd.txt'), 'y\n');
    const c = (await tracker.diff(ws, before))!;
    expect(String(await tracker.before(ws, c, 'sub/d.txt'))).toBe('x\n');
  }, 30000);
});

describe('ChangeTracker on a workspace too big to snapshot', () => {
  it('skips tracking at once (no git copy), and remembers it across restarts', async () => {
    const { root, ws } = setup();
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(ws, `f${i}.txt`), 'x');
    const data = path.join(root, 'data');
    const tracker = new ChangeTracker(data, { files: 10, bytes: 1e9, ms: 3000 });
    const t0 = Date.now();
    expect(await tracker.snapshot(ws)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2000);
    const store = fs.readdirSync(path.join(data, 'snapshots'));
    expect(store.filter((n) => n.endsWith('.skip'))).toHaveLength(1);
    expect(store.filter((n) => !n.endsWith('.skip'))).toHaveLength(0); // nothing copied
    // A new process (VS Code reload) doesn't try again either, even with generous limits.
    expect(await new ChangeTracker(data).snapshot(ws)).toBeUndefined();
  }, 30000);

  it('counts bytes too, and only what git would take in a repo (its .gitignore applies)', async () => {
    const { root, ws } = setup();
    fs.writeFileSync(path.join(ws, 'big.bin'), Buffer.alloc(3000));
    expect(await new ChangeTracker(path.join(root, 'd1'), { files: 1000, bytes: 2000, ms: 3000 }).snapshot(ws)).toBeUndefined();
    const repo = setup();
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: repo.ws });
    fs.writeFileSync(path.join(repo.ws, 'data.log'), Buffer.alloc(3000)); // *.log is ignored by the repo
    expect(await new ChangeTracker(path.join(repo.root, 'd2'), { files: 1000, bytes: 2000, ms: 3000 }).snapshot(repo.ws)).toBeTruthy();
  }, 30000);
});
