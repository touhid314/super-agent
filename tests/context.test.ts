import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderTranscript } from '../src/engine/context';

describe('renderTranscript', () => {
  it('reads a Codex session: messages, tool calls and outputs, without instructions or encrypted blobs', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-tr-')), 'rollout.jsonl');
    const item = (payload: object) => JSON.stringify({ type: 'response_item', payload });
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: 'session_meta', payload: {} }),
        item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex' }] }),
        item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] }),
        item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the build' }] }),
        item({ type: 'reasoning', summary: [], encrypted_content: 'gAAAAA' + 'x'.repeat(200) }),
        item({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['npm', 'run', 'build'] }), call_id: 'c1' }),
        item({ type: 'function_call_output', call_id: 'c1', output: 'error TS2304' }),
        item({ type: 'custom_tool_call', name: 'send_message', input: '{"message":"gAAAAA' + 'y'.repeat(200) + '"}' }),
        item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the missing import.' }] }),
      ].join('\n'),
    );
    const b = renderTranscript(f, 'codex', 1000);
    expect(b).toEqual([
      'USER:\nfix the build',
      'TOOL CALL shell:\nnpm run build',
      'TOOL RESULT:\nerror TS2304',
      'TOOL CALL send_message:\n{\n "message": "[encrypted]"\n}',
      'AGENT:\nFixed the missing import.',
    ]);
  });

  it('trims long outputs in the middle, keeping the start and the end', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-tr-')), 's.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'HEAD' + 'm'.repeat(5000) + 'TAIL' }] } }));
    const [r] = renderTranscript(f, 'claude', 500);
    expect(r).toContain('HEAD');
    expect(r).toContain('TAIL');
    expect(r).toContain('characters omitted');
    expect(r.length).toBeLessThan(700);
  });
});
