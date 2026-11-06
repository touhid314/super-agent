import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Engine } from './engine/engine';
import { FileBrowser } from './telegram-files';
import { esc, markdownToTelegram } from './telegram-md';
import { ProgressTracker, elapsed } from './telegram-progress';
import { TeamPanel, type TeamDeps } from './telegram-team';
import type { Thread } from './engine/types';

/** Where the relay keeps its pairing and thread choice. */
export interface RelayStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): unknown;
}

/**
 * A JSON file read on every access, so all VS Code windows see the same pairing code and paired chat
 * (each window has its own extension host; only one of them answers the bot at a time).
 */
export class FileStore implements RelayStore {
  constructor(private file: string) {}
  private read(): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }
  get<T>(key: string): T | undefined {
    return this.read()[key] as T | undefined;
  }
  update(key: string, value: unknown): void {
    const data = this.read();
    if (value === undefined) delete data[key];
    else data[key] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
  }
}

export interface RelayDeps {
  engine: Engine;
  store: RelayStore;
  /** Lock file shared by all VS Code windows, so only one of them answers the bot. */
  lockFile: string;
  cwd(): string | undefined;
  /** Folder for files sent from Telegram (the project's attachments folder in Super Agent's data). */
  attachmentDir(): string | undefined;
  /** Model name for an account, e.g. "Opus 5.5". */
  agentName(accountId?: string): string;
  /** /team: list and change who's on the team, the lead, and models. */
  team: Omit<TeamDeps, 'api'>;
  log(line: string): void;
  onChange(): void;
  fetch?: typeof fetch;
}

export type RelayState = 'off' | 'pairing' | 'on' | 'standby' | 'error';

const API = 'https://api.telegram.org';
const CHUNK = 4000; // Telegram's limit is 4096 characters per message
const HELP = [
  'Super Agent relays your messages to the agents on your laptop.',
  '',
  'Just type to talk to the team. Photos and files are attached.',
  "/team: who's on the team and who leads (tap to change)",
  '/files: explore the workspace folder',
  '/recent: recently changed files',
  '/find NAME: search the workspace',
  '/sync: catch up with VS Code (the running thread, live)',
  '/new: start a new thread',
  '/threads: recent threads (switch with /use N)',
  '/stop: stop the current thread',
].join('\n');

interface TgCallback {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

interface TgMessage {
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: { file_id: string; file_size?: number }[];
  document?: { file_id: string; file_name?: string };
}

/**
 * Telegram bot relay: messages from your (paired) chat go to the same engine the panel uses, and replies come back.
 * It long-polls Telegram, so nothing has to be reachable from the internet.
 */
export class TelegramRelay {
  state: RelayState = 'off';
  error?: string;
  private token?: string;
  private abort?: AbortController;
  private offset = 0;
  private typing?: ReturnType<typeof setInterval>;
  /** Files picked in the explorer ("Ask about it"), attached to the next message. */
  private pendingFiles: string[] = [];
  readonly files: FileBrowser;
  readonly team: TeamPanel;
  /** Live "… is working" status message per running thread. */
  private progress: ProgressTracker;

  constructor(private d: RelayDeps) {
    this.team = new TeamPanel({ ...d.team, api: (method, body) => this.api(method, body) });
    this.progress = new ProgressTracker({
      api: (method, body) => this.api(method, body),
      agent: (id) => this.d.agentName(this.d.engine.get(id)?.leadId),
      status: (id) => this.d.engine.get(id)?.status,
    });
    this.files = new FileBrowser({
      api: (method, body) => this.api(method, body),
      upload: (method, chat, file) => this.upload(method, chat, file),
      root: () => this.d.cwd(),
      attach: (file) => {
        if (!this.pendingFiles.includes(file)) this.pendingFiles.push(file);
      },
    });
  }

