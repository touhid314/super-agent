import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountService } from '../src/core/agents/accounts';
import { AccountPool } from '../src/core/agents/pool';
import type { Account } from '../src/core/types';
import { sharesLogin } from '../src/core/store/config';

describe('signing an account out', () => {
  it.runIf(process.platform === 'win32')("runs the CLI's own logout in that account's folder only, and keeps the account listed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-acc-'));
    // A codex "CLI": `logout` deletes auth.json from the folder it's pointed at (CODEX_HOME), like the real one.
    const cli = path.join(dir, 'codex.cmd');
    fs.writeFileSync(cli, '@if "%1"=="logout" del "%CODEX_HOME%\\auth.json"\r\n');
    const homes = ['one', 'two'].map((n) => path.join(dir, n));
    for (const h of homes) {
      fs.mkdirSync(h);
      fs.writeFileSync(path.join(h, 'auth.json'), '{"tokens":{}}');
    }
    const accounts: Account[] = homes.map((home, i) => ({ id: `c${i}`, kind: 'codex', label: `Codex ${i}`, home, role: 'worker', createdAt: 0 }));
    const pool = new AccountPool();
    const service = new AccountService({ accounts, settings: { cliPaths: {} }, account: (id: string) => accounts.find((a) => a.id === id) } as never, pool);
    service.clis = [{ kind: 'codex', path: cli } as never];

    await service.signOut('c0');
    expect(fs.existsSync(path.join(homes[0], 'auth.json'))).toBe(false);
    expect(fs.existsSync(path.join(homes[1], 'auth.json'))).toBe(true); // the other account stays signed in
    expect(pool.get('c0').login).toBe('signed-out');
    expect(accounts.map((a) => a.id)).toEqual(['c0', 'c1']); // still listed, ready to sign in again
  });
});

describe('shared logins', () => {
  const data = path.join(os.tmpdir(), 'sa-data');
  const acc = (kind: Account['kind'], home: string | null): Account => ({ id: 'a', kind, label: 'a', home, role: 'worker', createdAt: 0 });

  it("treats only folders Super Agent created as an account's own login", () => {
    expect(sharesLogin(acc('claude', path.join(data, 'accounts', 'x')), data)).toBe(false);
    expect(sharesLogin(acc('claude', null), data)).toBe(true); // the CLI's default ~/.claude
    expect(sharesLogin(acc('codex', path.join(os.homedir(), '.codex-acct2')), data)).toBe(true);
    expect(sharesLogin(acc('claude', data), data)).toBe(true); // the data folder itself isn't an account folder
    expect(sharesLogin(acc('claude', `${data}-other`), data)).toBe(true); // a look-alike path
    expect(sharesLogin(acc('antigravity', null), data)).toBe(false); // one login per PC: nothing to isolate
  });
});
