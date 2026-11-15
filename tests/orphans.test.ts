import { describe, expect, it } from 'vitest';
import { orphansIn, parsePsOutput } from '../src/core/agents/orphans';

const data = 'C:\\Users\\me\\.super-agent';
const proc = (ProcessId: number, ParentProcessId: number, Name: string, CommandLine: string | null) => ({ ProcessId, ParentProcessId, Name, CommandLine });

describe('agents left running by an earlier session', () => {
  it("finds Super Agent's agents whose starter is gone, and nothing else", () => {
    const procs = [
      proc(100, 1, 'Code.exe', 'Code.exe'), // this window's extension host
      // An agent a VS Code session left behind: its cmd wrapper is gone (parent 999 doesn't exist).
      proc(8152, 999, 'claude.exe', `claude.exe --input-format stream-json --mcp-config ${data}\\hot\\acc.mcp.json -p`),
      // Its own child: stopped with it (taskkill /T), so not listed separately.
      proc(8153, 8152, 'node.exe', `node playwright-mcp --output-dir ${data}\\work\\app-1\\screenshots`),
      // This window's agent: its parent is alive.
      proc(200, 100, 'cmd.exe', `cmd /c claude.exe --mcp-config ${data}\\hot\\acc.mcp.json`),
      // Your own Claude Code in a terminal, parent gone too but not Super Agent's: left alone.
      proc(300, 998, 'claude.exe', 'claude.exe --resume abc'),
      // A Super Agent path in some other program's command line: not an agent CLI, left alone.
      proc(400, 997, 'notepad.exe', `notepad ${data}\\logs\\x.log`),
    ];
    expect(orphansIn(procs, data, 100).map((p) => p.ProcessId)).toEqual([8152]);
  });

  it('parses Linux ps output and finds non-.exe orphaned agents case-sensitively', () => {
    const linuxData = '/home/me/.super-agent';
    const psOut = [
      '  100     1 node            node /usr/lib/code/extensionHost.js',
      ` 8152   999 claude          claude --input-format stream-json --mcp-config ${linuxData}/hot/acc.mcp.json -p`,
      ` 8153  8152 node            node playwright-mcp --output-dir ${linuxData}/work/app-1/screenshots`,
      ` 8200   999 bash            bash -c codex --cd ${linuxData}/work/app-2`,
      ` 8201   999 agy             agy --output-format stream-json --mcp-config ${linuxData}/hot/agy.mcp.json`,
      ` 8202   999 sh              sh -c claude --mcp-config ${linuxData.toUpperCase()}/hot/wrong-case.mcp.json`,
      `  200   100 codex           codex --cd ${linuxData}/work/app-3`,
      '  300   998 claude          claude --resume abc',
      `  400   997 vim             vim ${linuxData}/logs/x.log`,
      '    1     0 systemd         /sbin/init',
      ` 8300     1 claude          claude --mcp-config ${linuxData}/hot/orphan.mcp.json`,
      '',
    ].join('\n');

    const procs = parsePsOutput(psOut);
    expect(procs).toHaveLength(11);
    expect(procs[1]).toEqual({
      ProcessId: 8152,
      ParentProcessId: 999,
      Name: 'claude',
      CommandLine: `claude --input-format stream-json --mcp-config ${linuxData}/hot/acc.mcp.json -p`,
    });
    expect(orphansIn(procs, linuxData, 100, false).map((p) => p.ProcessId)).toEqual([8152, 8200, 8201, 8300]);
  });
});
