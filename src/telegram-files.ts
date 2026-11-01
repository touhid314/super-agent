import fs from 'node:fs';
import path from 'node:path';

/** Telegram inline-keyboard button. */
export interface Btn {
  text: string;
  callback_data: string;
}
export interface View {
  text: string;
  buttons: Btn[][];
}

export interface BrowserDeps {
  /** Telegram Bot API call (JSON body). */
  api<T = unknown>(method: string, body: Record<string, unknown>): Promise<T>;
  /** Multipart upload: sendDocument / sendPhoto. */
  upload(method: 'sendDocument' | 'sendPhoto', chat: number, file: string): Promise<void>;
  /** The workspace folder being explored. */
  root(): string | undefined;
  /** Queue a file to be attached to the user's next message to the agents. */
  attach(file: string): void;
}

const PAGE = 12;
const PREVIEW = 3300; // characters of code per message (Telegram allows 4096 with markup)
const MAX_TEXT = 2 * 1024 * 1024;
/** Skipped when searching / listing recent changes (still browsable by tapping). */
const HEAVY = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', '.cache', '.pytest_cache', '.mypy_cache', 'target', 'dist', 'out', 'build']);
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', py: 'python', json: 'json',
  md: 'markdown', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml', toml: 'toml', sh: 'bash', ps1: 'powershell', bat: 'batch',
  cs: 'csharp', java: 'java', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', sql: 'sql', xml: 'xml', ipynb: 'json',
};

/**
 * Workspace explorer for the Telegram bot: one message that updates in place as you tap through folders and files.
 * Buttons carry short ids (Telegram limits callback data to 64 bytes); ids only ever map to paths inside the workspace.
 */
export class FileBrowser {
  private ids = new Map<string, number>();
  private rels: string[] = [];
  private hidden = false;
  /** /find queries, so 🔄 can run them again. */
  private queries: string[] = [];

  constructor(private d: BrowserDeps) {}

  // ------------------------------------------------------------ entry points (commands)

  async open(chat: number, rel = ''): Promise<void> {
    await this.send(chat, this.dirView(rel, 0));
  }

  async recent(chat: number): Promise<void> {
    await this.send(chat, this.recentView());
  }

  async find(chat: number, query: string): Promise<void> {
    await this.send(chat, this.findView(query));
  }

  /** Handles a button tap. Returns false if the data isn't ours. */
  async onCallback(chat: number, messageId: number, queryId: string, data: string): Promise<boolean> {
    const [ns, action, id, arg] = data.split(':');
    if (ns !== 'fb') return false;
    if (action === 'q') {
      const query = this.queries[Number(id)];
      await this.d.api('answerCallbackQuery', { callback_query_id: queryId, ...(query === undefined ? { text: 'This view expired. Send /find again.' } : {}) }).catch(() => undefined);
      if (query !== undefined) await this.edit(chat, messageId, this.findView(query));
      return true;
    }
    const rel = id !== undefined && id !== '' ? this.rels[Number(id)] : '';
    const toast = (text?: string) => this.d.api('answerCallbackQuery', { callback_query_id: queryId, ...(text ? { text } : {}) }).catch(() => undefined);
    if (rel === undefined) {
      await toast('This view expired. Send /files again.');
      return true;
    }
    const n = Number(arg ?? 0) || 0;
    const root = this.d.root();
    const abs = root ? this.abs(root, rel) : undefined;
    switch (action) {
      case 'd':
        await toast((await this.edit(chat, messageId, this.dirView(rel, n))) ? undefined : '✓ Up to date');
        return true;
      case 'f':
        await toast((await this.edit(chat, messageId, this.fileView(rel, n))) ? undefined : '✓ Up to date');
        return true;
      case 'h':
        this.hidden = !this.hidden;
        await toast(this.hidden ? 'Showing hidden files' : 'Hiding hidden files');
        await this.edit(chat, messageId, this.dirView(rel, n));
        return true;
      case 'r':
        await toast((await this.edit(chat, messageId, this.recentView())) ? undefined : '✓ Up to date');
        return true;
      // From buttons under an agent's reply: open a new explorer message, leaving the reply as it is.
      case 'R':
        await toast();
        await this.send(chat, this.recentView());
        return true;
      case 'D':
        await toast();
        await this.send(chat, this.dirView('', 0));
        return true;
      case 'dl':
        if (!abs) return (await toast('Not available')), true;
        await toast('Sending…');
        await this.d.upload('sendDocument', chat, abs).catch(() => this.d.api('sendMessage', { chat_id: chat, text: 'Could not send that file (Telegram bots can send files up to 50 MB).' }));
        return true;
      case 'img':
        if (!abs) return (await toast('Not available')), true;
        await toast();
        await this.d.upload('sendPhoto', chat, abs).catch(() => this.d.upload('sendDocument', chat, abs));
        return true;
      case 'att':
        if (!abs) return (await toast('Not available')), true;
        this.d.attach(abs);
        await toast(`📎 ${path.basename(abs)} will be attached to your next message`);
        return true;
      default:
        await toast();
        return true;
    }
  }

