import { afterEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildArgs } from '../src/core/agents/cli';
import { RATE_LIMIT, describeTool, errorOf } from '../src/core/agents/runner';
import { OUTDATED } from '../src/core/agents/updater';

vi.mock('node:child_process', { spy: true });

const base = { kind: 'antigravity' as const, cwd: 'C:/p', lastMessageFile: 'x' };

describe('platform-specific CLI support', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function onPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    vi.resetModules();
    return import('../src/core/agents/cli');
  }

  it.each(['win32', 'linux', 'darwin'] as const)('uses official installers on %s', async (platform) => {
    const { INSTALL_SCRIPT, installCommand } = await onPlatform(platform);
    const urls = {
      codex: 'https://chatgpt.com/codex/install',
      claude: 'https://claude.ai/install',
      antigravity: 'https://antigravity.google/cli/install',
    };
    for (const kind of ['codex', 'claude', 'antigravity'] as const) {
      const url = `${urls[kind]}.${platform === 'win32' ? 'ps1' : 'sh'}`;
      expect(INSTALL_SCRIPT[kind]).toBe(url);
      expect(installCommand(kind)).toBe(platform === 'win32'
        ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${url} | iex"`
        : `curl -fsSL ${url} | bash`);
    }
  });

  it.each(['linux', 'darwin'] as const)('discovers extensionless executables and probes them directly on %s', async (platform) => {
    const { resolveCli } = await onPlatform(platform);
    const exec = vi.spyOn(childProcess, 'execFileSync').mockReturnValueOnce('/missing/codex\n/opt/my tools/codex\n').mockReturnValueOnce('notice\ncodex 1.0\n');
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => file === '/opt/my tools/codex');
    expect(resolveCli('codex')).toEqual({ kind: 'codex', path: '/opt/my tools/codex', version: 'codex 1.0' });
    expect(exec).toHaveBeenNthCalledWith(1, 'which', ['-a', 'codex'], expect.any(Object));
    expect(exec).toHaveBeenNthCalledWith(2, '/opt/my tools/codex', ['--version'], { encoding: 'utf8', timeout: 20000 });
  });

  it('preserves Windows launcher filtering and cmd version probes', async () => {
    const { resolveCli } = await onPlatform('win32');
    const exec = vi.spyOn(childProcess, 'execFileSync').mockReturnValueOnce('C:/tools/codex\r\nC:/my tools/codex.cmd\r\n').mockReturnValueOnce('codex 1.0\r\n');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(resolveCli('codex').path).toBe('C:/my tools/codex.cmd');
    expect(exec).toHaveBeenNthCalledWith(1, 'where.exe', ['codex'], expect.any(Object));
    expect(exec).toHaveBeenNthCalledWith(2, '"C:/my tools/codex.cmd" --version', { encoding: 'utf8', shell: 'cmd.exe', windowsHide: true, timeout: 20000 });
  });

  it.each(['codex', 'claude', 'antigravity'] as const)('checks all Unix fallback locations for %s', async (kind) => {
    const { resolveCli, CLI_META } = await onPlatform('linux');
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => { throw new Error('not on PATH'); });
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(resolveCli(kind)).toEqual({ kind, path: null, version: undefined });
    const bin = CLI_META[kind].bin;
    expect(exists.mock.calls.map(([file]) => file)).toEqual([
      path.join(os.homedir(), '.local', 'bin', bin), `/usr/local/bin/${bin}`, `/usr/bin/${bin}`, path.join(os.homedir(), '.npm-global', 'bin', bin),
    ]);
  });

  it('prefers an explicit override and tolerates a failed version probe', async () => {
    const { resolveCli } = await onPlatform('linux');
    vi.spyOn(childProcess, 'execFileSync').mockReturnValueOnce('/usr/bin/codex\n').mockImplementationOnce(() => { throw new Error('version unavailable'); });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(resolveCli('codex', '/custom/codex')).toEqual({ kind: 'codex', path: '/custom/codex', version: undefined });
  });

  it.each(['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'])('launches the detected Unix browser executable at %s', async (installed) => {
    const { browserServer, PLAYWRIGHT_MCP } = await onPlatform('linux');
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => file === installed);
    expect(browserServer('/tmp/browser output')).toEqual({ command: 'npx', args: ['-y', PLAYWRIGHT_MCP, '--isolated', '--headless', '--executable-path', installed, '--output-dir', '/tmp/browser output'] });
  });

  it('quotes Unix command arguments literally, including expansion and shell operators', async () => {
    const { commandLine, quote } = await onPlatform('linux');
    expect(quote('')).toBe("''");
    expect(quote("it's $HOME `id` $(id); & | > < \\\nnext")).toBe("'it'\"'\"'s $HOME `id` $(id); & | > < \\\nnext'");
    expect(commandLine('/opt/my tools/claude', ['', "it's", '$HOME', '`id`', '$(id)'])).toBe("'/opt/my tools/claude' '' 'it'\"'\"'s' '$HOME' '`id`' '$(id)'");
  });

  it('preserves Windows cmd quoting for spaces and metacharacters', async () => {
    const { commandLine, quote } = await onPlatform('win32');
    expect(quote('plain')).toBe('plain');
    expect(quote('my tools/claude.cmd')).toBe('"my tools/claude.cmd"');
    expect(quote('say "hi" & echo')).toBe('"say \\"hi\\" & echo"');
    expect(commandLine('C:/my tools/claude.cmd', ['--model', 'claude-sonnet-4'])).toBe('"C:/my tools/claude.cmd" --model claude-sonnet-4');
  });

  it('spawns hot agents directly with detached process groups on Unix and preserves Windows shell spawning', async () => {
    const { EventEmitter } = await import('node:events');
    const fakeChild = () => {
      const c = new EventEmitter() as any;
      c.pid = 4242;
      c.exitCode = 0;
      c.stdin = { write: vi.fn(), on: vi.fn() };
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      return c;
    };

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.resetModules();
    const { HotAgents: LinuxHot } = await import('../src/core/agents/hot');
    const linuxSpawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => fakeChild());
    const linuxHot = new LinuxHot(os.tmpdir());
    linuxHot.warm([
      { account: { id: 'c1', kind: 'claude', label: 'c1', home: null, role: 'master', createdAt: 0 }, cliPath: '/usr/bin/claude' },
      { account: { id: 'x1', kind: 'codex', label: 'x1', home: null, role: 'worker', createdAt: 0 }, cliPath: '/usr/bin/codex' },
    ], { cwd: '/tmp/proj', autonomy: 'standard', browser: false });
    expect(linuxSpawn).toHaveBeenNthCalledWith(1, '/usr/bin/claude', expect.any(Array), expect.objectContaining({ detached: true }));
    expect(linuxSpawn.mock.calls[0][2]).not.toHaveProperty('shell', true);
    expect(linuxSpawn).toHaveBeenNthCalledWith(2, '/usr/bin/codex', ['app-server'], expect.objectContaining({ detached: true }));
    expect(linuxSpawn.mock.calls[1][2]).not.toHaveProperty('shell', true);
    linuxHot.dispose();

    linuxSpawn.mockClear();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.resetModules();
    const { HotAgents: WinHot } = await import('../src/core/agents/hot');
    const winSpawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => fakeChild());
    const winHot = new WinHot(os.tmpdir());
    winHot.warm([
      { account: { id: 'c1', kind: 'claude', label: 'c1', home: null, role: 'master', createdAt: 0 }, cliPath: 'C:/tools/claude.cmd' },
      { account: { id: 'x1', kind: 'codex', label: 'x1', home: null, role: 'worker', createdAt: 0 }, cliPath: 'C:/tools/codex.cmd' },
    ], { cwd: 'C:/proj', autonomy: 'standard', browser: false });
    expect(winSpawn).toHaveBeenNthCalledWith(1, expect.stringContaining('C:/tools/claude.cmd'), expect.objectContaining({ shell: true, windowsHide: true }));
    expect(winSpawn).toHaveBeenNthCalledWith(2, 'C:/tools/codex.cmd app-server', expect.objectContaining({ shell: true, windowsHide: true }));
    winHot.dispose();
  });

  it('spawns command catalog probes directly with detached process groups on Unix', async () => {
    const { EventEmitter } = await import('node:events');
    const fakeChild = () => {
      const c = new EventEmitter() as any;
      c.pid = 5151;
      c.exitCode = 0;
      c.stdin = { write: vi.fn(), on: vi.fn() };
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      queueMicrotask(() => c.emit('close', 0));
      return c;
    };

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.resetModules();
    const { CommandCatalog } = await import('../src/core/agents/commands');
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation(() => fakeChild());
    const catalog = new CommandCatalog();
    await catalog.list({ id: 'c1', kind: 'claude', label: 'c1', home: null, role: 'master', createdAt: 0 }, '/usr/bin/claude', '/tmp/proj');
    await catalog.list({ id: 'a1', kind: 'antigravity', label: 'a1', home: null, role: 'master', createdAt: 0 }, '/usr/bin/agy', '/tmp/proj');
    await catalog.list({ id: 'x1', kind: 'codex', label: 'x1', home: null, role: 'worker', createdAt: 0 }, '/usr/bin/codex', '/tmp/proj');
    expect(spawnSpy).toHaveBeenNthCalledWith(1, '/usr/bin/claude', expect.any(Array), expect.objectContaining({ detached: true }));
    expect(spawnSpy.mock.calls[0][2]).not.toHaveProperty('shell', true);
    expect(spawnSpy).toHaveBeenNthCalledWith(2, '/usr/bin/agy', ['acp'], expect.objectContaining({ detached: true }));
    expect(spawnSpy).toHaveBeenNthCalledWith(3, '/usr/bin/codex', ['app-server'], expect.objectContaining({ detached: true }));
    expect(spawnSpy.mock.calls[2][2]).not.toHaveProperty('shell', true);
  });

  it.each(['linux', 'darwin'] as const)('uses the default Playwright browser when Chrome is absent on %s', async (platform) => {
    const { browserServer, PLAYWRIGHT_MCP } = await onPlatform(platform);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(browserServer()).toEqual({ command: 'npx', args: ['-y', PLAYWRIGHT_MCP, '--isolated', '--headless'] });
  });

  it.each([true, false])('preserves Windows browser selection (Chrome installed: %s)', async (chrome) => {
    vi.stubEnv('ProgramFiles', 'C:/Program Files');
    const { browserServer, PLAYWRIGHT_MCP } = await onPlatform('win32');
    vi.spyOn(fs, 'existsSync').mockReturnValue(chrome);
    expect(browserServer('C:/output')).toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', PLAYWRIGHT_MCP, '--isolated', '--headless', '--browser', chrome ? 'chrome' : 'msedge', '--output-dir', 'C:/output'] });
  });
});

