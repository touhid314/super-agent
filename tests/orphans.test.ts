import { describe, expect, it } from 'vitest';
import { orphansIn } from '../src/core/agents/orphans';

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
});