  // ------------------------------------------------------------ views

  dirView(rel: string, page: number): View {
    const root = this.d.root();
    if (!root) return { text: 'Open a folder in VS Code first.', buttons: [] };
    const abs = this.abs(root, rel);
    if (!abs || !isDir(abs)) return this.dirView('', 0);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      /* unreadable folder: show it empty */
    }
    const visible = entries
      .filter((e) => this.hidden || !e.name.startsWith('.'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const dirs = visible.filter((e) => e.isDirectory()).length;
    const pages = Math.max(1, Math.ceil(visible.length / PAGE));
    const p = Math.min(Math.max(page, 0), pages - 1);
    const here = this.id(rel);

    const rows: Btn[][] = visible.slice(p * PAGE, p * PAGE + PAGE).map((e) => {
      const childRel = path.join(rel, e.name);
      if (e.isDirectory()) return [{ text: left(`📁 ${bold(e.name)}`), callback_data: `fb:d:${this.id(childRel)}:0` }];
      const size = sizeOf(path.join(abs, e.name));
      return [{ text: left(`${icon(e.name)} ${e.name}${size !== undefined ? `  ·  ${fmtSize(size)}` : ''}`), callback_data: `fb:f:${this.id(childRel)}:0` }];
    });
    if (pages > 1)
      rows.push([
        { text: p > 0 ? '◀' : '·', callback_data: p > 0 ? `fb:d:${here}:${p - 1}` : 'fb:x' },
        { text: `${p + 1} / ${pages}`, callback_data: 'fb:x' },
        { text: p < pages - 1 ? '▶' : '·', callback_data: p < pages - 1 ? `fb:d:${here}:${p + 1}` : 'fb:x' },
      ]);
    // ".." at the top of the list goes up a level, like a normal file browser.
    if (rel) rows.unshift([{ text: left('⬆ ..'), callback_data: `fb:d:${this.id(path.dirname(rel) === '.' ? '' : path.dirname(rel))}:0` }]);
    const nav: Btn[] = [];
    // Icons only, to keep the row compact.
    nav.push({ text: '🔄', callback_data: `fb:d:${here}:${p}` });
    if (rel) nav.push({ text: '🏠', callback_data: `fb:d:${this.id('')}:0` });
    nav.push({ text: '🕘', callback_data: `fb:r:${here}` });
    nav.push({ text: this.hidden ? '🙈' : '👁', callback_data: `fb:h:${here}:${p}` });
    rows.push(nav);

    const crumbs = [path.basename(root), ...rel.split(/[\\/]/).filter(Boolean)].map(esc).join(' / ');
    const count = `${dirs} folder${dirs === 1 ? '' : 's'} · ${visible.length - dirs} file${visible.length - dirs === 1 ? '' : 's'}`;
    return { text: `📂 <b>${crumbs}</b>\n<i>${count}${visible.length ? '' : ' (empty)'}</i>`, buttons: rows };
  }

  fileView(rel: string, part: number): View {
    const root = this.d.root();
    const abs = root ? this.abs(root, rel) : undefined;
    if (!root || !abs || !fs.existsSync(abs)) return { text: 'That file is gone.', buttons: [[{ text: '📂', callback_data: `fb:d:${this.id('')}:0` }]] };
    if (isDir(abs)) return this.dirView(rel, 0);
    const st = fs.statSync(abs);
    const name = path.basename(abs);
    const id = this.id(rel);
    const parent = path.dirname(rel) === '.' ? '' : path.dirname(rel);
    const head = `${icon(name)} <b>${esc(name)}</b>\n<code>${esc(rel.split(path.sep).join('/'))}</code>\n${fmtSize(st.size)} · changed ${ago(st.mtimeMs)}`;
    const actions: Btn[] = [
      { text: '⬇', callback_data: `fb:dl:${id}` },
      { text: '📎', callback_data: `fb:att:${id}` },
    ];
    const back: Btn[] = [
      { text: '⬅', callback_data: `fb:d:${this.id(parent)}:0` },
      { text: '🔄', callback_data: `fb:f:${id}:${Math.max(part, 0)}` },
      { text: '🕘', callback_data: `fb:r:${id}` },
    ];

    if (IMAGE.test(name)) return { text: `${head}\n\nImage file.`, buttons: [[{ text: '🖼', callback_data: `fb:img:${id}` }, ...actions], back] };
    const text = st.size <= MAX_TEXT ? readText(abs) : undefined;
    if (text === undefined) return { text: `${head}\n\n${st.size > MAX_TEXT ? 'Large file: download it to view.' : 'Binary file: download it to view.'}`, buttons: [actions, back] };

    const parts = paginate(text);
    const p = Math.min(Math.max(part, 0), parts.length - 1);
    const { body, from, to } = parts[p];
    const lang = LANG[path.extname(name).slice(1).toLowerCase()];
    const total = text.split('\n').length;
    const range = total > 1 ? `\n<i>lines ${from}–${to} of ${total}</i>` : '';
    const code = body.trim() ? `<pre><code${lang ? ` class="language-${lang}"` : ''}>${esc(body)}</code></pre>` : '<i>(empty file)</i>';
    const rows: Btn[][] = [];
    if (parts.length > 1)
      rows.push([
        { text: p > 0 ? '◀' : '·', callback_data: p > 0 ? `fb:f:${id}:${p - 1}` : 'fb:x' },
        { text: `${p + 1} / ${parts.length}`, callback_data: 'fb:x' },
        { text: p < parts.length - 1 ? '▶' : '·', callback_data: p < parts.length - 1 ? `fb:f:${id}:${p + 1}` : 'fb:x' },
      ]);
    rows.push(actions, back);
    return { text: `${head}${range}\n${code}`, buttons: rows };
  }

  recentView(): View {
    const root = this.d.root();
    if (!root) return { text: 'Open a folder in VS Code first.', buttons: [] };
    const files = walk(root)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 15);
    const rows = files.map((f) => [{ text: left(`${icon(f.rel)} ${f.rel.split(path.sep).join('/')}  ·  ${ago(f.mtime)}`), callback_data: `fb:f:${this.id(f.rel)}:0` }]);
    rows.push([
      { text: '📂', callback_data: `fb:d:${this.id('')}:0` },
      { text: '🔄', callback_data: 'fb:r:' },
    ]);
    return { text: `🕘 <b>Recently changed</b> in ${esc(path.basename(root))}${files.length ? '' : '\n<i>No files yet.</i>'}`, buttons: rows };
  }