describe('Antigravity permissions (headless agy cannot ask, so it silently denies)', () => {
  it('standard mode runs commands inside the sandbox', () => {
    const args = buildArgs({ ...base, mode: 'write', autonomy: 'standard' });
    expect(args).toEqual(expect.arrayContaining(['--mode', 'accept-edits', '--sandbox']));
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ permissions: { allow: ['command(*)'] } });
  });

  it('adds the browser to the same allow list', () => {
    const args = buildArgs({ ...base, mode: 'write', autonomy: 'standard', browser: { outputDir: 'o', configFile: 'c' } });
    expect(args.filter((a) => a === '--settings')).toHaveLength(1);
    expect(JSON.parse(args[args.indexOf('--settings') + 1]).permissions.allow).toEqual(['command(*)', 'mcp(playwright/*)']);
  });

  it('read-only mode stays in plan mode with no command access', () => {
    const args = buildArgs({ ...base, mode: 'read-only', autonomy: 'standard' });
    expect(args).toEqual(expect.arrayContaining(['--mode', 'plan']));
    expect(args).not.toContain('--settings');
  });
});

describe('Claude Code permissions', () => {
  const claude = { kind: 'claude' as const, cwd: 'C:/p', lastMessageFile: 'x' };
  it('standard mode runs any shell command and may use the Temp folder', () => {
    const args = buildArgs({ ...claude, mode: 'write', autonomy: 'standard' });
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--add-dir']));
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(['Bash']); // variadic, so it comes last
  });
  it('the browser tools join the same allow list', () => {
    const args = buildArgs({ ...claude, mode: 'write', autonomy: 'standard', browser: { outputDir: 'o', configFile: 'c' } });
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(['Bash', 'mcp__playwright']);
  });
});

