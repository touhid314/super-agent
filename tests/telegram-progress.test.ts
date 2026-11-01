import { describe, expect, it } from 'vitest';
import { ActivityParser, elapsed, ProgressTracker } from '../src/telegram-progress';

describe('activity lines for the Telegram status message', () => {
  it('Codex: skips the banner, the echoed prompt and command output; shows narration and commands', () => {
    const p = new ActivityParser();
    p.feed(
      [
        '$ codex (Codex · x) in C:\\proj',
        'OpenAI Codex v0.166.0',
        '--------',
        'workdir: C:\\proj',
        'model: gpt-x',
        'session id: 0199',
        '--------',
        'user',
        'You are working inside Super Agent… (the whole prompt)',
        'USER: earlier message',
        'codex',
        'I’ll read the PDF and summarize it.',
        'exec',
        '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Item -LiteralPath \'C:\\\\a.pdf\'"',
        ' succeeded in 152ms:',
        'FullName   Length',
        'C:\\a.pdf   290493',
        'mcp: playwright/browser_navigate started',
        'mcp: playwright/browser_navigate (completed)',
        'thinking',
        'secret chain of thought',
        'codex',
        'Done: it is a 3-page memo.',
        'tokens used',
        '25,485',
        '',
      ].join('\n'),
    );
    expect(p.items).toEqual([
      '💬 I’ll read the PDF and summarize it.',
      "▶ Get-Item -LiteralPath 'C:\\a.pdf'",
      '🔧 playwright/browser_navigate',
      '💭 thinking…',
      '💬 Done: it is a 3-page memo.',
    ]);
  });

  it('Claude Code / Antigravity: tool actions and narration, last few only, long lines cut', () => {
    const p = new ActivityParser();
    p.feed('$ claude (Claude · y) in C:\\proj\n\n→ Read C:\\proj\\src\\app.ts\n→ Bash npm test\n');
    p.feed(`Tests pass. **Now** fixing the ${'very '.repeat(40)}long thing\n`);
    for (let i = 0; i < 10; i++) p.feed(`→ Edit file${i}.ts\n`);
    p.feed('[super-agent] exited with code 0\n');
    expect(p.items).toHaveLength(6);
    expect(p.items.at(-1)).toBe('🔧 Edit file9.ts');
    const q = new ActivityParser();
    q.feed(`→ Read a.ts\nTests pass. **Now** fixing the ${'very '.repeat(40)}long thing\n`);
    expect(q.items[1].startsWith('💬 Tests pass. Now fixing')).toBe(true);
    expect(q.items[1].length).toBeLessThanOrEqual(110);
  });

  it('posts a status message at once, updates it, and turns it into a summary', async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let status = 'working';
    const t = new ProgressTracker({
      api: async (method, body) => {
        calls.push({ method, body });
        return { message_id: 42 } as never;
      },
      agent: () => 'Opus 9',
      status: () => status,
    });
    t.start(7, 'th1');
    t.start(7, 'th1'); // only one message per run
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    expect(String(calls[0].body.text)).toMatch(/Opus 9<\/b> is working · 0s/);
    expect(JSON.stringify(calls[0].body.reply_markup)).toContain('pg:stop:th1');
    t.feed('th1', '→ Read app.ts\n');
    await t.finish('th1', 'done');
    const last = calls.at(-1)!;
    expect(last.method).toBe('editMessageText');
    expect(last.body.message_id).toBe(42);
    expect(String(last.body.text)).toMatch(/✅ <b>Opus 9<\/b> finished in \d+s/);
    expect(t.has('th1')).toBe(false);
    status = 'idle';
  });

  it('formats elapsed time', () => {
    expect(elapsed(5000)).toBe('5s');
    expect(elapsed(133000)).toBe('2m 13s');
    expect(elapsed(3723000)).toBe('1h 02m');
  });
});
