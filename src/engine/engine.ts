import fs from 'node:fs';
import path from 'node:path';
import type { Account, AgentKind, Autonomy } from '../../../super-agent/src/shared/types';
import type { AccountPool } from '../../../super-agent/src/main/agents/pool';
import type { RunRequest, RunResult } from '../../../super-agent/src/main/agents/runner';
import type { ConfigStore } from '../../../super-agent/src/main/store/config';
import { contextBrief, helperPrompt, leadPreamble, transferSession } from './context';
import type { Thread } from './types';

export interface EngineDeps {
  config: ConfigStore;
  pool: AccountPool;
  dataDir: string;
  cliPath(kind: AgentKind): string | null;
  runAgent(req: RunRequest): Promise<RunResult>;
  cancelRun(runId: string): void;
  usageLoad(id: string): number;
  usageResetAt(id: string): number | undefined;
  autonomy(): Autonomy;
  onChange(): void;
  onOutput(threadId: string, text: string): void;
  onFinished(t: Thread, outcome: 'done' | 'failed'): void;
}

const HANDOFF_DIR = '.super-agent/handoff';
const COOLDOWN_MIN = 20;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const titleOf = (text: string) => text.trim().split(/\r?\n/)[0].slice(0, 60) || 'New thread';

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
  private saveTimer: NodeJS.Timeout | null = null;
  private file: string;

  constructor(private d: EngineDeps) {
    this.file = path.join(d.dataDir, 'vscode-threads.json');
    try {
      this.threads = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Thread[];
      for (const t of this.threads) {
        if (t.status === 'working') {
          t.status = 'idle';
          this.sys(t, 'Interrupted (VS Code was closed). Send a message to continue.');
        }
      }
    } catch {
      this.threads = [];
    }
  }

  // ---------------------------------------------------------------- public API

  send(threadId: string | undefined, text: string, cwd: string, attachments: string[] = []): Thread {
    const typed = text.trim();
    // Agents read attached files (images included) themselves, so they just get the paths.
    const msg = attachments.length ? `${typed || 'See the attached files.'}\n\nAttached files (read them):\n${attachments.map((a) => `- ${a}`).join('\n')}` : typed;
    const shown = { role: 'user' as const, text: typed, attachments: attachments.length ? attachments : undefined };
    let t = threadId ? this.get(threadId) : undefined;
    if (!t) {
      t = this.create(titleOf(typed || path.basename(attachments[0] ?? '')), cwd);
      this.push(t, shown);
      this.schedule(t, msg);
      return t;
    }
    this.push(t, shown);
    if (t.status !== 'working') {
      this.schedule(t, msg);
      return t;
    }
    // The lead is busy: hand the whole request to a free agent, who leads it as its own thread.
    const free = this.free();
    const helper = free.find((a) => a.id === this.preferredLead()?.id) ?? free[0];
    if (helper) {
      const child = this.create(titleOf(typed), t.cwd, t.id);
      this.push(child, shown);
      this.sys(t, `${this.label(t.leadId)} is busy, so ${helper.label} took this request as a new thread: "${child.title}".`);
      this.schedule(child, `${contextBrief(t, (id) => this.label(id), 'delegated from a busy teammate')}\n\n## Your request\n${msg}`, helper);
      return child;
    }
    t.queue.push(msg);
    this.sys(t, `Queued: ${this.label(t.leadId)} picks this up next (no other agent is free).`);
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

  deleteThread(threadId: string): void {
    this.stop(threadId);
    this.threads = this.threads.filter((t) => t.id !== threadId);
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

  /** Free team members, least-used first. */
  private free(): Account[] {
    return this.d.config.accounts
      .filter((a) => a.role !== 'off' && !this.isOut(a) && this.d.pool.available(a.id, 1))
      .sort((a, b) => this.d.usageLoad(a.id) - this.d.usageLoad(b.id));
  }

  /** Who should run this thread now: the pinned agent, else the crowned lead, else the same agent as before, else same CLI, else anyone free. */
  private pick(t: Thread): Account | undefined {
    const free = this.free();
    const byId = (id?: string) => free.find((a) => a.id === id);
    const pinned = this.account(t.pinnedLeadId);
    // A pinned agent that is merely busy is waited for; only when it is out of usage does someone else step in.
    if (pinned && !this.isOut(pinned)) return byId(pinned.id);
    // Moving the crown mid-thread hands the next message to the new lead, with the full context.
    return byId(this.preferredLead()?.id) ?? byId(t.leadId) ?? free.find((a) => a.kind === t.session?.kind) ?? free[0];
  }

  private preferredLead(): Account | undefined {
    return this.d.config.accounts.find((a) => a.role === 'master');
  }

  private schedule(t: Thread, prompt: string, preferred?: Account): void {
    const acc = preferred ?? this.pick(t);
    if (!acc) {
      t.status = 'waiting';
      t.pending = prompt;
      this.sys(t, 'Waiting for a free agent with usage left…');
      return;
    }
    void this.start(t, acc, prompt);
  }

  /** Run waiting threads and queued messages as agents free up. */
  private pump(): void {
    for (const t of this.threads) {
      if (t.status === 'waiting' && t.pending) {
        const acc = this.pick(t);
        if (acc) {
          const p = t.pending;
          t.pending = undefined;
          void this.start(t, acc, p);
        }
      } else if (t.status === 'idle' && t.queue.length) {
        this.schedule(t, t.queue.shift()!);
      }
    }
  }

  // ---------------------------------------------------------------- running

  private async start(t: Thread, acc: Account, prompt: string): Promise<void> {
    const cli = this.d.cliPath(acc.kind);
    if (!cli) return;
    let resume: string | undefined;
    let input = prompt;
    const prev = t.session;
    if (prev && prev.accountId === acc.id) {
      resume = prev.id;
    } else if (prev && prev.kind === acc.kind && acc.kind !== 'antigravity' && this.account(prev.accountId) && transferSession(prev, this.account(prev.accountId)!, acc)) {
      resume = prev.id; // exact context carried to another account of the same CLI
    } else if (prev || t.messages.length > 1) {
      input = `${contextBrief(t, (id) => this.label(id), prev ? `continuing from ${this.label(prev.accountId)}` : 'continuing this thread')}\n\n## Now\n${prompt}`;
    }
    if (!resume && !t.helperFile) input = leadPreamble(HANDOFF_DIR) + input;
    if (!t.helperFile) this.watchHandoffs(t.cwd);

    const runId = newId();
    t.status = 'working';
    t.leadId = acc.id;
    t.runId = runId;
    t.runStartedAt = Date.now();
    t.lastLog = path.join(this.d.dataDir, 'vscode-logs', `${runId}.log`);
    this.changed();

    this.d.pool.acquire(acc.id);
    let res: RunResult;
    try {
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
        onText: (text) => this.d.onOutput(t.id, text),
        resume,
        browser: this.d.config.settings.browserTools !== false,
      });
    } finally {
      this.d.pool.release(acc.id);
    }
    t.runId = undefined;

    if (res.cancelled) {
      t.status = 'idle';
      this.sys(t, 'Stopped.');
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
      this.sys(t, `${acc.label} ${res.rateLimited ? 'ran out of usage' : 'is unavailable'}${next ? `, so ${next.label} takes over with the full context.` : '. Waiting for a free agent…'}`);
      t.status = 'idle';
      this.schedule(t, `You are taking over mid-task because the previous agent stopped (${res.rateLimited ? 'usage limit' : 'unavailable'}). Continue exactly where it left off and finish this request:\n\n${prompt}`, next);
    } else if (!res.finalText) {
      t.status = 'idle';
      this.sys(t, `${acc.label} stopped without an answer (${res.timedOut ? 'timed out' : `exit code ${res.code}`}). Send a message to continue.`);
      this.d.onFinished(t, 'failed');
    } else {
      if (res.sessionId) t.session = { accountId: acc.id, kind: acc.kind, id: res.sessionId };
      t.status = 'idle';
      this.push(t, { role: 'agent', text: res.finalText, accountId: acc.id });
      if (t.helperFile) this.reportHelper(t, acc, res.finalText);
      this.d.onFinished(t, 'done');
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
      for (const f of fs.readdirSync(dir)) this.handled.add(path.join(dir, f)); // only new requests count
      const w = fs.watch(dir, (_e, name) => {
        const file = name ? path.join(dir, String(name)) : '';
        if (!file.endsWith('.md') || file.endsWith('.result.md') || this.handled.has(file)) return;
        setTimeout(() => this.onHandoff(cwd, file), 400); // let the writer finish the file
      });
      this.watchers.set(dir, w);
    } catch {
      /* folder not writable */
    }
  }

  private onHandoff(cwd: string, file: string): void {
    if (this.handled.has(file) || !fs.existsSync(file)) return;
    this.handled.add(file);
    const request = fs.readFileSync(file, 'utf8').trim();
    if (!request) return;
    const lead = this.threads
      .filter((x) => x.cwd === cwd && x.status === 'working' && !x.helperFile)
      .sort((a, b) => (b.runStartedAt ?? 0) - (a.runStartedAt ?? 0))[0];
    const title = request.split(/\r?\n/)[0].replace(/^#+\s*/, '').slice(0, 60) || path.basename(file, '.md');
    const owns = /files?[^\n]*:\s*([^\n]+)/i.exec(request)?.[1] ?? '';
    const h = this.create(title, cwd, lead?.id);
    h.helperFile = file;
    this.push(h, { role: 'user', text: request });
    if (lead) this.sys(lead, `${this.label(lead.leadId)} handed off "${title}" to a helper.`);
    const leadGoal = lead?.messages.filter((m) => m.role === 'user').pop()?.text.slice(0, 300) ?? '';
    // A helper must not be the busy lead; schedule() picks from free agents only.
    this.schedule(h, helperPrompt(this.label(lead?.leadId), leadGoal, request, owns));
  }

  private reportHelper(h: Thread, acc: Account, text: string): void {
    try {
      fs.writeFileSync(h.helperFile!.replace(/\.md$/, '.result.md'), `# ${h.title}\nDone by ${acc.label}.\n\n${text}\n`);
    } catch {
      /* the lead still sees the thread */
    }
    const parent = h.parentId ? this.get(h.parentId) : undefined;
    if (parent) this.sys(parent, `Helper ${acc.label} finished "${h.title}": ${text.slice(0, 280)}${text.length > 280 ? '…' : ''}`);
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
    t.updatedAt = Date.now();
    if (t.title === 'New thread' && m.role === 'user') t.title = titleOf(m.text);
    this.changed();
  }

  private sys(t: Thread, text: string): void {
    this.push(t, { role: 'system', text });
  }

  private changed(): void {
    this.d.onChange();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.threads.slice(0, 200), null, 1));
      } catch {
        /* best effort */
      }
    }, 300);
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.close();
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
