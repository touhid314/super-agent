import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account, AgentKind } from '../core/types';
import type { Thread, ThreadSession } from './types';

/** Works with every provider: the relay uploads referenced local media after the final reply. */
export const MEDIA_DELIVERY = `<super-agent-media>
To deliver a local image or video to the user, include a Markdown link to the finished file in your final reply, e.g. [Video](<./output/my video.mp4>) or ![Preview](<./output/preview.png>). Use workspace-relative or absolute local paths; do not claim a file was sent yourself. When Telegram is connected, Super Agent uploads up to 5 referenced media files to the paired chat automatically. Videos/files must be at most 50 MB; larger outputs need a smaller export. Mention only the files you intend to deliver.
</super-agent-media>

`;

/**
 * Carry an agent's exact conversation to another account of the same CLI by copying the session
 * transcript into the new account's config folder (the new agent then resumes it). Returns false if
 * the transcript can't be found, in which case the caller falls back to a written brief.
 */
export function transferSession(session: ThreadSession, from: Account, to: Account): boolean {
  if (from.kind !== to.kind || from.id === to.id) return from.id === to.id;
  try {
    const src = sessionFile(session, from);
    if (!src || (session.kind !== 'claude' && session.kind !== 'codex')) return false;
    const fromRoot = sessionRoot(session.kind, from);
    const dest = path.join(sessionRoot(session.kind, to), path.relative(fromRoot, src));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch {
    /* fall back to a brief */
  }
  return false;
}

function sessionRoot(kind: 'claude' | 'codex', acc: Account): string {
  return kind === 'claude'
    ? path.join(acc.home ?? path.join(os.homedir(), '.claude'), 'projects')
    : path.join(acc.home ?? path.join(os.homedir(), '.codex'), 'sessions');
}

/** The session's transcript file in the account's config folder (Claude Code or Codex), or null. */
export function sessionFile(session: ThreadSession, from: Account): string | null {
  try {
    if (session.kind === 'claude') {
      const root = sessionRoot('claude', from);
      for (const dir of fs.readdirSync(root)) {
        const f = path.join(root, dir, `${session.id}.jsonl`);
        if (fs.existsSync(f)) return f;
      }
      return null;
    }
    if (session.kind === 'codex') {
      const root = sessionRoot('codex', from);
      const rel = findFile(root, (n) => n.includes(session.id) && n.endsWith('.jsonl'));
      return rel ? path.join(root, rel) : null;
    }
  } catch {
    /* not found */
  }
  return null;
}

/** Keep the start and the end of a long text (the end usually holds the result or the error). */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  return `${s.slice(0, head)}\n… [${s.length - max} characters omitted] …\n${s.slice(s.length - (max - head))}`;
}

/** Super Agent's own per-turn plumbing, which the next agent gets afresh; and CLI-injected reminders. */
function stripPlumbing(s: string): string {
  return s
    .replace(/<super-agent-(internal|media)>[\s\S]*?<\/super-agent-\1>\s*/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>\s*/g, '')
    .trim();
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((c: { type?: string; text?: string }) => (typeof c === 'string' ? c : c?.type === 'image' || c?.type === 'input_image' ? '[image]' : (c?.text ?? '')))
    .filter(Boolean)
    .join('\n');
}

/** Opaque encrypted payloads (Codex) mean nothing to another agent. */
const unreadable = (s: string) => s.replace(/gAAAAA[\w-]{80,}=*/g, '[encrypted]');

function toolInput(input: unknown): string {
  if (typeof input === 'string') {
    try {
      return toolInput(JSON.parse(input));
    } catch {
      return input;
    }
  }
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    // The common shapes, readably: a command, or a file edit.
    if (typeof o.command === 'string' || Array.isArray(o.command)) return [o.command].flat().join(' ') + (o.description ? `   # ${o.description}` : '');
    return JSON.stringify(input, null, 1);
  }
  return String(input ?? '');
}

/**
 * The previous agent's whole session, as readable blocks (oldest first): every user message, every reply, every tool
 * call with its input and output. Hidden reasoning is not stored readably by the CLIs, so it can't be carried over.
 * `maxOut` caps each tool input/output (keeping its start and end).
 */
