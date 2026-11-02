import fs from 'node:fs';
import path from 'node:path';
import type { Account, AgentKind, Autonomy } from '../core/types';
import type { AccountPool } from '../core/agents/pool';
import type { RunRequest, RunResult } from '../core/agents/runner';
import type { ConfigStore } from '../core/store/config';
import { TEAM_FILE, contextBrief, helperPrompt, leadPreamble, transferSession } from './context';
import type { RunChanges, Thread, ThreadMsg } from './types';
import { log } from '../core/log';
import { ActivityParser } from './activity';
import { CLI_META } from '../core/agents/cli';
import { OUTDATED, type UpdateResult } from '../core/agents/updater';
import type { ChangeTracker } from './changes';

/** A turn's activity kept for the panel (items / characters per item). */
const MAX_ACTIVITY = 300;
const MAX_ITEM_CHARS = 8000;

export interface EngineDeps {
  config: ConfigStore;
  pool: AccountPool;
  dataDir: string;
  cliPath(kind: AgentKind): string | null;
  runAgent(req: RunRequest): Promise<RunResult>;
  cancelRun(runId: string): void;
  /** Adds a user message to a running turn; false if this CLI/run can't take one mid-turn. */
  /** `label` says where it comes from, for the activity view ("message from you", "report from …"). */
  steer?(runId: string, text: string, label?: string): Promise<boolean>;
  usageLoad(id: string): number;
  usageResetAt(id: string): number | undefined;
  autonomy(): Autonomy;
  onChange(): void;
  onOutput(threadId: string, text: string): void;
  onFinished(t: Thread, outcome: 'done' | 'failed'): void;
  /** Tracks what each turn changes in the workspace (optional: no tracking without it). */
  changes?: Pick<ChangeTracker, 'snapshot' | 'diff'>;
  /** Updates an agent CLI that the provider says is too old (optional: without it the run just fails). */
  updateCli?(kind: AgentKind): Promise<UpdateResult>;
  /** Checks an account's usage again now (optional: used before resuming work that waited for usage to return). */
  refreshUsage?(id: string): Promise<void>;
}

const HANDOFF_DIR = '.super-agent/handoff';
const COOLDOWN_MIN = 20;
/** Everyone out of usage: how often to check again when no reset time is known, and the longest single wait. */
const RECHECK_MS = 20 * 60000;
const MAX_WAIT_MS = 60 * 60000;
/** Resume a little after the reset time, so the provider has really reset the limit. */
const RESET_SLACK_MS = 30000;
/** A time of day for the thread ("3:40 PM", with the day when it isn't today). */
const when = (at: number) => {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
};
/** Usage (% of the fullest window) from which an agent is only picked when nobody else is free. */
const NEAR_LIMIT = 80;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const titleOf = (text: string) => text.trim().split(/\r?\n/)[0].slice(0, 60) || 'New thread';
/** What the thread shows whenever work moves to another agent because one ran out of usage. */
const handOverNote = (from: Account, to: Account, lead: boolean) =>
  lead ? `${from.label} is out of usage: ${to.label} takes over as the lead, with the full context.`
  : `${from.label} is out of usage: handing the task over to ${to.label}, with the full context.`;

/**
 * Super Agent's "lead works, helpers assist" engine:
 * - the agent leading a thread does the work itself and resumes its own session turn after turn;
 * - when it runs out of usage, a free agent takes over with the exact session (same CLI) or a brief;
 * - a message that arrives while the lead is busy goes to a free agent as a new thread it leads;
 * - leads spin off independent pieces by writing hand-off files; free agents pick them up in parallel.
 */
export class Engine {
  threads: Thread[] = [];
  private watchers = new Map<string, fs.FSWatcher>();
  private handled = new Set<string>();
  /** When each account last started or finished work: the one free the longest gets the next task. */
  private lastWork = new Map<string, number>();
  private scans = new Map<string, NodeJS.Timeout>();
  /** What the current run of each thread is doing, parsed from its output. */
  private live = new Map<string, ActivityParser>();
  /** Workspace snapshot taken when each top-level thread's current turn started. */
  private snaps = new Map<string, Promise<string | undefined>>();
  private saveTimer: NodeJS.Timeout | null = null;
  /** Wakes waiting work when an agent gets usage back (everyone was out). */
  private wakeTimer: NodeJS.Timeout | null = null;
  private file: string;

  constructor(private d: EngineDeps) {
    this.file = path.join(d.dataDir, 'vscode-threads.json');
    this.threads = this.load();
    // When the work in progress was last saved (it is saved every few seconds while agents run).
    let savedAt = Date.now();
    try {
      savedAt = fs.statSync(this.file).mtimeMs;
    } catch {
      /* nothing saved yet */
    }
    for (const t of this.threads) {
      // Last used = the last message from you or an agent (older saves also counted status notes).
      const last = t.messages.filter((m) => m.role !== 'system').at(-1)?.at;
      if (last) t.updatedAt = last;
      if (t.status === 'working' || (t.status === 'waiting' && t.awaitingHelpers)) {
        t.status = 'idle';
        t.awaitingHelpers = undefined;
        // The interrupted turn keeps what it did so far ("Worked for …", with its steps and changed files); "continue"
        // picks up from there. Straight onto the thread: listeners can't be called while the extension starts up.
        const w = t.work;
        t.work = undefined;
        const note: ThreadMsg = {
          at: Date.now(),
          role: 'system',
          text: 'Interrupted (VS Code was closed). Send "continue" to pick up from where it stopped.',
          ...(w ? { activity: w.items.length ? w.items : undefined, workedMs: Math.max(0, savedAt - w.startedAt) } : {}),
        };
        t.messages.push(note);
        if (w?.before && !t.parentId && d.changes) {
          const tracker = d.changes;
          void tracker
            .diff(t.cwd, w.before)
            .then((changes) => {
              if (!changes) return;
              note.changes = changes;
              this.queueSave();
              this.d.onChange();
            })
            .catch(() => undefined);
        }
      }
    }
    // Work waiting for usage to come back keeps waiting across reloads: check again shortly.
    if (this.threads.some((t) => t.status === 'waiting' && t.pending)) this.armWake(RESET_SLACK_MS);
  }