describe('errorOf', () => {
  it("pulls the provider's message out of an API error", () => {
    const tail = `$ claude in x\n\n[claude] error: API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.114 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again."}}\n\n[super-agent] turn ended (code 1)\n`;
    expect(errorOf(tail)).toBe("Claude Code 2.1.114 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.");
  });
  it('falls back to the error line itself, and to nothing', () => {
    expect(errorOf('working\n[antigravity] error: something broke\n')).toBe('something broke');
    expect(errorOf('all fine\n')).toBeUndefined();
  });
});

describe('OUTDATED', () => {
  it('recognises "this CLI is too old" in any wording', () => {
    for (const e of [
      "Claude Code 2.1.114 does not support this model; version 2.1.280 or newer is required. Run 'claude update'",
      'Upgrade required: please install the latest client',
      'Your client is outdated',
      'error_code: version_too_old',
      'A newer version of Codex is required for this model',
    ])
      expect(OUTDATED.test(e), e).toBe(true);
  });
  it('ignores other failures', () => {
    for (const e of ['Rate limit reached', 'ENOENT: no such file', 'Request timed out', 'invalid_request_error: prompt is too long']) expect(OUTDATED.test(e), e).toBe(false);
  });
});

describe('describeTool', () => {
  it('keeps a command exactly as run and whole, however long (on one line)', () => {
    const long = `cd "D:/Nothing/#Projects/App" && cat .gitignore; ${'git ls-files | sort; '.repeat(20)}du -sh .venv`;
    expect(describeTool({ command: long })).toBe(long.trim());
    expect(describeTool({ command: 'python - <<PY\nprint(1)\nPY' })).toBe('python - <<PY print(1) PY');
    expect(describeTool({ file_path: 'C:/x/a.py' })).toBe('C:/x/a.py');
  });
});

