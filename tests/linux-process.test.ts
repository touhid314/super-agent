import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cancelAll, cancelRun, runAgent, type RunRequest } from '../src/core/agents/runner';

const dirs: string[] = [];
afterEach(() => {
  cancelAll();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function request(script: string): RunRequest {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-linux-$literal-'quote-"));
  dirs.push(dir);
  const cli = path.join(dir, 'fake cli');
  fs.writeFileSync(cli, `#!/usr/bin/env node\n${script}`, { mode: 0o700 });
  return {
    runId: path.basename(dir), account: { id: 'linux', kind: 'codex', label: 'Linux smoke', home: dir, role: 'master', createdAt: 0 },
    cliPath: cli, mode: 'write', autonomy: 'standard', cwd: dir,
    prompt: 'test stdin', logFile: path.join(dir, 'run.log'), timeoutMs: 5000, onText: () => undefined,
  };
}

describe('native Linux agent processes', () => {
  it.runIf(process.platform === 'linux')('runs executables with literal paths and sends the prompt on stdin', async () => {
    const req = request(`
      const fs = require('node:fs');
      let input = '';
      process.stdin.on('data', b => input += b);
      process.stdin.on('end', () => {
        const args = process.argv.slice(2);
        const out = args[args.indexOf('-o') + 1];
        fs.writeFileSync(out, JSON.stringify({ input, cwd: process.cwd(), home: process.env.CODEX_HOME }));
      });
    `);
    const result = await runAgent(req);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.finalText)).toEqual({ input: 'test stdin', cwd: req.cwd, home: req.account.home });
  });

  it.runIf(process.platform === 'linux')('cancels the process group including a child holding output pipes open', async () => {
    const req = request(`
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      console.log('READY');
      setInterval(() => {}, 1000);
    `);
    req.onText = (text) => { if (text.includes('READY')) cancelRun(req.runId); };
    const result = await runAgent(req);
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});
