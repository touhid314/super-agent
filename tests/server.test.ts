import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireServerLock, serverOptions } from '../src/server';

const dirs: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-server-')); dirs.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('server startup validation', () => {
  it('shows help without requiring a workspace or token', () => {
    expect(serverOptions(['--help'], {})).toBeUndefined();
  });
  it('requires an existing absolute directory and token without exposing its value', () => {
    const dir = temp();
    expect(() => serverOptions(['--workspace', 'relative'], {})).toThrow('absolute');
    expect(() => serverOptions(['--workspace', dir], {})).toThrow('SUPER_AGENT_TELEGRAM_TOKEN');
    expect(() => serverOptions(['--workspace', dir], { SUPER_AGENT_TELEGRAM_TOKEN: 'private-invalid-secret' })).toThrow('Set SUPER_AGENT');
    expect(serverOptions(['--workspace', dir], { SUPER_AGENT_TELEGRAM_TOKEN: '123456:example_token' })).toEqual({ workspace: fs.realpathSync(dir), token: '123456:example_token' });
    const file = path.join(dir, 'file'); fs.writeFileSync(file, '');
    expect(() => serverOptions(['--workspace', file], { SUPER_AGENT_TELEGRAM_TOKEN: '123:token' })).toThrow('directory');
    expect(() => serverOptions(['--workspace', dir, '--unknown'], {})).toThrow('Provide --workspace');
  });
});

describe('server ownership lock', () => {
  it('rejects a second engine and releases ownership idempotently', () => {
    const dir = temp();
    const release = acquireServerLock(dir);
    expect(() => acquireServerLock(dir)).toThrow('already owns');
    release(); release();
    const again = acquireServerLock(dir); again();
    expect(fs.existsSync(path.join(dir, 'server.lock'))).toBe(false);
  });
  it('recovers a dead owner and never removes a replacement lock on release', () => {
    const dir = temp(); const file = path.join(dir, 'server.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: 99999999 }));
    const actualKill = process.kill;
    vi.spyOn(process, 'kill').mockImplementation(((pid, signal) => {
      if (pid === 99999999) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return actualKill(pid, signal);
    }) as typeof process.kill);
    const release = acquireServerLock(dir);
    fs.writeFileSync(file, 'replacement'); release();
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
  });
  it('treats denied process probes and unreadable locks as owned', () => {
    const dir = temp(); const file = path.join(dir, 'server.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: 123 }));
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(() => acquireServerLock(dir)).toThrow('already owns');
    fs.writeFileSync(file, 'in progress');
    expect(() => acquireServerLock(dir)).toThrow('unreadable');
  });
});