describe('RATE_LIMIT', () => {
  it("recognises running out of usage in any wording", () => {
    for (const e of ["You've hit your 5-hour limit · resets 5:20am (America/New_York)", 'Weekly limit reached, resets Monday', "You're out of credits", 'Rate limit exceeded', 'You have hit your usage limit'])
      expect(RATE_LIMIT.test(e), e).toBe(true);
  });
  it('ignores ordinary failures', () => {
    for (const e of ['Request timed out', 'ENOENT: no such file', 'invalid_request_error: prompt is too long']) expect(RATE_LIMIT.test(e), e).toBe(false);
  });
});

describe('Approve for me (autonomy auto)', () => {
  it('Claude Code runs in its auto mode: its classifier decides, nothing is pre-allowed', () => {
    const args = buildArgs({ kind: 'claude', cwd: 'C:/p', lastMessageFile: 'x', mode: 'write', autonomy: 'auto' });
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'auto', '--add-dir']));
    expect(args).not.toContain('--allowedTools');
  });
  it('Antigravity has no reviewer: same as Ask (sandboxed)', () => {
    const auto = buildArgs({ kind: 'antigravity', cwd: 'C:/p', lastMessageFile: 'x', mode: 'write', autonomy: 'auto' });
    expect(auto).toEqual(buildArgs({ kind: 'antigravity', cwd: 'C:/p', lastMessageFile: 'x', mode: 'write', autonomy: 'standard' }));
  });
});

describe("Super Agent's folder for a project (outside it)", () => {
  const dirs = ['C:/Users/me/.super-agent/work/app-1a2b3c4d'];
  it('every agent may write there: Codex as a writable root, Claude Code and Antigravity as an added folder', () => {
    const codex = buildArgs({ kind: 'codex', cwd: 'C:/p', lastMessageFile: 'x', mode: 'write', autonomy: 'standard', dirs });
    expect(codex).toContain(`sandbox_workspace_write.writable_roots=['${dirs[0]}']`);
    const claude = buildArgs({ kind: 'claude', cwd: 'C:/p', lastMessageFile: 'x', mode: 'write', autonomy: 'standard', dirs });
    expect(claude.slice(claude.indexOf('--add-dir'), claude.indexOf('--permission-mode'))).toContain(dirs[0]);
    const agy = buildArgs({ kind: 'antigravity', cwd: 'C:/p', lastMessageFile: 'x', mode: 'write', autonomy: 'standard', dirs });
    expect(agy[agy.indexOf('--add-dir') + 1]).toBe(dirs[0]);
  });
});

describe('toolLabel', () => {
  it('names the browser tools in words, other MCP tools by server, and leaves built-in tools alone', async () => {
    const { toolLabel } = await import('../src/core/agents/runner');
    expect(toolLabel('mcp__playwright__browser_run_code_unsafe')).toBe('Browser run script');
    expect(toolLabel('mcp__playwright__browser_close')).toBe('Browser close');
    expect(toolLabel('mcp__playwright__browser_navigate')).toBe('Browser open');
    expect(toolLabel('mcp__github__create_issue')).toBe('github create issue');
    expect(toolLabel('Bash')).toBe('Bash');
  });
});

describe('Antigravity GEMINI_API_KEY mode', () => {
  it('passes modelProvider=gemini in --settings and injects GEMINI_API_KEY via accountEnv', async () => {
    const { accountEnv, setAccountApiKey } = await import('../src/core/agents/cli');
    const args = buildArgs({ ...base, mode: 'write', autonomy: 'standard', apiKey: true });
    const settingsIdx = args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(JSON.parse(args[settingsIdx + 1])).toEqual({ permissions: { allow: ['command(*)'] }, modelProvider: 'gemini' });

    const fullArgs = buildArgs({ ...base, mode: 'write', autonomy: 'full', apiKey: true });
    const fullIdx = fullArgs.indexOf('--settings');
    expect(fullIdx).toBeGreaterThan(-1);
    expect(JSON.parse(fullArgs[fullIdx + 1])).toEqual({ modelProvider: 'gemini' });

    setAccountApiKey('agy-key-1', 'test-gemini-key');
    try {
      const env = accountEnv({ id: 'agy-key-1', kind: 'antigravity', auth: 'apiKey', label: 'Antigravity · API key', home: null, role: 'worker', createdAt: 0 }, {});
      expect(env.GEMINI_API_KEY).toBe('test-gemini-key');
      const oauthEnv = accountEnv({ id: 'agy-oauth', kind: 'antigravity', label: 'Antigravity 1', home: null, role: 'worker', createdAt: 0 }, {});
      expect(oauthEnv.GEMINI_API_KEY).toBeUndefined();
    } finally {
      setAccountApiKey('agy-key-1', undefined);
    }
  });
});
