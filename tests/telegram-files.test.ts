import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bold, FileBrowser, type View } from '../src/telegram-files';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-fb-'));
  const w = (rel: string, body: string | Buffer, mtime?: number) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
  };
  const old = Date.now() - 86400000 * 3;
  w('src/app.ts', 'const a = 1 < 2 && "<b>";\n', old);
  w('src/util/strings.ts', 'export const x = 1;\n', old);
  w('README.md', '# Hello\n', old);
  w('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), old);
  w('data.bin', Buffer.from([1, 0, 2, 0]), old);
  w('.env', 'SECRET=1\n', old);
  w('node_modules/pkg/index.js', 'x\n', old);
  w('big.txt', Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${'x'.repeat(30)}`).join('\n'), old);
  w('notes/today.md', 'fresh\n'); // newest
  return root;
}

function browser(root: string) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const uploads: string[] = [];
  const attached: string[] = [];
  const b = new FileBrowser({
    api: async (method, body) => {
      calls.push({ method, body });
      return true as never;
    },
    upload: async (method, _chat, file) => void uploads.push(`${method}:${path.basename(file)}`),
    root: () => root,
    attach: (f) => void attached.push(f),
  });
  const last = (method: string) => [...calls].reverse().find((c) => c.method === method)!.body;
  const buttons = (v: { reply_markup?: unknown } | View) =>
    ('buttons' in v ? v.buttons : (v.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard)
      .flat()
      .map((x) => ({ ...x, text: x.text.replace(/\u2800+$/, '') })); // ignore the left-align padding
  const tap = async (label: string, from: { reply_markup?: unknown } = last('editMessageText') ?? last('sendMessage')) => {
    const btn = buttons(from).find((x) => x.text.includes(label));
    if (!btn) throw new Error(`no button "${label}" in ${buttons(from).map((x) => x.text).join(' | ')}`);
    await b.onCallback(1, 10, 'q', btn.callback_data);
  };
  return { b, calls, uploads, attached, last, buttons, tap };
}

describe('Telegram workspace explorer', () => {
  it('lists folders first, hides dot files until asked, and navigates in place', async () => {
    const h = browser(workspace());
    await h.b.open(1);
    const first = h.last('sendMessage');
    expect(first.parse_mode).toBe('HTML');
    const labels = h.buttons(first).map((x) => x.text);
    expect(labels.slice(0, 3)).toEqual([`📁 ${bold('node_modules')}`, `📁 ${bold('notes')}`, `📁 ${bold('src')}`]);
    expect(bold('src2')).toBe('𝘀𝗿𝗰𝟮');
    expect(labels.some((l) => l.includes('.env'))).toBe(false);
    expect(labels.some((l) => l.startsWith('🖼 logo.png'))).toBe(true);
    expect(String(first.text)).toMatch(/3 folders · 4 files/); // .env hidden

    await h.tap(bold('src'), first);
    const src = h.last('editMessageText');
    expect(String(src.text)).toContain('/ src</b>');
    expect(h.buttons(src)[0].text).toBe('⬆ ..'); // up sits at the top of the list
    expect(h.buttons(src).map((x) => x.text)).toContain(`📁 ${bold('util')}`);

    await h.tap('⬆ ..', src);
    await h.tap('👁');
    expect(h.buttons(h.last('editMessageText')).some((x) => x.text.includes('.env'))).toBe(true);
  });

  it('previews code with highlighting and escaping, pages long files, and offers download / ask', async () => {
    const h = browser(workspace());
    await h.b.open(1);
    await h.tap(bold('src'), h.last('sendMessage'));
    await h.tap('app.ts');
    const view = String(h.last('editMessageText').text);
    expect(view).toContain('<pre><code class="language-typescript">');
    expect(view).toContain('1 &lt; 2 &amp;&amp; "&lt;b&gt;"');

    await h.tap('📎');
    expect(h.attached[0]).toMatch(/src[\\/]app\.ts$/);
    await h.tap('⬇');
    expect(h.uploads).toEqual(['sendDocument:app.ts']);

    await h.b.find(1, 'big');
    await h.tap('big.txt', h.last('sendMessage'));
    const big = h.last('editMessageText');
    expect(String(big.text).length).toBeLessThan(4096);
    expect(String(big.text)).toMatch(/lines 1–\d+ of 2000/);
    await h.tap('▶');
    expect(String(h.last('editMessageText').text)).toMatch(/lines \d+–\d+ of 2000/);
  });

  it('has a compact, icon-only control row with refresh', async () => {
    const h = browser(workspace());
    await h.b.open(1);
    expect(h.buttons(h.last('sendMessage')).slice(-3).map((x) => x.text)).toEqual(['🔄', '🕘', '👁']);
    await h.tap('🔄', h.last('sendMessage'));
    expect(h.last('editMessageText').text).toBe(h.last('sendMessage').text);
  });

  it('shows binary files as download-only and recent changes newest first (skipping node_modules)', async () => {
    const h = browser(workspace());
    expect(h.b.fileView('data.bin', 0).text).toMatch(/Binary file/);
    const recent = h.b.recentView();
    expect(recent.buttons[0][0].text).toMatch(/^📝 notes\/today\.md\s+·\s+just now\u2800+$/); // padded so it sits at the left
    expect(recent.buttons.flat().some((x) => x.text.includes('node_modules'))).toBe(false);
  });

  it('never leaves the workspace: unknown or stale ids expire, paths outside resolve to the root', async () => {
    const h = browser(workspace());
    await h.b.onCallback(1, 10, 'q', 'fb:f:999:0');
    expect(h.last('answerCallbackQuery').text).toMatch(/expired/);
    expect(h.b.fileView(path.join('..', '..', 'Windows', 'win.ini'), 0).text).toBe('That file is gone.');
    expect(h.b.dirView(path.join('..', '..'), 0).text).toContain(`📂 <b>${path.basename(h.b['d'].root()!)}</b>`);
  });
});
