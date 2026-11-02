/**
 * Live progress for the Telegram bot: while an agent works, one status message shows who's working, for how long,
 * and what it's doing right now, updated every few seconds; it turns into "Done in …" when the agent finishes.
 */

const EVERY_MS = 4000;
const FRAMES = ['◐', '◓', '◑', '◒'];

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

  /** Posts the status message (once per run). */
  start(chat: number, threadId: string): void {
    if (this.live.has(threadId)) return;
    const l: Live = { chat, started: Date.now(), parser: new ActivityParser(), frame: 0, timer: setInterval(() => void this.render(threadId), EVERY_MS) };
    this.live.set(threadId, l);
    const v = this.view(threadId, l);
    l.lastText = v.text;
    l.creating = this.d
      .api<{ message_id: number }>('sendMessage', { chat_id: chat, text: v.text, parse_mode: 'HTML', reply_markup: v.markup, disable_notification: true })
      .then((m) => void (l.messageId = m.message_id))
      .catch(() => undefined);
  }

  feed(threadId: string, text: string): void {
    this.live.get(threadId)?.parser.feed(text);
  }

  /** Turns the status message into a summary line ("✅ Done in 2m 13s"). */
  async finish(threadId: string, outcome: 'done' | 'failed' | 'stopped'): Promise<void> {
    const l = this.live.get(threadId);
    if (!l) return;
    this.live.delete(threadId);
    clearInterval(l.timer);
    await l.creating;
    if (l.messageId === undefined) return;
    const took = elapsed(Date.now() - l.started);
    const text =
      outcome === 'done'
        ? `✅ <b>${esc(this.d.agent(threadId))}</b> finished in ${took}`
        : outcome === 'stopped'
          ? `⏹ Stopped after ${took}`
          : `⚠️ <b>${esc(this.d.agent(threadId))}</b> could not finish (${took})`;
    await this.d.api('editMessageText', { chat_id: l.chat, message_id: l.messageId, text, parse_mode: 'HTML' }).catch(() => undefined);
  }

  stopAll(): void {
    for (const l of this.live.values()) clearInterval(l.timer);
    this.live.clear();
  }

  private async render(threadId: string): Promise<void> {
    const l = this.live.get(threadId);
    if (!l || l.messageId === undefined) return;
    // The run ended without a finish call (e.g. stopped from VS Code): close the message.
    if (this.d.status(threadId) === 'idle' || this.d.status(threadId) === undefined) return this.finish(threadId, 'stopped');
    l.frame++;
    const v = this.view(threadId, l);
    if (v.text === l.lastText) return;
    l.lastText = v.text;
    await this.d.api('editMessageText', { chat_id: l.chat, message_id: l.messageId, text: v.text, parse_mode: 'HTML', reply_markup: v.markup }).catch(() => undefined);
  }

  private view(threadId: string, l: Live): { text: string; markup: unknown } {
    const waiting = this.d.status(threadId) === 'waiting';
    const head = waiting
      ? `⏳ <b>Waiting for a free agent…</b> · ${elapsed(Date.now() - l.started)}`
      : `${FRAMES[l.frame % FRAMES.length]} <b>${esc(this.d.agent(threadId))}</b> is working · ${elapsed(Date.now() - l.started)}`;
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