  findView(query: string): View {
    const root = this.d.root();
    if (!root) return { text: 'Open a folder in VS Code first.', buttons: [] };
    const q = query.trim().toLowerCase();
    if (!q) return { text: 'Send <code>/find name</code>, e.g. <code>/find readme</code>.', buttons: [] };
    const hits = walk(root)
      .filter((f) => f.rel.toLowerCase().includes(q))
      .sort((a, b) => Number(!path.basename(a.rel).toLowerCase().includes(q)) - Number(!path.basename(b.rel).toLowerCase().includes(q)) || a.rel.length - b.rel.length);
    const rows = hits.slice(0, 20).map((f) => [{ text: left(`${icon(f.rel)} ${f.rel.split(path.sep).join('/')}`), callback_data: `fb:f:${this.id(f.rel)}:0` }]);
    let qi = this.queries.indexOf(query.trim());
    if (qi < 0) qi = this.queries.push(query.trim()) - 1;
    rows.push([
      { text: '📂', callback_data: `fb:d:${this.id('')}:0` },
      { text: '🔄', callback_data: `fb:q:${qi}` },
    ]);
    const more = hits.length > 20 ? ` (showing 20 of ${hits.length})` : '';
    return { text: `🔎 <b>${hits.length ? `${hits.length} match${hits.length === 1 ? '' : 'es'}` : 'No matches'}</b> for “${esc(query.trim())}”${more}`, buttons: rows };
  }

  // ------------------------------------------------------------ plumbing

  private id(rel: string): number {
    let i = this.ids.get(rel);
    if (i === undefined) {
      i = this.rels.push(rel) - 1;
      this.ids.set(rel, i);
    }
    return i;
  }

