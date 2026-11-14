import type { Thread, ThreadMsg } from './types';

export type ExportFormat = 'json' | 'markdown';

/** One message as exported: who said it, when, and what the turn did (no internal session/run state). */
export interface ExportedMessage {
  at: string;
  role: ThreadMsg['role'];
  author: string;
  text: string;
  attachments?: string[];
  activity?: string[];
  workedMs?: number;
  changes?: { path: string; add: number; del: number; binary?: boolean }[];
  changesUndone?: boolean;
}

export interface ExportedThread {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  parentId?: string;
  messages: ExportedMessage[];
}

/** The JSON export file: the conversation, then the helper threads its agents spun off (in the order they started). */
export interface ConversationExport {
  format: 'super-agent-conversation';
  version: 1;
  exportedAt: string;
  thread: ExportedThread;
  helpers: ExportedThread[];
}

type Labeler = (accountId?: string) => string;

const iso = (ms: number) => new Date(ms).toISOString();

/** The thread and every thread that helps it, directly or through other helpers (oldest first). */
export function helpersOf(threads: Thread[], rootId: string): Thread[] {
  const out: Thread[] = [];
  const seen = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of threads)
      if (t.parentId && seen.has(t.parentId) && !seen.has(t.id)) {
        seen.add(t.id);
        out.push(t);
        grew = true;
      }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

function author(m: ThreadMsg, label: Labeler): string {
  if (m.role === 'user') return 'You';
  if (m.role === 'system') return 'Super Agent';
  return m.accountId ? label(m.accountId) : 'Agent';
}

function exportThread(t: Thread, label: Labeler): ExportedThread {
  return {
    id: t.id,
    title: t.title,
    cwd: t.cwd,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    ...(t.parentId ? { parentId: t.parentId } : {}),
    messages: t.messages.map((m) => ({
      at: iso(m.at),
      role: m.role,
      author: author(m, label),
      text: m.text,
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...(m.activity?.length ? { activity: m.activity } : {}),
      ...(m.workedMs !== undefined ? { workedMs: m.workedMs } : {}),
      ...(m.changes?.files.length ? { changes: m.changes.files.map((f) => ({ ...f })) } : {}),
      ...(m.changes?.undone ? { changesUndone: true } : {}),
    })),
  };
}

export function buildExport(threads: Thread[], rootId: string, label: Labeler, now = Date.now()): ConversationExport {
  const root = threads.find((t) => t.id === rootId);
  if (!root) throw new Error(`No thread ${rootId}`);
  return {
    format: 'super-agent-conversation',
    version: 1,
    exportedAt: iso(now),
    thread: exportThread(root, label),
    helpers: helpersOf(threads, rootId).map((t) => exportThread(t, label)),
  };
}

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const when = (s: string) => s.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

function threadMarkdown(t: ExportedThread, level: number): string {
  const h = '#'.repeat(level);
  const out = [`${h} ${t.title}`, '', `- Folder: \`${t.cwd}\``, `- Started: ${when(t.createdAt)}`, `- Last used: ${when(t.updatedAt)}`, ''];
  for (const m of t.messages) {
    out.push(`${h}# ${m.author} · ${when(m.at)}`, '');
    out.push(m.role === 'system' ? `> ${m.text.replace(/\n/g, '\n> ')}` : m.text, '');
    if (m.attachments?.length) out.push('Attachments:', ...m.attachments.map((a) => `- \`${a}\``), '');
    if (m.changes?.length) {
      out.push(`Changed files${m.changesUndone ? ' (undone)' : ''}:`);
      out.push(...m.changes.map((f) => `- \`${f.path}\` ${f.binary ? '(binary)' : `+${f.add} -${f.del}`}`), '');
    }
    if (m.activity?.length) {
      const summary = m.workedMs !== undefined ? `Worked for ${duration(m.workedMs)}` : 'Activity';
      out.push('<details>', `<summary>${summary}</summary>`, '', ...m.activity.map((a) => `- ${a.replace(/\n/g, ' ')}`), '', '</details>', '');
    }
  }
  return out.join('\n');
}

export function toMarkdown(x: ConversationExport): string {
  const parts = [threadMarkdown(x.thread, 1)];
  if (x.helpers.length) {
    parts.push('---', '', '## Helper threads', '');
    parts.push(...x.helpers.map((t) => threadMarkdown(t, 3)));
  }
  parts.push('---', '', `*Exported from Super Agent on ${when(x.exportedAt)}.*`, '');
  return parts.join('\n');
}

export function render(x: ConversationExport, format: ExportFormat): string {
  return format === 'json' ? JSON.stringify(x, null, 2) + '\n' : toMarkdown(x);
}

/** A file name for the export: the title made safe for any file system. */
export function exportFileName(title: string, format: ExportFormat, now = Date.now()): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'conversation';
  return `${slug}-${new Date(now).toISOString().slice(0, 10)}.${format === 'json' ? 'json' : 'md'}`;
}