  get chatId(): number | undefined {
    return this.d.store.get<number>('telegram.chat');
  }
  /** While unpaired: the code that pairs a chat (sent by the t.me/<bot>?start=CODE link, or typed). */
  get pairCode(): string | undefined {
    return this.d.store.get<string>('telegram.pairCode');
  }
  /** Keeps one code until pairing succeeds, so a QR code shown earlier (or in another window) stays valid. */
  ensurePairCode(): void {
    if (this.chatId === undefined && !this.pairCode) void this.d.store.update('telegram.pairCode', String(randomInt(100000, 1000000)));
  }
  private get current(): string | undefined {
    return this.d.store.get<string>('telegram.thread');
  }
  private setCurrent(id: string | undefined): void {
    void this.d.store.update('telegram.thread', id);
  }
  private get tracked(): string[] {
    return this.d.store.get<string[]>('telegram.threads') ?? [];
  }
  private track(id: string): void {
    void this.d.store.update('telegram.threads', [id, ...this.tracked.filter((x) => x !== id)].slice(0, 200));
  }

  /** Checks a token with Telegram and returns the bot's @username. */
  async verify(token: string): Promise<string> {
    // Checked on its own, so a running bot keeps its token if this one is rejected.
    const res = await this.http(`${API}/bot${token}/getMe`, { method: 'POST' });
    const json = (await res.json()) as { ok: boolean; result?: { username: string }; description?: string };
    if (!json.ok || !json.result) throw new Error(json.description ?? `Telegram error ${res.status}`);
    return json.result.username;
  }

  start(token: string): void {
    this.stop();
    this.token = token;
    this.ensurePairCode();
    this.error = undefined;
    this.setState(this.chatId === undefined ? 'pairing' : 'on');
    this.abort = new AbortController();
    void this.api('setMyCommands', {
      commands: [
        { command: 'team', description: 'Team, lead and models' },
        { command: 'files', description: 'Explore the workspace' },
        { command: 'recent', description: 'Recently changed files' },
        { command: 'find', description: 'Search files by name' },
        { command: 'sync', description: 'Catch up with VS Code (the running thread)' },
        { command: 'new', description: 'Start a new thread' },
        { command: 'threads', description: 'Recent threads' },
        { command: 'stop', description: 'Stop the current thread' },
        { command: 'help', description: 'How this works' },
      ],
    }).catch(() => undefined);
    void this.poll(this.abort.signal);
    // Show "typing…" in Telegram while an agent works on one of your threads.
    this.typing = setInterval(() => {
      if (this.live && this.d.engine.threads.some((t) => t.status === 'working' && this.isTracked(t)))
        void this.api('sendChatAction', { chat_id: this.chatId, action: 'typing' }).catch(() => undefined);
    }, 4500);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
    if (this.typing) clearInterval(this.typing);
    this.progress?.stopAll();
    this.releaseLock();
    if (this.state !== 'off') this.setState('off');
  }

  /** Forgets the paired chat (a new pairing is needed). */
  unpair(): void {
    for (const k of ['telegram.chat', 'telegram.thread', 'telegram.pairCode']) void this.d.store.update(k, undefined);
  }

  /**
   * Whether this window sends to the chat. Any window does while Telegram is on (only receiving is one window's job,
   * see standby): the chat follows work wherever it runs. Nothing while it's off.
   */
  private get live(): boolean {
    return (this.state === 'on' || this.state === 'standby') && this.chatId !== undefined;
  }

  /**
   * Synced with the panel: a message you send in VS Code shows in the chat too (silently: you just wrote it), and the
   * chat follows that thread from then on: its progress and the agent's reply (with a notification) come to Telegram,
   * and what you write in Telegram continues it.
   */
  async onPanelMessage(t: Thread, text: string, files: string[]): Promise<void> {
    if (!this.live || t.helperFile) return;
    const chat = this.chatId!;
    const switched = t.id !== this.current;
    this.track(t.id);
    this.setCurrent(t.id);
    const attached = files.map((f) => `📎 ${path.basename(f)}`).join('\n');
    const body = [text, attached].filter(Boolean).join('\n\n');
    const header = `<b>👤 You</b><i> · VS Code${switched ? ` · ${esc(t.title)}` : ''}</i>`;
    await this.replyMarkdown(chat, body || '(attachments)', header, `👤 You · VS Code${switched ? ` · ${t.title}` : ''}:\n\n${body}`, undefined, true);
    if (t.status === 'working' || t.status === 'waiting') this.progress.start(chat, t.id);
  }

