/**
 * Agent replies are Markdown; Telegram renders a small HTML subset. This converts one to the other and splits
 * the result into messages that each stay under Telegram's limit without cutting a tag in half.
 */

const LIMIT = 3900; // Telegram allows 4096 characters per message (after parsing)

/** Telegram code-block languages for common fence names. */
const LANG_ALIAS: Record<string, string> = { ts: 'typescript', js: 'javascript', py: 'python', sh: 'bash', shell: 'bash', ps1: 'powershell', yml: 'yaml', md: 'markdown' };

type Block = { kind: 'line'; html: string } | { kind: 'pre'; lang?: string; lines: string[] } | { kind: 'quote'; lines: string[] };

/** Markdown → Telegram HTML messages (each ≤ LIMIT, tags balanced). `header` is already HTML. */
export function markdownToTelegram(md: string, header?: string): string[] {
  const units = [...(header ? [header, ''] : []), ...blocks(md).flatMap(render)];
  const out: string[] = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + 1 + u.length > LIMIT) {
      out.push(cur.replace(/\n+$/, ''));
      cur = '';
    }
    cur = cur ? `${cur}\n${u}` : u;
  }
  if (cur.trim()) out.push(cur.replace(/\n+$/, ''));
  return out.length ? out : [header ?? '(empty)'];
}

function blocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      const lang = fence[1].toLowerCase();
      out.push({ kind: 'pre', lang: lang ? (LANG_ALIAS[lang] ?? lang) : undefined, lines: body });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // Tables: monospace keeps the columns lined up (separator rows like |---|---| are dropped).
      const body: string[] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) body.push(lines[i].trim());
      i--;
      out.push({ kind: 'pre', lines: body });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(inline(lines[i].replace(/^\s*>\s?/, '')));
      i--;
      out.push({ kind: 'quote', lines: body });
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push({ kind: 'line', html: `<b>${inline(heading[1])}</b>` });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: 'line', html: '──────────' });
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const task = /^\[([ xX])\]\s+(.*)$/.exec(bullet[2]);
      const mark = task ? (task[1] === ' ' ? '☐' : '☑') : '•';
      out.push({ kind: 'line', html: `${'  '.repeat(Math.floor(bullet[1].length / 2))}${mark} ${inline(task ? task[2] : bullet[2])}` });
      continue;
    }
    out.push({ kind: 'line', html: inline(line) });
  }
  return out;
}

/** A block as one or more self-contained HTML units (long code / quotes are split into several closed blocks). */
function render(b: Block): string[] {
  if (b.kind === 'line') return [b.html];
  const open = b.kind === 'pre' ? `<pre><code${b.lang ? ` class="language-${b.lang}"` : ''}>` : '<blockquote>';
  const close = b.kind === 'pre' ? '</code></pre>' : '</blockquote>';
  const body = b.kind === 'pre' ? b.lines.map(esc) : b.lines;
  const units: string[] = [];
  let cur: string[] = [];
  let size = 0;
  for (const raw of body) {
    const l = raw.length > LIMIT - 100 ? `${raw.slice(0, LIMIT - 100)}…` : raw;
    if (cur.length && size + l.length + 1 > LIMIT - open.length - close.length - 10) {
      units.push(open + cur.join('\n') + close);
      cur = [];
      size = 0;
    }
    cur.push(l);
    size += l.length + 1;
  }
  if (cur.length || !units.length) units.push(open + cur.join('\n') + close);
  return units;
}

/** Inline Markdown on one line → HTML. Code spans are protected first so nothing inside them is formatted. */
export function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${t}</a>`);
  s = s.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>').replace(/__(?=\S)(.+?)(?<=\S)__/g, '<b>$1</b>');
  s = s.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>');
  s = s.replace(/(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, '<i>$1</i>');
  s = s.replace(/(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, '<i>$1</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${esc(codes[Number(i)])}</code>`);
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