  /** Absolute path, only if it stays inside the workspace. */
  private abs(root: string, rel: string): string | undefined {
    const base = path.resolve(root);
    const p = path.resolve(base, rel);
    return p === base || p.startsWith(base + path.sep) ? p : undefined;
  }

  private async send(chat: number, v: View): Promise<void> {
    await this.d.api('sendMessage', { chat_id: chat, text: v.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: v.buttons }, link_preview_options: { is_disabled: true } });
  }

  /** Updates the explorer message; false if nothing changed (Telegram refuses an identical edit). */
  private async edit(chat: number, messageId: number, v: View): Promise<boolean> {
    try {
      await this.d.api('editMessageText', { chat_id: chat, message_id: messageId, text: v.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: v.buttons }, link_preview_options: { is_disabled: true } });
      return true;
    } catch (e) {
      if (/not modified/i.test((e as Error).message)) return false;
      throw e;
    }
  }
}

// ------------------------------------------------------------ helpers

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sizeOf(p: string): number | undefined {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
}

/** Text content, or undefined for binary files. */
function readText(p: string): string | undefined {
  const buf = fs.readFileSync(p);
  if (buf.subarray(0, 8000).includes(0)) return undefined;
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

/** Splits text into message-sized parts on line boundaries. */
function paginate(text: string): { body: string; from: number; to: number }[] {
  const lines = text.split('\n');
  const parts: { body: string; from: number; to: number }[] = [];
  let start = 0;
  while (start < lines.length) {
    let size = 0;
    let end = start;
    while (end < lines.length && (end === start || size + esc(lines[end]).length + 1 <= PREVIEW)) size += esc(lines[end++]).length + 1;
    let body = lines.slice(start, end).join('\n');
    // One huge line: cut it so it still fits once escaped (& < > grow when escaped).
    while (esc(body).length > PREVIEW) body = `${body.slice(0, Math.floor(body.length * 0.8))}…`;
    parts.push({ body, from: start + 1, to: end });
    start = end;
  }
  return parts.length ? parts : [{ body: '', from: 1, to: 1 }];
}

/** Files under root (skipping dependency/build folders and dot-folders), capped for speed. */
function walk(root: string, limit = 20000): { rel: string; mtime: number }[] {
  const out: { rel: string; mtime: number }[] = [];
  const stack = [''];
  let seen = 0;
  while (stack.length && seen < limit) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > limit) break;
      const child = path.join(rel, e.name);
      if (e.isDirectory()) {
        if (!HEAVY.has(e.name) && !e.name.startsWith('.')) stack.push(child);
      } else if (e.isFile()) {
        try {
          out.push({ rel: child, mtime: fs.statSync(path.join(root, child)).mtimeMs });
        } catch {
          /* vanished */
        }
      }
    }
  }
  return out;
}

/**
 * Telegram centers button text and has no alignment option. Padding the label with invisible blanks
 * (U+2800, which Telegram doesn't trim) makes it wider than the button, so it starts at the left edge.
 */
export function left(label: string): string {
  return label + '⠀'.repeat(Math.max(0, 90 - [...label].length));
}

/**
 * Telegram buttons can't be formatted, so folder names use Unicode's sans-serif bold letters and digits
 * (𝗹𝗶𝗸𝗲 𝘁𝗵𝗶𝘀). Other characters (., -, _, accents) stay as they are.
 */
export function bold(s: string): string {
  return [...s]
    .map((c) => {
      const n = c.codePointAt(0)!;
      if (n >= 65 && n <= 90) return String.fromCodePoint(0x1d5d4 + n - 65);
      if (n >= 97 && n <= 122) return String.fromCodePoint(0x1d5ee + n - 97);
      if (n >= 48 && n <= 57) return String.fromCodePoint(0x1d7ec + n - 48);
      return c;
    })
    .join('');
}

export function icon(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE.test(name) || ext === '.svg') return '🖼';
  if (ext === '.md' || ext === '.txt') return '📝';
  if (['.json', '.yml', '.yaml', '.toml', '.ini', '.env', '.lock'].includes(ext)) return '⚙️';
  if (['.pdf'].includes(ext)) return '📕';
  if (['.zip', '.tar', '.gz', '.7z', '.rar', '.vsix'].includes(ext)) return '📦';
  if (['.csv', '.xlsx', '.xls'].includes(ext)) return '📊';
  if (['.mp4', '.mov', '.webm', '.mp3', '.wav'].includes(ext)) return '🎞';
  if (LANG[ext.slice(1)]) return '📜';
  return '📄';
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
