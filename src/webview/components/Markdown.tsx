import MarkdownIt from 'markdown-it';
import { useEffect, useMemo, useState } from 'react';

/**
 * Full CommonMark + GFM tables/strikethrough. Raw HTML is escaped (`html: false`), so agent text can't inject
 * markup. Links: web links open in the browser, file links (`file:///…`, `D:\…`, `/…`, `src/x.ts:12`) open in
 * the editor — both through the extension, which checks them.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
// markdown-it refuses file: links by default; agents cite files that way. Script URLs stay refused.
md.validateLink = (url) => !/^\s*(javascript|vbscript|data):/i.test(url);
// Every code block gets a copy icon (as in Codex), fenced or indented; it turns into a check once copied.
const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/></svg>';
const CHECK_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
for (const rule of ['fence', 'code_block'] as const) {
  const render = md.renderer.rules[rule]!;
  md.renderer.rules[rule] = (...args) => `<div class="code-block"><button class="copy-code" type="button" title="Copy" aria-label="Copy">${COPY_ICON}</button>${render(...args)}</div>`;
}

/** Puts text on the clipboard (with the selection-based fallback older webviews need). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/** Copies a code block's text, and says so on its button for a moment. */
async function copyBlock(button: HTMLElement): Promise<void> {
  await copyText(button.parentElement?.querySelector('pre')?.textContent ?? '');
  button.innerHTML = CHECK_ICON;
  button.title = 'Copied';
  button.classList.add('done');
  setTimeout(() => {
    button.innerHTML = COPY_ICON;
    button.title = 'Copy';
    button.classList.remove('done');
  }, 1500);
}

/** A message's copy icon (next to its time, shown on hover); it turns into a check once copied. */
export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className={done ? 'copy-msg done' : 'copy-msg'}
      title={done ? 'Copied' : 'Copy'}
      aria-label={done ? 'Copied' : 'Copy message'}
      onClick={() => void copyText(text).then(() => setDone(true))}
      dangerouslySetInnerHTML={{ __html: done ? CHECK_ICON : COPY_ICON }}
    />
  );
}

export function Markdown({ text, onLink }: { text: string; onLink?: (url: string) => void }) {
  const html = useMemo(() => md.render(text), [text]);
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const copy = (e.target as HTMLElement).closest<HTMLElement>('.copy-code');
        if (copy) return void copyBlock(copy);
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        e.preventDefault();
        const url = a.getAttribute('href') ?? '';
        if (url && !url.startsWith('#')) onLink?.(url);
      }}
    />
  );
}
