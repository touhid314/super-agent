import { describe, expect, it } from 'vitest';
import { buildArgs } from '../src/core/agents/cli';
import { RATE_LIMIT, describeTool, errorOf } from '../src/core/agents/runner';
import { OUTDATED } from '../src/core/agents/updater';

const base = { kind: 'antigravity' as const, cwd: 'C:/p', lastMessageFile: 'x' };

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
