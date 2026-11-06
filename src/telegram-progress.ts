/**
 * Live progress for the Telegram bot: while an agent works, one status message shows who's working, for how long,
 * and what it's doing right now, updated every few seconds. When the agent finishes it goes away (the reply says
 * who answered and how long it took); a stopped or failed run leaves a line saying so.
 */

const EVERY_MS = 4000;
const FRAMES = ['◐', '◓', '◑', '◒'];
/** The steps shown often contain links (a curl URL, a docs page): no link previews (a .json URL becomes a file). */
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

import { ActivityParser } from './engine/activity';

export { ActivityParser };

export interface ProgressDeps {
  api<T = unknown>(method: string, body: Record<string, unknown>): Promise<T>;
  /** Model name of whoever leads the thread right now (it can change on hand-over). */
  agent(threadId: string): string;
  /** working / waiting / idle */
  status(threadId: string): string | undefined;
}

interface Live {
  chat: number;
  messageId?: number;
  creating?: Promise<void>;
  started: number;
  parser: ActivityParser;
  timer: ReturnType<typeof setInterval>;
  frame: number;
  lastText?: string;
}

export class ProgressTracker {
  private live = new Map<string, Live>();

  constructor(private d: ProgressDeps) {}

  has(threadId: string): boolean {
    return this.live.has(threadId);
  }

  /**
   * Posts the status message (once per run). Joining a run already under way (/sync): \`startedAt\` is when it began
   * and \`so far\` the steps it has taken, so the message shows the whole run, not just from now on.
   */
  start(chat: number, threadId: string, startedAt = Date.now(), soFar: string[] = []): void {
    if (this.live.has(threadId)) return;
    const l: Live = { chat, started: startedAt, parser: new ActivityParser(), frame: 0, timer: setInterval(() => void this.render(threadId), EVERY_MS) };
    l.parser.items = soFar.slice(-6).map((s) => (s.length > 110 ? `${s.slice(0, 109)}…` : s));
    this.live.set(threadId, l);
    const v = this.view(threadId, l);
    l.lastText = v.text;
    l.creating = this.d
      .api<{ message_id: number }>('sendMessage', { chat_id: chat, text: v.text, parse_mode: 'HTML', reply_markup: v.markup, disable_notification: true, ...NO_PREVIEW })
      .then((m) => void (l.messageId = m.message_id))
      .catch(() => undefined);
  }

  feed(threadId: string, text: string): void {
    this.live.get(threadId)?.parser.feed(text);
  }

  /**
   * Ends the status message and returns how long the run took. Done: the message goes (the reply that follows says
   * "Opus 5.5 in 2m 13s"); stopped or failed: it stays as a line saying so.
   */
  async finish(threadId: string, outcome: 'done' | 'failed' | 'stopped'): Promise<string | undefined> {
    const l = this.live.get(threadId);
    if (!l) return undefined;
    this.live.delete(threadId);
    clearInterval(l.timer);
    await l.creating;
    const took = elapsed(Date.now() - l.started);
    if (l.messageId === undefined) return took;
    if (outcome === 'done') {
      await this.d.api('deleteMessage', { chat_id: l.chat, message_id: l.messageId }).catch(() => undefined);
      return took;
    }
    const text = outcome === 'stopped' ? `⏹ Stopped after ${took}` : `⚠️ <b>${esc(this.d.agent(threadId))}</b> could not finish (${took})`;
    await this.d.api('editMessageText', { chat_id: l.chat, message_id: l.messageId, text, parse_mode: 'HTML', ...NO_PREVIEW }).catch(() => undefined);
    return took;
  }

  stopAll(): void {
    for (const l of this.live.values()) clearInterval(l.timer);
    this.live.clear();
  }

  private async render(threadId: string): Promise<void> {
    const l = this.live.get(threadId);
    if (!l || l.messageId === undefined) return;
    // The run ended without a finish call (e.g. stopped from VS Code): close the message.
    if (this.d.status(threadId) === 'idle' || this.d.status(threadId) === undefined) return void (await this.finish(threadId, 'stopped'));
    l.frame++;
    const v = this.view(threadId, l);
    if (v.text === l.lastText) return;
    l.lastText = v.text;
    await this.d.api('editMessageText', { chat_id: l.chat, message_id: l.messageId, text: v.text, parse_mode: 'HTML', reply_markup: v.markup, ...NO_PREVIEW }).catch(() => undefined);
  }

  private view(threadId: string, l: Live): { text: string; markup: unknown } {
    const waiting = this.d.status(threadId) === 'waiting';
    const head = waiting
      ? `⏳ <b>Waiting for a free agent…</b> · ${elapsed(Date.now() - l.started)}`
      : `${FRAMES[l.frame % FRAMES.length]} 🤖 <b>${esc(this.d.agent(threadId))}</b> is working · ${elapsed(Date.now() - l.started)}`;
    const items = l.parser.items;
    const body = items.length ? `\n<blockquote>${items.map(esc).join('\n')}</blockquote>` : '\n<i>starting…</i>';
    return { text: head + body, markup: { inline_keyboard: [[{ text: '⏹ Stop', callback_data: `pg:stop:${threadId}` }]] } };
  }
}

export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
