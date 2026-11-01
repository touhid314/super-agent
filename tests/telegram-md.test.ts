import { describe, expect, it } from 'vitest';
import { inline, markdownToTelegram } from '../src/telegram-md';

describe('Markdown → Telegram HTML', () => {
  it('formats inline Markdown and escapes everything else', () => {
    expect(inline('**Done**: fixed `a < b && c` in *two* places, ~~old~~ [docs](https://x.dev/a?b=1&c=2)')).toBe(
      '<b>Done</b>: fixed <code>a &lt; b &amp;&amp; c</code> in <i>two</i> places, <s>old</s> <a href="https://x.dev/a?b=1&amp;c=2">docs</a>',
    );
    // snake_case and lone asterisks stay as they are; nothing inside code is formatted
    expect(inline('use my_var_name and 2 * 3 * 4, `**not bold**`')).toBe('use my_var_name and 2 * 3 * 4, <code>**not bold**</code>');
    expect(inline('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('turns headings, lists, quotes, code blocks and tables into Telegram blocks', () => {
    const [msg] = markdownToTelegram(
      ['## Summary', '- fixed the **parser**', '- [x] tests pass', '> note: <careful>', '```ts', 'const a = 1 < 2;', '```', '| file | lines |', '|---|---|', '| a.ts | 3 |', '---'].join('\n'),
      '<b>Opus 9</b>',
    );
    expect(msg).toBe(
      [
        '<b>Opus 9</b>',
        '',
        '<b>Summary</b>',
        '• fixed the <b>parser</b>',
        '☑ tests pass',
        '<blockquote>note: &lt;careful&gt;</blockquote>',
        '<pre><code class="language-typescript">const a = 1 &lt; 2;</code></pre>',
        '<pre><code>| file | lines |\n| a.ts | 3 |</code></pre>',
        '──────────',
      ].join('\n'),
    );
  });

  it('splits long replies between blocks, never inside a tag, and closes split code blocks', () => {
    const code = Array.from({ length: 400 }, (_, i) => `line ${i} <x>`).join('\n');
    const parts = markdownToTelegram(`Intro **bold**\n\n\`\`\`js\n${code}\n\`\`\`\n\nThe end.`);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(4096);
      expect((p.match(/<pre>/g) ?? []).length).toBe((p.match(/<\/pre>/g) ?? []).length);
      expect((p.match(/<b>/g) ?? []).length).toBe((p.match(/<\/b>/g) ?? []).length);
    }
    expect(parts.join('\n')).toContain('line 399 &lt;x&gt;');
    expect(parts.at(-1)).toMatch(/The end\.$/);
  });
});