  /** Live agent output: drives the "… is working" status message for your threads. */
  onOutput(threadId: string, text: string): void {
    if (!this.live) return;
    const t = this.d.engine.get(threadId);
    if (!t || t.helperFile || !this.isTracked(t)) return;
    this.progress.start(this.chatId!, threadId);
    this.progress.feed(threadId, text);
  }

  /** Called when any thread finishes: replies on your threads go back to Telegram. */
  async onFinished(t: Thread, outcome: 'done' | 'failed'): Promise<void> {
    if (!this.live || t.helperFile || !this.isTracked(t)) return;
    const last = [...t.messages].reverse().find((m) => (outcome === 'done' ? m.role === 'agent' : m.role !== 'user'));
    const stopped = outcome === 'failed' && !!last && last.role === 'system' && /stopp/i.test(last.text);
    const took = await this.progress.finish(t.id, outcome === 'done' ? 'done' : stopped ? 'stopped' : 'failed');
    if (stopped) return; // the status message already says so
    if (!last) return;
    // Who answered and how long it took, in the reply itself ("🤖 Opus 5.5 in 33s"): no separate "finished" message.
    const time = took ?? (last.workedMs ? elapsed(last.workedMs) : undefined);
    const who = last.role === 'agent' ? `🤖 ${this.d.agentName(last.accountId)}` : '⚠️ Super Agent';
    const timed = last.role === 'agent' && time ? ` in ${time}` : '';
    const where = t.id === this.current ? '' : ` · ${t.title}`;
    // Quick ways to look at what the agent just changed.
    // (Uppercase actions open a new explorer message, so the reply itself stays.)
    const browse = { inline_keyboard: [[{ text: '🕘 Recent changes', callback_data: 'fb:R' }, { text: '📁 Files', callback_data: 'fb:D' }]] };
    const header = `<b>${esc(who)}</b>${timed}${where ? `<i>${esc(where)}</i>` : ''}`;
    await this.replyMarkdown(this.chatId!, last.text, header, `${who}${timed}${where}:\n\n${last.text}`, outcome === 'done' ? browse : undefined);
    for (const img of imagesIn(last.text, t.cwd).slice(0, 5)) await this.sendPhoto(img).catch((e) => this.d.log(`Telegram photo: ${e.message}`));
  }

  // ------------------------------------------------------------ polling

  private async poll(signal: AbortSignal): Promise<void> {
    let wait = 1000;
    while (!signal.aborted) {
      if (!this.takeLock()) {
        // Another VS Code window answers the bot; check back in a while.
        if (this.state !== 'standby') this.setState('standby');
        await sleep(15000, signal);
        continue;
      }
      // Pairing may have happened in another window (the store is shared).
      if (this.state === 'standby' || (this.state === 'pairing' && this.chatId !== undefined)) this.setState(this.chatId === undefined ? 'pairing' : 'on');
      try {
        const updates = await this.api<{ update_id: number; message?: TgMessage; callback_query?: TgCallback }[]>(
          'getUpdates',
          { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
          signal,
        );
        wait = 1000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message) await this.onMessage(u.message).catch((e) => this.d.log(`Telegram: ${e.message}`));
          if (u.callback_query) await this.onTap(u.callback_query).catch((e) => this.d.log(`Telegram: ${e.message}`));
        }
      } catch (e) {
        if (signal.aborted) return;
        const err = e as Error & { code?: number };
        if (err.code === 401 || err.code === 404) {
          this.error = 'Telegram rejected the bot token.';
          this.setState('error');
          return;
        }
        this.d.log(`Telegram: ${err.message}`);
        await sleep(wait, signal);
        wait = Math.min(wait * 2, 30000);
      }
    }
  }

