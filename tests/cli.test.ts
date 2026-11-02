import { describe, expect, it } from 'vitest';
import { buildArgs } from '../src/core/agents/cli';

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
