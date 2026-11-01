import type { ReactNode } from 'react';

/** Small, safe Markdown renderer (headings, lists, code, bold/italic, inline code). No HTML passthrough. */
export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={key++}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = (`h${Math.min(h[1].length + 1, 4)}` as unknown) as 'h2';
      out.push(<Tag key={key++}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={key++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*+]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={key++}>{inline(para.join(' '))}</p>);
  }
  return <>{out}</>;
}

function inline(s: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const t = m[0];
    if (m[1]) parts.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (m[3]) parts.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else parts.push(<span key={k++} style={{ color: 'var(--accent)' }}>{t.replace(/^\[([^\]]+)\].*$/, '$1')}</span>);
    last = m.index + t.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}
