import { describe, expect, it } from 'vitest';
import { askSummary, claudeAnswer, claudeAsk, codexAnswer, codexAsk } from '../src/core/agents/hot';

describe('Codex approval requests', () => {
  it('a command outside the sandbox: shows the command itself, answers with the decision', () => {
    const p = { threadId: 't', turnId: 'u', itemId: 'i', command: '"C:\\WINDOWS\\powershell.exe" -Command \'Copy-Item a D:\\other\\b\'', cwd: 'C:\\app', reason: 'write outside the workspace' };
    const ask = codexAsk('item/commandExecution/requestApproval', p)!;
    expect(ask).toEqual({ kind: 'command', command: 'Copy-Item a D:\\other\\b', cwd: 'C:\\app', network: undefined, reason: 'write outside the workspace' });
    expect(askSummary(ask)).toBe('run Copy-Item a D:\\other\\b');
    expect(codexAnswer('item/commandExecution/requestApproval', p, 'acceptForSession')).toEqual({ decision: 'acceptForSession' });
  });

  it('an edit: names the files from the edit item it started', () => {
    const files = new Map([['i1', ['D:\\other\\ui.tsx']]]);
    const ask = codexAsk('item/fileChange/requestApproval', { threadId: 't', itemId: 'i1', reason: null }, files)!;
    expect(ask.paths).toEqual(['D:\\other\\ui.tsx']);
    expect(askSummary(ask)).toBe('edit D:\\other\\ui.tsx');
    expect(codexAnswer('item/fileChange/requestApproval', {}, 'decline')).toEqual({ decision: 'decline' });
  });

  it('more permissions: grants what was asked, for the turn or the session; nothing when declined', () => {
    const permissions = { network: { enabled: true }, fileSystem: { read: null, write: ['D:\\other'] } };
    const p = { threadId: 't', cwd: 'C:\\app', reason: null, permissions };
    const ask = codexAsk('item/permissions/requestApproval', p)!;
    expect(askSummary(ask)).toBe('write to D:\\other and network access');
    expect(codexAnswer('item/permissions/requestApproval', p, 'accept')).toEqual({ permissions, scope: 'turn' });
    expect(codexAnswer('item/permissions/requestApproval', p, 'acceptForSession')).toEqual({ permissions, scope: 'session' });
    expect(codexAnswer('item/permissions/requestApproval', p, 'decline')).toEqual({ permissions: {}, scope: 'turn' });
  });

  it('older servers (v1 requests) get v1 answers', () => {
    expect(codexAsk('execCommandApproval', { conversationId: 't', command: ['git', 'push'], cwd: 'C:\\app', reason: null })?.command).toBe('git push');
    expect(codexAsk('applyPatchApproval', { conversationId: 't', fileChanges: { 'D:\\x.py': {} }, reason: null })?.paths).toEqual(['D:\\x.py']);
    expect(codexAnswer('execCommandApproval', {}, 'accept')).toEqual({ decision: 'approved' });
    expect(codexAnswer('applyPatchApproval', {}, 'decline')).toEqual({ decision: { denied: { rejection: 'The user declined.' } } });
    expect(codexAnswer('execCommandApproval', {}, 'cancel')).toEqual({ decision: 'abort' });
  });

  it('other client requests are not approvals', () => {
    expect(codexAsk('item/tool/requestUserInput', {})).toBeUndefined();
  });
});

describe('Claude Code permission requests (can_use_tool)', () => {
  // As Claude Code 2.1 sends it for a Write outside the folder.
  const write = {
    subtype: 'can_use_tool',
    tool_name: 'Write',
    display_name: 'Write',
    input: { file_path: 'D:\\other\\hi.txt', content: 'hi' },
    permission_suggestions: [{ type: 'addDirectories', directories: ['D:\\other'], destination: 'session' }],
    decision_reason: 'Path is outside allowed working directories',
  };

  it('an edit outside the folder: the file and the reason', () => {
    expect(claudeAsk(write)).toEqual({ kind: 'files', paths: ['D:\\other\\hi.txt'], reason: 'Path is outside allowed working directories' });
  });

  it('allow keeps the input; for this session it also applies the suggested rule (the folder)', () => {
    expect(claudeAnswer(write, 'accept')).toEqual({ behavior: 'allow', updatedInput: write.input });
    expect(claudeAnswer(write, 'acceptForSession')).toEqual({ behavior: 'allow', updatedInput: write.input, updatedPermissions: write.permission_suggestions });
  });

  it('deny tells it you declined; a stopped turn interrupts it', () => {
    expect(claudeAnswer(write, 'decline')).toEqual({ behavior: 'deny', message: 'The user declined this.' });
    expect(claudeAnswer(write, 'cancel')).toMatchObject({ behavior: 'deny', interrupt: true });
  });

  it('commands and other tools', () => {
    expect(claudeAsk({ tool_name: 'Bash', input: { command: 'rm -rf build' } })).toMatchObject({ kind: 'command', command: 'rm -rf build' });
    const fetch = claudeAsk({ tool_name: 'WebFetch', display_name: 'Fetch', input: { url: 'https://x.dev' } });
    expect(fetch).toMatchObject({ kind: 'tool', tool: 'Fetch', paths: ['https://x.dev'] });
    expect(askSummary(fetch)).toBe('use Fetch on https://x.dev');
  });
});