  /**
   * Every conversation, from disk. An unreadable file is never overwritten: it is set aside (`.corrupt-<time>`) and
   * the backup from the previous session is used instead.
   */
  private load(): Thread[] {
    const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Thread[];
    if (!fs.existsSync(this.file)) return fs.existsSync(`${this.file}.bak`) ? read(`${this.file}.bak`) : [];
    try {
      const threads = read(this.file);
      fs.copyFileSync(this.file, `${this.file}.bak`); // this session's starting point, in case a later write goes wrong
      return threads;
    } catch (err) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      log('engine', `threads file unreadable (${(err as Error).message}); kept as ${aside}, loading the backup`);
      try {
        fs.renameSync(this.file, aside);
        return read(`${this.file}.bak`);
      } catch {
        return [];
      }
    }
  }

  /** Writes every conversation (write-then-rename, so a crash mid-write never leaves a broken file). */
  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      // A turn in progress is saved with its live steps too, so a reload mid-work still shows (and resumes) them.
      const threads = this.threads.map((t) => {
        const live = this.live.get(t.id);
        return live && t.work ? { ...t, work: { ...t.work, items: [...t.work.items, ...live.items].slice(-MAX_ACTIVITY) } } : t;
      });
      fs.writeFileSync(tmp, JSON.stringify(threads, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log('engine', `couldn't save threads: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- public API

  /**
   * A message from the user. While the thread is busy, `now` gets it to the working agent right away (added to its
   * turn when the CLI supports that, otherwise the agent stops and resumes with it); `queue` runs it as the next turn.
   */
  send(threadId: string | undefined, text: string, cwd: string, attachments: string[] = [], mode: 'now' | 'queue' = 'now'): Thread {
    const typed = text.trim();
    // Agents read attached files (images included) themselves, so they just get the paths.
    const msg = attachments.length ? `${typed || 'See the attached files.'}\n\nAttached files (read them):\n${attachments.map((a) => `- ${a}`).join('\n')}` : typed;
    const shown = { role: 'user' as const, text: typed, attachments: attachments.length ? attachments : undefined };
    let t = threadId ? this.get(threadId) : undefined;
    log('engine', `user message (${mode})`, { thread: t?.id ?? 'new', status: t?.status, text: typed.slice(0, 120) });
    if (!t) {
      t = this.create(titleOf(typed || path.basename(attachments[0] ?? '')), cwd);
      this.push(t, shown);
      this.schedule(t, msg);
      return t;
    }
    this.push(t, shown);
    if (t.status === 'idle' && !t.queue.length) t.work = undefined; // a new turn starts
    if (t.status === 'waiting' && t.pending) {
      // Still waiting for a free agent: the new message joins the request that will run.
      t.pending += `\n\n## The user added\n${msg}`;
      return t;
    }
    if (t.status !== 'working') {
      if (mode === 'queue' && t.awaitingHelpers) {
        t.queue.push(msg); // after the helpers' work is folded in
        this.sys(t, 'Queued: runs once the current work is done.');
        return t;
      }
      this.schedule(t, msg);
      return t;
    }
    if (mode === 'queue') {
      t.queue.push(msg);
      this.sys(t, `Queued: ${this.label(t.leadId)} takes this next.`);
      return t;
    }
    // Send now: into the running turn if the CLI can take it, else the agent stops and resumes with it at once.
    const runId = t.runId!;
    void (this.d.steer?.(runId, msg, 'message from you') ?? Promise.resolve(false)).then((steered) => {
      if (steered) return this.sys(t!, `Sent to ${this.label(t!.leadId)} while it works.`);
      if (t!.runId !== runId) return void t!.queue.unshift(msg); // the turn just ended: next in line
      t!.queue.unshift(`You were interrupted by a new message from the user. Take it into account, then continue the task:\n\n${msg}`);
      t!.restarting = true;
      this.d.cancelRun(runId);
    });
    return t;
  }

  newThread(cwd: string): Thread {
    return this.create('New thread', cwd);
  }

  stop(threadId: string): void {
    const t = this.get(threadId);
    if (t?.runId) this.d.cancelRun(t.runId);
    if (t && t.status === 'waiting') {
      t.status = 'idle';
      t.pending = undefined;
      t.resumeAt = undefined;
      t.awaitingHelpers = undefined;
      this.sys(t, 'Stopped.');
    }
  }

  /** Feature 1: switch who leads a thread; the next turn continues with full context. */
  setLead(threadId: string, accountId: string | null): void {
    const t = this.get(threadId);
    if (!t) return;
    t.pinnedLeadId = accountId ?? undefined;
    this.sys(t, accountId ? `${this.label(accountId)} will lead this thread from the next message, with the full context.` : 'Lead: automatic.');
  }

  /** Deletes a conversation together with its helpers' threads (they are part of it). */
  deleteThread(threadId: string): void {
    const gone = new Set([threadId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of this.threads) if (t.parentId && gone.has(t.parentId) && !gone.has(t.id)) (gone.add(t.id), (grew = true));
    }
    for (const id of gone) this.stop(id);
    this.threads = this.threads.filter((t) => !gone.has(t.id));
    this.changed();
  }

  get working(): number {
    return this.threads.filter((t) => t.status === 'working').length;
  }

  // ---------------------------------------------------------------- scheduling

  private isOut(a: Account): boolean {
    const s = this.d.pool.get(a.id);
    return (s.cooldownUntil ?? 0) > Date.now() || s.login === 'signed-out' || this.d.usageLoad(a.id) >= 100 || !this.d.cliPath(a.kind);
  }

  /**
   * Free team members in the order work should go to them: whoever has waited longest for work first, so every
   * account (and every CLI) gets used; agents close to a limit go last. Plain "least used first" starved an account
   * that happened to sit at a higher weekly percentage.
   */
  private free(): Account[] {
    const nearLimit = (a: Account) => (this.d.usageLoad(a.id) >= NEAR_LIMIT ? 1 : 0);
    return this.d.config.accounts
      .filter((a) => a.role !== 'off' && !this.isOut(a) && this.d.pool.available(a.id, 1))
      .sort((a, b) => nearLimit(a) - nearLimit(b) || (this.lastWork.get(a.id) ?? 0) - (this.lastWork.get(b.id) ?? 0));
  }

  /** Who should run this thread now: the pinned agent, else the crowned lead, else the same agent as before, else same CLI, else anyone free. */
  private pick(t: Thread): Account | undefined {
    const free = this.free();
    const byId = (id?: string) => free.find((a) => a.id === id);
    const pinned = this.account(t.pinnedLeadId);
    // A pinned agent that is merely busy is waited for; only when it is out of usage does someone else step in.
    if (pinned && !this.isOut(pinned)) return byId(pinned.id);
    // Moving the crown mid-thread hands the next message to the new lead, with the full context.
    return byId(this.preferredLead()?.id) ?? byId(t.leadId) ?? free.find((a) => a.kind === t.session?.kind) ?? free[0] ?? this.standIn(t);
  }

  /**
   * When nobody on the team has usage left (not merely busy), work doesn't stop: an added account that is off the
   * team steps in, the one with the most usage left (the one already standing in for this thread stays on it).
   */
  private standIn(t: Thread): Account | undefined {
    const team = this.d.config.accounts.filter((a) => a.role !== 'off');
    if (team.some((a) => !this.isOut(a))) return undefined;
    const others = this.d.config.accounts.filter((a) => a.role === 'off' && !this.isOut(a) && this.d.pool.available(a.id, 1));
    return others.find((a) => a.id === t.leadId) ?? others.sort((a, b) => this.d.usageLoad(a.id) - this.d.usageLoad(b.id))[0];
  }

  /**
   * The lead you chose is out of usage: the agent taking over becomes the lead. Crowned: the crown moves to it (it
   * joins the team; the old lead stays on it). Pinned on this thread: the thread is pinned to it instead.
   */
  private passLead(t: Thread, from: Account, to: Account): void {
    if (t.pinnedLeadId === from.id) t.pinnedLeadId = to.id;
    if (from.role === 'master') {
      for (const a of this.d.config.accounts) if (a.role === 'master') a.role = 'worker';
      to.role = 'master';
      this.d.config.saveAccounts?.();
    }
    log('engine', `lead passed: ${from.label} → ${to.label} (out of usage)`, { thread: t.id });
  }

  /**
   * When an agent can work again: now if it has usage, the end of its cool-down / its limit's reset time, undefined
   * when out of usage with no known reset time, null when it can't work at all (signed out, CLI missing).
   */
  private backAt(a: Account): number | undefined | null {
    const s = this.d.pool.get(a.id);
    if (s.login === 'signed-out' || !this.d.cliPath(a.kind)) return null;
    const cool = s.cooldownUntil ?? 0;
    if (this.d.usageLoad(a.id) < 100) return Math.max(Date.now(), cool);
    const reset = this.d.usageResetAt(a.id);
    return reset ? Math.max(reset, cool) : undefined;
  }

  /**
   * Nobody can take the work: if everyone is out of usage (not merely busy), the agent that gets usage back first
   * (the lead you chose when it's as soon) and when. `at` undefined: no reset time known, so check again regularly.
   */
  private nextBack(t: Thread): { acc?: Account; at?: number } | 'busy' | 'none' {
    const accounts = this.d.config.accounts;
    if (accounts.some((a) => !this.isOut(a))) return 'busy';
    const chosen = this.account(t.pinnedLeadId) ?? this.preferredLead();
    const rank = (a: Account) => (a.id === chosen?.id ? 0 : a.role !== 'off' ? 1 : 2);
    const known = accounts
      .map((a) => ({ acc: a, at: this.backAt(a) }))
      .filter((x): x is { acc: Account; at: number } => typeof x.at === 'number')
      .sort((x, y) => x.at - y.at || rank(x.acc) - rank(y.acc));
    if (known.length) return known[0];
    return accounts.some((a) => this.backAt(a) === undefined) ? {} : 'none';
  }

  /** Waiting work runs as soon as an agent has usage again: wake up then (or check again later). */
  private armWake(delayMs: number): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => void this.onWake(), Math.min(Math.max(delayMs, 1000), MAX_WAIT_MS));
  }

  private async onWake(): Promise<void> {
    this.wakeTimer = null;
    if (!this.threads.some((t) => t.status === 'waiting' && t.pending)) return;
    // Usage numbers may be stale (or the reset time unknown): ask again for the accounts that were out.
    const out = this.d.config.accounts.filter((a) => this.isOut(a) && this.backAt(a) !== null);
    await Promise.all(out.map((a) => this.d.refreshUsage?.(a.id).catch(() => undefined)));
    this.pump();
    this.rearm();
  }

  /** Arms the wake-up for the soonest return among the threads still waiting with everyone out. */
  private rearm(): void {
    let soonest: number | undefined;
    for (const t of this.threads.filter((x) => x.status === 'waiting' && x.pending)) {
      const n = this.nextBack(t);
      if (n === 'busy' || n === 'none') continue;
      const at = n.at ? n.at + RESET_SLACK_MS : Date.now() + RECHECK_MS;
      soonest = Math.min(soonest ?? at, at);
    }
    if (soonest !== undefined) this.armWake(soonest - Date.now());
  }

  /** Usage numbers changed (a refresh): work waiting for usage may be able to run now. */
  usageChanged(): void {
    if (!this.threads.some((t) => t.status === 'waiting' && t.pending)) return;
    this.pump();
    this.rearm();
  }

  private preferredLead(): Account | undefined {
    return this.d.config.accounts.find((a) => a.role === 'master');
  }

  private schedule(t: Thread, prompt: string, preferred?: Account): void {
    const acc = preferred ?? this.pick(t);
    log('engine', acc ? `schedule "${t.title}" → ${acc.label}` : `schedule "${t.title}": no free agent, waiting`, { thread: t.id, free: this.free().map((a) => a.label) });
    if (!acc) {
      t.status = 'waiting';
      t.pending = prompt;
      const n = this.nextBack(t);
      t.resumeAt = typeof n === 'object' ? n.at ?? Date.now() + RECHECK_MS : undefined;
      const note =
        n === 'busy' ? 'Waiting for a free agent with usage left…'
        : n === 'none' ? 'No agent can take this (all signed out or missing their CLI). Sign one in, then send "continue".'
        : n.at && n.acc ? `Every agent is out of usage. ${n.acc.label} gets usage back at ${when(n.at)}: the task resumes on it automatically then.`
        : `Every agent is out of usage and no reset time is known: checking again every ${RECHECK_MS / 60000} minutes, the task resumes automatically as soon as one has usage.`;
      if (!t.helperFile && t.messages.at(-1)?.text !== note) this.sys(t, note);
      this.rearm();
      return;
    }
    void this.start(t, acc, prompt);
  }

  /** Run waiting threads and queued messages as agents free up. */
  private pump(): void {
    // Oldest first: queued hand-offs go out in the order the lead wrote them, to whoever is free (the lead included).
    // (threads are stored newest first; reversed, a stable sort keeps same-millisecond hand-offs in written order)
    for (const t of [...this.threads].reverse().sort((a, b) => a.createdAt - b.createdAt)) {
      if (t.status === 'waiting' && t.pending) {
        const acc = this.pick(t);
        if (acc) {
          const p = t.pending;
          t.pending = undefined;
          if (t.resumeAt) {
            t.resumeAt = undefined;
            if (!t.helperFile) this.sys(t, `${acc.label} has usage again: resuming the task where it stopped.`);
          }
          void this.start(t, acc, p);
        }
      } else if (t.status === 'idle' && t.queue.length) {
        this.schedule(t, t.queue.shift()!);
      }
    }
  }

  // ---------------------------------------------------------------- running

  /**
   * An agent that already replied started working again by itself (one of its background tasks woke it up, e.g.
   * Claude Code's Monitor): its conversation gets a new turn that shows that work live and ends with its next reply.
   * False when no idle conversation of ours owns that session.
   */
  wake(accountId: string, sessionId: string): boolean {
    const t = this.threads.find((x) => x.session?.id === sessionId && x.session.accountId === accountId);
    const acc = this.account(accountId);
    if (!t || !acc || t.status !== 'idle') return false;
    log('engine', `woke up: "${t.title}" on ${acc.label} (its background work)`, { thread: t.id });
    void this.start(t, acc, '', true);
    return true;
  }

  /** `attach`: take over the turn the agent started by itself (see `wake`): no prompt is sent. */
  private async start(t: Thread, acc: Account, prompt: string, attach = false): Promise<void> {
    const cli = this.d.cliPath(acc.kind);
    if (!cli) return;
    // Work moving away from an agent that is out of usage is always announced (here, in one place). When it is the
    // lead you chose (crowned, or pinned on this thread), the agent taking over becomes the lead.
    if (!attach) {
      const was = this.account(t.leadId);
      const chosen = this.account(t.pinnedLeadId) ?? this.preferredLead();
      if (chosen && chosen.id !== acc.id && this.isOut(chosen)) {
        this.passLead(t, chosen, acc);
        this.sys(t, handOverNote(chosen, acc, true));
      } else if (was && was.id !== acc.id && this.isOut(was)) {
        const note = handOverNote(was, acc, false);
        const lastAnswer = t.messages.map((m) => m.accountId).lastIndexOf(was.id);
        if (!t.messages.slice(lastAnswer + 1).some((m) => m.text === note)) this.sys(t, note);
      }
    }
    let resume: string | undefined;
    let input = prompt;
    const prev = t.session;
    if (attach) {
      resume = prev?.id;
    } else if (prev && prev.accountId === acc.id) {
      resume = prev.id;
    } else if (prev && prev.kind === acc.kind && acc.kind !== 'antigravity' && this.account(prev.accountId) && transferSession(prev, this.account(prev.accountId)!, acc)) {
      resume = prev.id; // exact context carried to another account of the same CLI
    } else if (prev || t.messages.length > 1) {
      input = `${contextBrief(t, (id) => this.label(id), prev ? `continuing from ${this.label(prev.accountId)}` : 'continuing this thread')}\n\n## Now\n${prompt}`;
    }
    // Every thread, helpers included, can hand off work; its own folder tells us exactly who asked.
    // An agent without teammates gets no team instructions: hand-offs would only come back to itself, one by one.
    const hasTeam = this.d.config.accounts.some((a) => a.id !== acc.id && a.role !== 'off');
    if (!resume && hasTeam && !attach) input = leadPreamble(`${HANDOFF_DIR}/${t.id}`) + input;
    if (!attach) input = this.teamNote(t, acc) + input; // every turn: who is free changes all the time
    this.watchHandoffs(t.cwd);

    const runId = newId();
    t.status = 'working';
    t.leadId = acc.id;
    t.runId = runId;
    t.runStartedAt = Date.now();
    t.lastLog = path.join(this.d.dataDir, 'vscode-logs', `${runId}.log`);
    this.changed();

    if (!t.work) {
      t.work = { startedAt: Date.now(), items: [] };
      // A new turn of a top-level thread: remember the files as they are now (helpers work inside this turn).
      if (!t.parentId && this.d.changes) {
        const snap = this.d.changes.snapshot(t.cwd);
        this.snaps.set(t.id, snap);
        const work = t.work;
        void snap.then((before) => before && (work.before = before)); // kept with the turn, for after a reload
      }
    }
    const parser = new ActivityParser(MAX_ITEM_CHARS, MAX_ACTIVITY, true);
    this.live.set(t.id, parser);
    this.d.pool.acquire(acc.id);
    log('engine', `run start: "${t.title}" on ${acc.label}`, { thread: t.id, run: runId, resume: resume ?? null, helper: !!t.helperFile, promptChars: input.length });
    this.lastWork.set(acc.id, Date.now());
    let res: RunResult;
    try {
      await this.snaps.get(t.id); // the agent may only touch files once the "before" picture is taken
      res = await this.d.runAgent({
        runId,
        account: acc,
        cliPath: cli,
        mode: 'write',
        autonomy: this.d.autonomy(),
        cwd: t.cwd,
        prompt: input,
        logFile: t.lastLog,
        timeoutMs: this.d.config.settings.taskTimeoutMin * 60000,
        onText: (text) => {
          parser.feed(text);
          this.d.onOutput(t.id, text);
          this.queueSave();
        },
        resume,
        browser: this.d.config.settings.browserTools !== false,
        attach,
      });
    } finally {
      this.d.pool.release(acc.id);
      this.lastWork.set(acc.id, Date.now()); // free since now: whoever has waited longest gets the next task
    }
    t.runId = undefined;
    parser.flush();
    this.live.delete(t.id);
    if (t.work) t.work.items = [...t.work.items, ...parser.items].slice(-MAX_ACTIVITY);
    log('engine', `run end: "${t.title}" on ${acc.label}`, { run: runId, code: res.code, cancelled: res.cancelled, restarting: !!t.restarting, rateLimited: res.rateLimited, authFailed: res.authFailed, timedOut: res.timedOut, finalChars: res.finalText.length });

    const restarting = t.restarting;
    t.restarting = undefined; // whatever happened, this run is over
    if (attach && res.cancelled && !restarting && !(t.work?.items.length)) {
      // The agent's own work was already over (or its process gone): nothing to show.
      t.status = 'idle';
      t.work = undefined;
      this.snaps.delete(t.id);
      this.changed();
      return this.pump();
    }
    if (res.cancelled) {
      t.status = 'idle';
      if (res.sessionId) t.session = { accountId: acc.id, kind: acc.kind, id: res.sessionId };
      if (restarting) {
        // resumes right away with the message that interrupted it (pump below)
      } else {
        t.queue = [];
        this.push(t, { role: 'system', text: 'Stopped.', ...this.takeWork(t) });
      }
    } else if (res.rateLimited || res.authFailed) {
      // Feature 2: out of usage mid-task → a free agent continues with this agent's context.
      if (res.rateLimited) {
        const reset = this.d.usageResetAt(acc.id);
        this.d.pool.coolDown(acc.id, reset && reset > Date.now() ? Math.ceil((reset - Date.now()) / 60000) : COOLDOWN_MIN, 'Out of usage');
      } else {
        this.d.pool.patch(acc.id, { login: 'signed-out', lastError: res.authReason ?? 'Not signed in' });
      }
      if (res.sessionId) t.session = { accountId: acc.id, kind: acc.kind, id: res.sessionId };
      const next = this.pick(t);
      // (A hand-over for usage is announced when the next agent starts; see start.)
      if (!res.rateLimited || !next) {
        // (Nobody left: schedule says how long it waits.)
        this.sys(t, `${acc.label} ${res.rateLimited ? 'is out of usage' : 'is unavailable'}${next ? `: handing the task over to ${next.label}, with the full context.` : '.'}`);
      }
      t.status = 'idle';
      this.schedule(t, `You are taking over mid-task because the previous agent stopped (${res.rateLimited ? 'usage limit' : 'unavailable'}). Continue exactly where it left off and finish this request:\n\n${prompt}`, next);
    } else if (!res.finalText && res.error && OUTDATED.test(res.error) && this.d.updateCli && !t.cliUpdated) {
      // The CLI itself is too old (the provider says so): show why, update it, and run the turn again on it.
      t.cliUpdated = true;
      const name = CLI_META[acc.kind].name;
      this.sys(t, `${acc.label} failed: ${res.error}`);
      this.sys(t, `Updating ${name}…`);
      void this.d.updateCli(acc.kind).then((r) => {
        t.status = 'idle';
        if (r.ok) {
          this.sys(t, `${name} updated${r.from && r.to && r.from !== r.to ? ` (${r.from} → ${r.to})` : ''}. Trying again.`);
          this.schedule(t, prompt, acc);
        } else {
          const other = this.free().find((a) => a.kind !== acc.kind);
          this.sys(t, `Couldn't update ${name}${r.error ? `: ${r.error}` : ''}. Run \`${CLI_META[acc.kind].bin} update\` in a terminal.${other ? ` ${other.label} takes over meanwhile.` : ''}`);
          if (other) this.schedule(t, `The previous agent stopped without finishing. Do this request from the start, checking what is already done:\n\n${prompt}`, other);
          else this.d.onFinished(t, 'failed');
        }
        this.changed();
        this.pump();
      });
    } else if (!res.finalText) {
      t.status = 'idle';
      const why = res.timedOut ? 'timed out' : res.error ?? `exit code ${res.code}`;
      // One automatic retry on a different agent, so a flaky run doesn't leave the work (or a waiting lead) stuck.
      const next = t.retried ? undefined : this.free().find((a) => a.id !== acc.id);
      if (next) {
        t.retried = true;
        this.sys(t, `${acc.label} stopped without an answer (${why}), so ${next.label} takes over with the full context.`);
        this.schedule(t, `The previous agent stopped without finishing. Do this request from the start, checking what is already done:\n\n${prompt}`, next);
      } else {
        this.push(t, { role: 'system', text: `${acc.label} stopped without an answer (${why}). Send a message to continue.`, ...this.takeWork(t) });
        this.d.onFinished(t, 'failed');
      }
    } else {
      if (res.sessionId) t.session = { accountId: acc.id, kind: acc.kind, id: res.sessionId };
      t.status = 'idle';
      t.retried = undefined;
      t.cliUpdated = undefined;
      const busy = this.activeHelpers(t);
      log('engine', `turn done: "${t.title}" by ${acc.label}`, { thread: t.id, ms: Date.now() - (t.runStartedAt ?? 0), helpersActive: busy.length, reportsPending: t.reports?.length ?? 0 });
      if ((t.reports?.length || busy.length) && t.work && !t.work.items.some((i) => i.includes(res.finalText.trim().slice(0, 80)))) {
        t.work.items.push(`💬 ${res.finalText.trim()}`);
      }
      if (t.reports?.length) {
        // Helpers finished while this turn ran: their reports come first.
        this.deliverReports(t);
      } else if (busy.length) {
        // No final answer while helpers still work: hold it; each helper's report wakes this thread as it lands.
        t.status = 'waiting';
        t.awaitingHelpers = true;
      } else {
        this.push(t, { role: 'agent', text: res.finalText, accountId: acc.id, ...this.takeWork(t, res.finalText) });
        if (t.helperFile) this.reportHelper(t, acc, res.finalText);
        this.d.onFinished(t, 'done');
      }
    }
    this.changed();
    this.pump();
  }

  // ---------------------------------------------------------------- helpers (feature 3)

  private watchHandoffs(cwd: string): void {
    const dir = path.join(cwd, HANDOFF_DIR);
    if (this.watchers.has(dir)) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      ensureIgnored(cwd);
      // Only new requests count. Recursive: each thread writes into its own sub-folder.
      for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) this.handled.add(path.join(dir, f));
      // Debounced rescan (lets writers finish their files); new requests are taken in the order they were written,
      // so a queued batch goes out oldest first whatever order the watcher reports them in.
      const w = fs.watch(dir, { recursive: true }, () => {
        clearTimeout(this.scans.get(dir));
        this.scans.set(dir, setTimeout(() => this.scanHandoffs(cwd, dir), 400));
      });
      this.watchers.set(dir, w);
    } catch {
      /* folder not writable */
    }
  }

  private scanHandoffs(cwd: string, dir: string): void {
    let files: { file: string; at: number }[] = [];
    try {
      files = (fs.readdirSync(dir, { recursive: true }) as string[])
        .map((f) => path.join(dir, f))
        .filter((f) => f.endsWith('.md') && !f.endsWith('.result.md') && !this.handled.has(f))
        .map((file) => ({ file, at: fs.statSync(file).mtimeMs }));
    } catch {
      return;
    }
    for (const { file } of files.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file, undefined, { numeric: true }))) this.onHandoff(cwd, file);
  }

  private onHandoff(cwd: string, file: string): void {
    if (this.handled.has(file) || !fs.existsSync(file)) return;
    this.handled.add(file);
    const request = fs.readFileSync(file, 'utf8').trim();
    if (!request) return;
    // The sub-folder names the thread that asked; a file dropped straight into handoff/ goes to the latest lead.
    const lead =
      this.get(path.basename(path.dirname(file))) ??
      this.threads.filter((x) => x.cwd === cwd && x.status === 'working' && !x.helperFile).sort((a, b) => (b.runStartedAt ?? 0) - (a.runStartedAt ?? 0))[0];
    const title = request.split(/\r?\n/)[0].replace(/^#+\s*/, '').slice(0, 60) || path.basename(file, '.md');
    const owns = /files?[^\n]*:\s*([^\n]+)/i.exec(request)?.[1] ?? '';
    const h = this.create(title, cwd, lead?.id);
    h.helperFile = file;
    log('engine', `hand-off: "${title}" from "${lead?.title ?? '?'}"`, { file, helper: h.id, parent: lead?.id });
    this.push(h, { role: 'user', text: request });
    const leadGoal = lead?.messages.filter((m) => m.role === 'user').pop()?.text.slice(0, 300) ?? '';
    // A helper must not be the busy lead; schedule() picks from free agents only.
    this.schedule(h, helperPrompt(this.label(lead?.leadId), leadGoal, request, owns));
  }

  private reportHelper(h: Thread, acc: Account, text: string): void {
    const resultFile = h.helperFile!.replace(/\.md$/, '.result.md');
    try {
      fs.writeFileSync(resultFile, `# ${h.title}\nDone by ${acc.label}.\n\n${text}\n`);
    } catch {
      /* the lead still sees the thread */
    }
    const parent = h.parentId ? this.get(h.parentId) : undefined;
    log('engine', `helper done: "${h.title}" by ${acc.label}`, { helper: h.id, parent: parent?.id, parentStatus: parent?.status });
    if (!parent) return;
    (parent.reports ??= []).push({ by: acc.label, title: h.title, text, file: path.relative(parent.cwd, resultFile).replace(/\\/g, '/') });
    this.deliverReports(parent);
  }

  /**
   * Leading comes first: a parent hears about each finished helper at once and can act on it (check it, hand the
   * freed agent more work) before carrying on. Working parent: into its running turn when its CLI takes that (Codex),
   * otherwise it stops and resumes with the report. Idle or waiting parent: a turn now.
   */
  private deliverReports(p: Thread): void {
    if (!p.reports?.length) return;
    if (p.status === 'working' && p.runId) {
      const runId = p.runId;
      const batch = p.reports;
      p.reports = undefined;
      const note = this.reportPrompt(p, batch);
      void (this.d.steer?.(runId, note, `report from ${batch.map((r) => `${r.by} (${r.title})`).join(', ')}`) ?? Promise.resolve(false)).then((steered) => {
        if (steered) return log('engine', `report delivered into running turn of "${p.title}"`, { reports: batch.length });
        if (p.runId !== runId) {
          // The turn ended meanwhile: deliver as the next turn.
          (p.reports ??= []).unshift(...batch);
          if (p.status !== 'working') this.deliverReports(p);
          return;
        }
        log('engine', `report interrupts "${p.title}" (its CLI can't take messages mid-turn)`, { reports: batch.length });
        p.queue.unshift(note);
        p.restarting = true;
        this.d.cancelRun(runId);
      });
      return;
    }
    if (p.status === 'waiting' && p.pending) {
      p.pending += `\n\n${this.reportPrompt(p, p.reports)}`; // still waiting for a free agent: goes along
      p.reports = undefined;
      return;
    }
    p.awaitingHelpers = undefined;
    p.status = 'idle';
    const batch = p.reports;
    p.reports = undefined;
    log('engine', `report starts a turn for "${p.title}"`, { reports: batch.length });
    this.schedule(p, this.reportPrompt(p, batch));
  }

  /** What a thread's current turn has done so far, including the run in progress (the panel's live view). */
  liveActivity(threadId: string): string[] {
    const t = this.get(threadId);
    return [...(t?.work?.items ?? []), ...(this.live.get(threadId)?.items ?? [])];
  }

  /** Ends the turn's work log: it goes on the message that ends the turn (minus the final answer's own copy). */
  private takeWork(t: Thread, finalText?: string): { activity?: string[]; workedMs?: number } {
    const w = t.work;
    t.work = undefined;
    this.trackChanges(t);
    if (!w) return {};
    let items = w.items;
    const last = items.at(-1);
    if (finalText && last && /^(💬|🏁)/u.test(last) && finalText.trim().startsWith(last.slice(2).trim().slice(0, 60))) items = items.slice(0, -1);
    return { activity: items.length ? items : undefined, workedMs: Date.now() - w.startedAt };
  }

  /** The turn just ended: once its message is in, add what the turn changed in the workspace to it. */
  private trackChanges(t: Thread): void {
    const snap = this.snaps.get(t.id);
    this.snaps.delete(t.id);
    if (!snap || !this.d.changes) return;
    const tracker = this.d.changes;
    queueMicrotask(async () => {
      const msg = t.messages.at(-1); // takeWork's result goes on the message pushed right after it
      const before = await snap;
      const changes = before ? await tracker.diff(t.cwd, before) : undefined;
      if (!changes || !msg) return;
      msg.changes = changes;
      log('engine', `turn changed ${changes.files.length} file(s)`, { thread: t.id });
      this.changed();
    });
  }

  /** The message whose turn made these changes (for undo/redo and the diff view). */
  changesAt(threadId: string, at: number): { cwd: string; changes: RunChanges } | undefined {
    const t = this.get(threadId);
    const m = t?.messages.find((x) => x.at === at);
    return t && m?.changes ? { cwd: t.cwd, changes: m.changes } : undefined;
  }

  /** The user undid (or redid) a turn's changes. */
  markUndone(threadId: string, at: number, undone: boolean): void {
    const m = this.get(threadId)?.messages.find((x) => x.at === at);
    if (m?.changes) m.changes.undone = undone || undefined;
    this.changed();
  }

  /** Helper threads (with their own helpers) still running or queued for t. */
  private activeHelpers(t: Thread): Thread[] {
    return this.threads.filter((x) => x.parentId === t.id && x.helperFile && (x.status !== 'idle' || x.queue.length > 0 || this.activeHelpers(x).length > 0));
  }

  private reportPrompt(t: Thread, batch: NonNullable<Thread['reports']>): string {
    const reports = batch.map((r) => `### ${r.title} (by ${r.by}${r.file ? `; saved in ${r.file}` : ''})\n${r.text}`).join('\n\n');
    const others = this.activeHelpers(t);
    const idle = this.free().filter((a) => a.id !== t.leadId);
    const still = others.length ? `Still working for you: ${others.map((o) => `"${o.title}" (${o.status === 'working' ? this.label(o.leadId) : 'waiting for a free agent'})`).join(', ')}.\n` : '';
    return `Helper report${batch.length > 1 ? 's' : ''}:\n\n${reports}\n\n${still}Free now: ${idle.map((a) => a.label).join(', ') || 'nobody'}.
Leading comes first: check this result, and if any work is left, give each free teammate a task right now; then continue your own part. Only when the whole request is done and nobody is still working for you, reply with the complete final answer for the user (they haven't seen your earlier replies); until then keep replies short.`;
  }

  /** Who is free right now, so the agent spreads independent work across the team instead of doing it alone. */
  private teamNote(t: Thread, acc: Account): string {
    // Even when everyone is busy right now: queued pieces are picked up as soon as anyone frees up.
    const team = this.d.config.accounts.filter((a) => a.id !== acc.id && a.role !== 'off' && !this.isOut(a));
    if (!team.length) return '';
    const free = this.free().filter((a) => a.id !== acc.id);
    const busy = team.filter((a) => !free.includes(a));
    return `<super-agent-internal>
Team right now: free: ${free.map((a) => a.label).join(', ') || 'nobody'}${busy.length ? `; busy: ${busy.map((a) => a.label).join(', ')}` : ''}. Hand-offs: \`${HANDOFF_DIR}/${t.id}/\` · live status: \`${TEAM_FILE}\`.
</super-agent-internal>

`;
  }

  // ---------------------------------------------------------------- state

  get(id: string): Thread | undefined {
    return this.threads.find((t) => t.id === id);
  }

  private account(id?: string): Account | undefined {
    return this.d.config.accounts.find((a) => a.id === id);
  }

  label(id?: string): string {
    return this.account(id)?.label ?? 'An agent';
  }

  private create(title: string, cwd: string, parentId?: string): Thread {
    const t: Thread = { id: newId(), title, cwd, status: 'idle', queue: [], messages: [], parentId, createdAt: Date.now(), updatedAt: Date.now() };
    this.threads.unshift(t);
    this.changed();
    return t;
  }

  private push(t: Thread, m: Omit<Thread['messages'][number], 'at'>): void {
    t.messages.push({ ...m, at: Date.now() });
    // "Last used": your messages and the agents' replies, not status notes (stopped, interrupted, …).
    if (m.role !== 'system') t.updatedAt = Date.now();
    if (t.title === 'New thread' && m.role === 'user') t.title = titleOf(m.text);
    this.changed();
  }

  private sys(t: Thread, text: string): void {
    this.push(t, { role: 'system', text });
  }

  /** Saves within a few seconds (for live output: frequent, so it doesn't notify the panel or save every time). */
  private queueSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.save(), 2000);
  }

  private changed(): void {
    this.d.onChange();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.save();
      // Every workspace agents work in gets the live team status they can read at any time.
      for (const dir of this.watchers.keys()) {
        const cwd = path.dirname(path.dirname(dir));
        try {
          fs.writeFileSync(path.join(cwd, TEAM_FILE), this.teamStatus(cwd));
        } catch {
          /* folder not writable */
        }
      }
    }, 300);
  }

  /** The live status agents read: who is free or busy, and every hand-off in this folder with its state. */
  teamStatus(cwd: string): string {
    const rel = (f: string) => path.relative(cwd, f).replace(/\\/g, '/');
    const lines = [`# Super Agent team (live, updated ${new Date().toLocaleTimeString()})`, '', '## Agents'];
    for (const a of this.d.config.accounts.filter((x) => x.role !== 'off')) {
      const work = this.threads.find((t) => t.status === 'working' && t.leadId === a.id);
      lines.push(`- ${a.label}: ${work ? `busy on "${work.title}"` : this.isOut(a) ? 'unavailable (out of usage or signed out)' : 'free'}`);
    }
    const handoffs = this.threads.filter((t) => t.cwd === cwd && t.helperFile).slice(0, 60).reverse();
    if (handoffs.length) {
      lines.push('', '## Hand-offs (oldest first)');
      for (const h of handoffs) {
        const done = h.status === 'idle' && h.messages.some((m) => m.role === 'agent');
        const state =
          h.status === 'working' ? `working: ${this.label(h.leadId)}`
          : h.status === 'waiting' ? (h.awaitingHelpers ? `waiting for its own helpers: ${this.label(h.leadId)}` : 'queued')
          : done ? `done: ${this.label(h.leadId)}`
          : 'stopped';
        const from = h.parentId ? this.get(h.parentId)?.title : undefined;
        lines.push(`- [${state}] ${h.title}${from ? ` (for "${from}")` : ''}: ${rel(h.helperFile!)}${done ? ` → ${rel(h.helperFile!.replace(/\.md$/, '.result.md'))}` : ''}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  dispose(): void {
    if (this.saveTimer) this.save(); // VS Code is closing or reloading: keep the last changes
    for (const w of this.watchers.values()) w.close();
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
  }
}

/** Keep hand-off notes out of git (local exclude, never committed). */
function ensureIgnored(cwd: string): void {
  try {
    const exclude = path.join(cwd, '.git', 'info', 'exclude');
    if (!fs.existsSync(path.dirname(exclude))) return;
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!cur.includes('.super-agent/')) fs.appendFileSync(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}.super-agent/\n`);
  } catch {
    /* not a git repo */
  }
}