  /** Inline button taps (the file explorer). Only the paired chat may use them. */
  private async onTap(q: TgCallback): Promise<void> {
    const chat = q.message?.chat.id;
    if (chat === undefined || chat !== this.chatId) {
      await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'This bot is private.' }).catch(() => undefined);
      return;
    }
    const id = q.message!.message_id;
    const stop = /^pg:stop:(.+)$/.exec(q.data ?? '');
    if (stop) {
      this.d.engine.stop(stop[1]);
      await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'Stopping…' }).catch(() => undefined);
      return;
    }
    const handled = (await this.files.onCallback(chat, id, q.id, q.data ?? '')) || (await this.team.onCallback(chat, id, q.id, q.data ?? ''));
    if (!handled) await this.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => undefined);
  }

  private async onMessage(m: TgMessage): Promise<void> {
    const chat = m.chat.id;
    const text = (m.text ?? m.caption ?? '').trim();
    if (this.chatId === undefined) {
      // The QR link sends "/start CODE"; typing the code (or "/pair CODE") works too.
      const code = /^(?:\/(?:pair|start)\s+)?(\d{6})$/.exec(text)?.[1];
      if (this.pairCode && code === this.pairCode) {
        await this.d.store.update('telegram.chat', chat);
        await this.d.store.update('telegram.pairCode', undefined);
        this.setState('on');
        await this.reply(chat, `Paired with Super Agent on your laptop.\n\n${HELP}`);
      } else {
        await this.reply(chat, 'To pair this chat, send the 6-digit code shown on the Telegram card in VS Code (Super Agent panel).');
      }
      return;
    }
    if (chat !== this.chatId) {
      await this.reply(chat, 'This bot is private.');
      return;
    }

    const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(text);
    if (cmd && !m.photo && !m.document) {
      const [, name, arg] = cmd;
      if (name === 'start' || name === 'help') return void (await this.reply(chat, HELP));
      if (name === 'new') {
        this.setCurrent(undefined);
        return void (await this.reply(chat, 'OK, your next message starts a new thread.'));
      }
      if (name === 'threads') return void (await this.reply(chat, this.threadList()));
      if (name === 'sync') return void (await this.sync(chat));
      if (name === 'use') {
        const t = this.recent()[Number(arg) - 1];
        if (!t) return void (await this.reply(chat, 'No such thread. Send /threads to see the list.'));
        this.setCurrent(t.id);
        this.track(t.id);
        return void (await this.reply(chat, `Now in "${t.title}". Your messages continue this thread.`));
      }
      if (name === 'stop') {
        const t = this.current ? this.d.engine.get(this.current) : undefined;
        if (!t || t.status === 'idle') return void (await this.reply(chat, 'Nothing is running in the current thread.'));
        this.d.engine.stop(t.id);
        return void (await this.reply(chat, 'Stopped.'));
      }
      if (name === 'team' || name === 'agents') return void (await this.team.open(chat));
      if (name === 'files' || name === 'ls') return void (await this.files.open(chat));
      if (name === 'recent') return void (await this.files.recent(chat));
      if (name === 'find' || name === 'search') return void (await this.files.find(chat, arg));
      return void (await this.reply(chat, `Unknown command.\n\n${HELP}`));
    }

    const cwd = this.d.cwd();
    if (!cwd) return void (await this.reply(chat, 'Open a folder in VS Code first: the agents work in the open workspace folder.'));
    const sent = await this.download(m).catch((e) => {
      this.d.log(`Telegram download: ${e.message}`);
      return [] as string[];
    });
    if (!text && !sent.length) return;
    // Files picked in the explorer ("Ask about it") ride along with this message.
    const files = [...this.pendingFiles, ...sent];
    this.pendingFiles = [];

    const before = new Map(this.d.engine.threads.map((t) => [t.id, t.messages.length]));
    const current = this.current;
    const t = this.d.engine.send(current, text, cwd, files);
    this.track(t.id);
    // A message to a busy lead may become its own thread; your conversation stays where it was.
    if (!current || (t.id !== current && t.parentId !== current)) this.setCurrent(t.id);
    // Tell the user about hand-offs and queueing (system notes this message caused).
    const notes = [current, t.id]
      .map((id) => (id ? this.d.engine.get(id) : undefined))
      .flatMap((x) => (x ? x.messages.slice(before.get(x.id) ?? 0).filter((n) => n.role === 'system') : []));
    if (notes.length) await this.reply(chat, notes.map((n) => n.text).join('\n'));
    // Show progress right away (not only once the agent prints something).
    if (t.status === 'working' || t.status === 'waiting') this.progress.start(chat, t.id);
  }

  /**
   * /sync: the chat catches up with VS Code. The thread working right now (else the one used last) becomes the one
   * Telegram follows: your prompt in it shows here, then its live progress with every step so far (or, if it's done,
   * its answer), and from then on it's synced like any thread you started here.
   */
  private async sync(chat: number): Promise<void> {
    const top = this.d.engine.threads.filter((t) => !t.parentId && !t.helperFile && t.messages.length > 0);
    const running = top.filter((t) => t.status !== 'idle').sort((a, b) => (b.runStartedAt ?? 0) - (a.runStartedAt ?? 0))[0];
    const t = running ?? [...top].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!t) return void (await this.reply(chat, 'Nothing to sync: no conversations in VS Code yet.'));
    this.track(t.id);
    this.setCurrent(t.id);
    const at = t.messages.map((m) => m.role).lastIndexOf('user');
    const prompt = at >= 0 ? t.messages[at] : undefined;
    const header = `<b>👤 You</b><i> · ${esc(t.title)}</i>`;
    if (prompt) await this.replyMarkdown(chat, prompt.text, header, `👤 You · ${t.title}:\n\n${prompt.text}`, undefined, true);
    if (t.status !== 'idle') {
      this.progress.start(chat, t.id, t.work?.startedAt, this.d.engine.liveActivity(t.id));
      return;
    }
    // Already done: its answer to that prompt.
    const answer = t.messages.slice(at + 1).reverse().find((m) => m.role === 'agent');
    if (!answer) return void (await this.reply(chat, `Synced with "${t.title}". Nothing is running in it now.`));
    const who = `🤖 ${this.d.agentName(answer.accountId)}`;
    const time = answer.workedMs ? ` in ${elapsed(answer.workedMs)}` : '';
    await this.replyMarkdown(chat, answer.text, `<b>${esc(who)}</b>${time}`, `${who}${time}:\n\n${answer.text}`);
  }

  // ------------------------------------------------------------ helpers

  private isTracked(t: Thread): boolean {
    const tracked = this.tracked;
    return tracked.includes(t.id) || (!!t.parentId && tracked.includes(t.parentId));
  }

  private recent(): Thread[] {
    return [...this.d.engine.threads].filter((t) => !t.helperFile).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
  }

  private threadList(): string {
    const list = this.recent();
    if (!list.length) return 'No threads yet. Just send a message to start one.';
    const mark = (t: Thread) => (t.status === 'working' ? ' (working)' : t.status === 'waiting' ? ' (waiting)' : '');
    return `${list.map((t, i) => `${i + 1}. ${t.id === this.current ? '▶ ' : ''}${t.title}${mark(t)}`).join('\n')}\n\nSwitch with /use N, or /new.`;
  }

  private async download(m: TgMessage): Promise<string[]> {
    const items: { id: string; name: string }[] = [];
    if (m.photo?.length) items.push({ id: m.photo[m.photo.length - 1].file_id, name: `telegram-${Date.now()}.jpg` });
    if (m.document) items.push({ id: m.document.file_id, name: m.document.file_name ?? `telegram-${Date.now()}` });
    if (!items.length) return [];
    const dir = this.d.attachmentDir();
    if (!dir) return [];
    const out: string[] = [];
    for (const it of items) {
      const f = await this.api<{ file_path: string }>('getFile', { file_id: it.id });
      const res = await this.http(`${API}/file/bot${this.token}/${f.file_path}`);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const dest = uniqueIn(dir, it.name);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      out.push(dest);
    }
    return out;
  }

  /**
   * Sends an agent's Markdown reply with real formatting (bold, links, highlighted code blocks).
   * If Telegram rejects the formatting, the rest goes as plain text, so the reply always arrives.
   */
  private async replyMarkdown(chat: number, md: string, header: string, plain: string, markup?: unknown, silent = false): Promise<void> {
    const parts = markdownToTelegram(md, header);
    for (const [i, part] of parts.entries()) {
      try {
        await this.api('sendMessage', {
          chat_id: chat,
          text: part,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(silent ? { disable_notification: true } : {}),
          ...(markup && i === parts.length - 1 ? { reply_markup: markup } : {}),
        });
      } catch (e) {
        this.d.log(`Telegram formatting rejected (${(e as Error).message}); sending as plain text.`);
        const rest = parts.slice(i).map((p) => p.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        return this.reply(chat, i === 0 ? plain : rest.join('\n'), markup, silent);
      }
    }
  }

  /** Sends text (split to fit); optional buttons go under the last part. */
  private async reply(chat: number, text: string, markup?: unknown, silent = false): Promise<void> {
    const parts = chunks(text);
    for (const [i, part] of parts.entries())
      await this.api('sendMessage', {
        chat_id: chat,
        text: part,
        link_preview_options: { is_disabled: true },
        ...(silent ? { disable_notification: true } : {}),
        ...(markup && i === parts.length - 1 ? { reply_markup: markup } : {}),
      });
  }

  private async sendPhoto(file: string): Promise<void> {
    if (this.chatId !== undefined) await this.upload('sendPhoto', this.chatId, file);
  }

  private async upload(method: 'sendDocument' | 'sendPhoto', chat: number, file: string): Promise<void> {
    const form = new FormData();
    form.append('chat_id', String(chat));
    form.append(method === 'sendPhoto' ? 'photo' : 'document', new Blob([fs.readFileSync(file)]), path.basename(file));
    const res = await this.http(`${API}/bot${this.token}/${method}`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`${method} failed (${res.status})`);
  }

  private async api<T = unknown>(method: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
    const res = await this.http(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string; error_code?: number };
    if (!json.ok) throw Object.assign(new Error(json.description ?? `Telegram error ${res.status}`), { code: json.error_code ?? res.status });
    return json.result;
  }

  private http(url: string, init?: RequestInit): Promise<Response> {
    return (this.d.fetch ?? fetch)(url, init);
  }

  private setState(s: RelayState): void {
    this.state = s;
    this.d.onChange();
  }

  /** One poller per bot across VS Code windows (Telegram allows only one getUpdates at a time). */
  private takeLock(): boolean {
    try {
      const held = JSON.parse(fs.readFileSync(this.d.lockFile, 'utf8')) as { pid: number; at: number };
      if (held.pid !== process.pid && Date.now() - held.at < 90000 && alive(held.pid)) return false;
    } catch {
      /* no lock yet */
    }
    try {
      fs.mkdirSync(path.dirname(this.d.lockFile), { recursive: true });
      fs.writeFileSync(this.d.lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
      return true;
    } catch {
      return false;
    }
  }

  private releaseLock(): void {
    try {
      const held = JSON.parse(fs.readFileSync(this.d.lockFile, 'utf8')) as { pid: number };
      if (held.pid === process.pid) fs.rmSync(this.d.lockFile);
    } catch {
      /* not ours or already gone */
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

/** Splits long text at line breaks so each piece fits in one Telegram message. */
export function chunks(text: string): string[] {
  const out: string[] = [];
  let rest = text || '(empty)';
  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf('\n', CHUNK);
    if (cut < CHUNK / 2) cut = CHUNK;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  out.push(rest);
  return out;
}

/** Image files an agent mentions in its reply (e.g. screenshots it took), resolved against the workspace. */
function imagesIn(text: string, cwd: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:[A-Za-z]:)?[\w./\\ ~-]*?[\w~-]+\.(?:png|jpe?g|gif|webp)/gi)) {
    const raw = m[0].trim().replace(/^file:\/+/, '');
    const p = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) found.add(path.normalize(p));
  }
  return [...found];
}

export function uniqueIn(dir: string, name: string): string {
  const safe = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
  const ext = path.extname(safe);
  let file = path.join(dir, safe);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${path.basename(safe, ext)}-${n}${ext}`);
  return file;
}