export function renderTranscript(file: string, kind: AgentKind, maxOut: number): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  const user = (s: string) => {
    const v = stripPlumbing(s);
    if (v) out.push(`USER:\n${v}`);
  };
  for (const line of unreadable(raw).split('\n')) {
    if (!line.trim()) continue;
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (kind === 'claude') {
      if ((d.type !== 'user' && d.type !== 'assistant') || d.isSidechain || !d.message) continue;
      const content = d.message.content;
      if (d.isCompactSummary) {
        out.push(`EARLIER CONTEXT (the CLI's own summary):\n${textOf(content)}`);
        continue;
      }
      if (d.isMeta) continue;
      if (typeof content === 'string') {
        if (d.type === 'user') user(content);
        else out.push(`AGENT:\n${content}`);
        continue;
      }
      for (const c of Array.isArray(content) ? content : []) {
        if (c.type === 'text' && c.text) {
          if (d.type === 'user') user(c.text);
          else out.push(`AGENT:\n${c.text}`);
        } else if (c.type === 'tool_use') out.push(`TOOL CALL ${c.name}:\n${clip(toolInput(c.input), maxOut)}`);
        else if (c.type === 'tool_result') out.push(`TOOL RESULT${c.is_error ? ' (error)' : ''}:\n${clip(textOf(c.content), maxOut)}`);
      }
    } else if (kind === 'codex') {
      if (d.type === 'compacted' && d.payload?.message) {
        out.push(`EARLIER CONTEXT (the CLI's own summary):\n${d.payload.message}`);
        continue;
      }
      if (d.type !== 'response_item') continue;
      const p = d.payload ?? {};
      if (p.type === 'message') {
        if (p.role === 'user') {
          const v = textOf(p.content);
          if (!/^\s*(# AGENTS\.md|<user_instructions>|<environment_context>)/.test(v)) user(v);
        } else if (p.role === 'assistant') {
          const v = textOf(p.content).trim();
          if (v) out.push(`AGENT:\n${v}`);
        }
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        out.push(`TOOL CALL ${p.name ?? 'shell'}:\n${clip(toolInput(p.arguments ?? p.input ?? p.action), maxOut)}`);
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const o = typeof p.output === 'string' ? p.output : textOf(p.output?.content ?? p.output);
        out.push(`TOOL RESULT:\n${clip(o, maxOut)}`);
      } else if (p.type === 'reasoning' && Array.isArray(p.summary) && p.summary.length) {
        out.push(`AGENT (reasoning summary):\n${textOf(p.summary)}`);
      }
    }
  }
  return out;
}

/** The newest blocks that fit in `budget` characters, oldest first, and how many older ones were left out. */
function newestThatFit(blocks: string[], budget: number): { kept: string[]; dropped: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (used + blocks[i].length + 2 > budget && kept.length) return { kept: kept.reverse(), dropped: i + 1 };
    kept.push(blocks[i]);
    used += blocks[i].length + 2;
  }
  return { kept: kept.reverse(), dropped: 0 };
}

function findFile(root: string, match: (name: string) => boolean, rel = ''): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) {
    const r = path.join(rel, e.name);
    if (e.isFile() && match(e.name)) return r;
    if (e.isDirectory()) {
      const f = findFile(root, match, r);
      if (f) return f;
    }
  }
  return null;
}

/** Where the previous agent's session can be read from, and what the new agent can take. */
export interface BriefSource {
  session?: ThreadSession;
  /** The account that ran `session`. */
  from?: Account;
  /** The CLI taking over. Antigravity gets its prompt as a command-line argument, so it gets a short inline part. */
  toKind?: AgentKind;
  /** Folder to save the complete transcript in (the new agent reads the parts that don't fit inline). */
  outDir?: string;
}

/** Characters carried inline (prompts on stdin can be large; a Windows command line can't). */
const INLINE = { transcript: 160_000, convo: 40_000, perMessage: 12_000, perTool: 6_000 };
const INLINE_ARGV = { transcript: 12_000, convo: 6_000, perMessage: 2_500, perTool: 1_500 };

/**
 * Hand-over for a different CLI (or when a transcript can't be moved). As much of the previous agent's own context as
 * possible: its complete session transcript (messages, tool calls and their outputs) inline up to a large budget, with
 * the full transcript saved to a file for anything older; then the thread's conversation, and the state of the files.
 * Without a readable transcript (Antigravity, or a missing file) it falls back to the steps and output Super Agent saw.
 */
