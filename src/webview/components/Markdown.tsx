import MarkdownIt from 'markdown-it';
import { useMemo } from 'react';

/**
 * Full CommonMark + GFM tables/strikethrough. Raw HTML is escaped (`html: false`), so agent text can't inject
 * markup. Links: web links open in the browser, file links (`file:///…`, `D:\…`, `/…`, `src/x.ts:12`) open in
 * the editor — both through the extension, which checks them.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
// markdown-it refuses file: links by default; agents cite files that way. Script URLs stay refused.
md.validateLink = (url) => !/^\s*(javascript|vbscript|data):/i.test(url);

export function Markdown({ text, onLink }: { text: string; onLink?: (url: string) => void }) {
  const html = useMemo(() => md.render(text), [text]);
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        e.preventDefault();
        const url = a.getAttribute('href') ?? '';
        if (url && !url.startsWith('#')) onLink?.(url);
      }}
    />
  );
}