export function contextBrief(t: Thread, labelOf: (id?: string) => string, why: string, src: BriefSource = {}): string {
  const lim = src.toKind === 'antigravity' ? INLINE_ARGV : INLINE;
  let transcript = '';
  let transcriptFile = '';
  const file = src.session && src.from && src.session.kind !== 'antigravity' ? sessionFile(src.session, src.from) : null;
  if (file && src.session) {
    const full = renderTranscript(file, src.session.kind, 40_000);
    if (full.length) {
      if (src.outDir) {
        try {
          fs.mkdirSync(src.outDir, { recursive: true });
          transcriptFile = path.join(src.outDir, `${t.id}-${Date.now()}.md`);
          fs.writeFileSync(transcriptFile, `# Full session of ${labelOf(src.session.accountId)} (oldest first)\n\n${full.join('\n\n---\n\n')}\n`);
        } catch {
          transcriptFile = '';
        }
      }
      const inline = lim === INLINE ? renderTranscript(file, src.session.kind, lim.perTool) : full.map((b) => clip(b, lim.perTool));
      const { kept, dropped } = newestThatFit(inline, lim.transcript);
      const older = dropped
        ? `[${dropped} earlier entries are not shown here${transcriptFile ? `; read them in ${transcriptFile}` : ''}.]\n\n`
        : '';
      transcript = older + kept.join('\n\n---\n\n');
    }
  }
  const messages = t.messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? 'USER' : labelOf(m.accountId).toUpperCase()}: ${clip(m.text, lim.perMessage)}`);
  const { kept: convoKept, dropped: convoDropped } = newestThatFit(messages, transcript ? lim.convo / 2 : lim.convo);
  const convo = (convoDropped ? `[${convoDropped} earlier messages not shown.]\n\n` : '') + convoKept.join('\n\n');
  // The request in progress (a take-over mid-task): what was said and done so far, step by step. Or, after a turn
  // that was cut off (VS Code closed, stopped), the steps it got through: "continue" means carry on from there.
  // (The latest such turn since the last answer; notes like "c leads this thread now" may come after it.)
  const since = t.messages.slice(t.messages.map((m) => m.role).lastIndexOf('agent') + 1);
  const cut = since.filter((m) => m.role === 'system' && m.activity?.length).at(-1);
  const items = t.work?.items.length ? t.work.items : (cut?.activity ?? []);
  const steps = items.filter((s) => !s.startsWith('💭')).slice(-60);
  const plain = (s: string) => s.replace(/^▶\s*/u, 'Ran ').replace(/^(💬|🏁|🔧|✏️|🔎)\s*/u, '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const doneSoFar = steps.map((s) => `- ${plain(s)}`).join('\n');
  const logMax = src.toKind === 'antigravity' ? 4000 : 20_000;
  let lastWork = '';
  try {
    if (t.lastLog && !doneSoFar && !transcript) {
      const log = fs.readFileSync(t.lastLog, 'utf8');
      lastWork = log.length > logMax ? '…' + log.slice(-logMax) : log;
    }
  } catch {
    /* no log yet */
  }
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: t.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
    } catch {
      return '';
    }
  };
  const status = git(['status', '--short']);
  const stat = git(['diff', '--stat']);
  return [
    `## Context hand-over (${why})`,
    transcript
      ? "You are continuing work another agent started in this folder. Below is that agent's own session: what the user said, what it replied, and every tool call it made with the output it saw. Treat it as your own memory. Continue seamlessly: do not start over, do not redo finished work, and do not re-read files just to rediscover what is already shown here unless they may have changed since."
      : 'You are continuing work another agent started in this folder. Everything it knew is summarised below. Continue seamlessly: do not start over, do not redo finished work.',
    transcript &&
      `### The previous agent's session (${labelOf(src.session?.accountId)}; oldest first; long outputs trimmed in the middle${transcriptFile ? `; complete copy: ${transcriptFile}` : ''})\n${transcript}`,
    convo && `### Conversation in this thread${transcript ? ' (all agents; the same user messages may appear above)' : ' so far'}\n${convo}`,
    doneSoFar &&
      (transcript
        ? '### Note\nThe previous agent stopped in the middle of the current request (its session above ends there). Its last step may not have finished, so check the files it was working on before relying on them; then carry on from there.'
        : `### The current request: what was done so far (oldest first)\nThe previous agent stopped in the middle of this request. Its last step may not have finished, so check the files it was working on before relying on them; then carry on from there.\n${doneSoFar}`),
    lastWork && `### What the previous agent was doing most recently (its own output)\n${lastWork}`,
    (status || stat) && `### Current uncommitted changes in the folder\n${status}\n${stat}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * For Antigravity, every turn. Headless it works silently (command after command, nothing in between), while Claude
 * Code and Codex say what they're doing as they go; asked to, it narrates the same way, so its work can be followed.
 */
export const NARRATE = `<super-agent-internal>
The user follows your work live, so give a short progress update (one sentence, plain text) at the moments that matter: when you start a new phase of the work (investigating, changing code, testing), when you find something important, and when your plan changes. Not before every command or file you read: routine steps go by without comment.
Keep progress updates separate from your last response. Your last response is the final answer to the user: give the result directly, without repeating progress narration or internal thinking.
</super-agent-internal>

`;

/**
 * What every agent (lead or helper) is told once per session. These are strong agents: they get the facts and the
 * mechanism, not a playbook.
 */
export function leadPreamble(handoffDir: string, teamFile: string): string {
  return `<super-agent-internal>
You lead a team in Super Agent: other strong coding agents (Codex, Claude Code, Antigravity) work in this same folder, and you finish fastest by keeping all of them busy.
- To give a teammate a task, write a Markdown file in \`${handoffDir}/\` (first line: a title; then what to do and which files it owns). A free teammate starts on it at once. Don't edit files you handed off.
- Whenever a teammate is free and there is work that can run alongside yours (another item of a batch, a side check, tests, research), hand it over right away rather than doing it yourself. One task per free teammate; do yourself only what can't be split.
- You are told the moment a teammate finishes (with its report) and who is free then. Leading comes first: check the result, give the free teammate its next task, then continue your own work.
- \`${teamFile}\` shows live who is free or busy and every task's status.
Keep this plumbing out of your replies unless the user asks about it.
</super-agent-internal>

`;
}

/** A hand-off, as the helper that picks it up sees it. */
export function helperPrompt(leadLabel: string, leadGoal: string, request: string, owns: string): string {
  return `## Your task: a hand-off from ${leadLabel}${leadGoal ? ` (working on "${leadGoal}")` : ''}
${request}

Others are working in this folder at the same time: change only the files this task owns${owns ? ` (${owns})` : ''}. When done, reply with a short report: what you did, files changed, anything ${leadLabel} must know.`;
}
