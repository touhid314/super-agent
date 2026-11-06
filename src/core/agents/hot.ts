import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Account, AgentKind, Autonomy } from '../types';
import { accountEnv, buildArgs, codexBrowser, commandLine, writeBrowserConfig, type RunMode } from './cli';
import { log } from '../log';
import { projectDir } from '../store/paths';
import { killTreesNow } from './orphans';
import { ANSI, AUTH_FAILED, RATE_LIMIT, errorOf, killTree, renderAgyEvent, renderClaudeEvent, runAgent, toolLabel, type ApprovalAnswer, type ApprovalAsk, type RunRequest, type RunResult } from './runner';

/**
 * Hot agents: starting a CLI costs 2–4 s per message, so processes are kept running between turns.
 * - Codex: one `codex app-server` per account (and folder) serves every thread over JSON-RPC.
 * - Claude Code / Antigravity: a conversation's process stays alive in stream-json mode and takes the next message.
 * - Each account also keeps one idle spare ready, so a new thread or helper starts without the startup cost.
 * Anything the hot path can't take falls back to a regular one-shot run.
 */

/** Idle conversation processes kept per account (spares not counted); older ones are closed. */
const MAX_IDLE_SESSIONS = 2;
const IDLE_MS = 30 * 60000;
/** An idle process waiting for its own background work (a long scan, a Monitor) to wake it: kept this long. */
const BACKGROUND_IDLE_MS = 12 * 3600000;
/** A spare that dies this soon after starting (signed out, broken CLI) is not restarted for a while. */
const FAST_FAIL_MS = 10000;
const RETRY_SPARE_MS = 5 * 60000;

export interface WarmTarget {
  account: Account;
  cliPath: string;
}

interface WarmOptions {
  cwd: string;
  autonomy: Autonomy;
  browser: boolean;
}

/** A turn in flight: its log, live output and result. */
interface TurnCtx {
  req: RunRequest;
  log: fs.WriteStream;
  raw: string;
  final: string;
  timer: NodeJS.Timeout;
  /** When the turn times out, and how to stop it then (the clock stops while it waits for your approval). */
  deadline: number;
  stop: (t: TurnCtx) => void;
  /** Approval requests waiting for your answer. */
  asking: number;
  /** Codex: the files each edit item changes (its approval request only names the item). */
  files: Map<string, string[]>;
  cancelled: boolean;
  timedOut: boolean;
  sessionId?: string;
  resolve: (r: RunResult) => void;
  /**
   * Claude Code: our message isn't being worked on yet. It echoes each message as it starts on it
   * (--replay-user-messages); turns that end before that (a queued background-task notice, say) aren't ours.
   */
  awaitingEcho?: boolean;
  /** Background work still running when the turn ended (Claude Code). */
  background?: string[];
}

interface StreamProc {
  account: Account;
  cwd: string;
  key: string;
  child: ChildProcess;
  sessionId?: string;
  turn?: TurnCtx;
  spare: boolean;
  startedAt: number;
  lastUsed: number;
  buf: string;
  dead: boolean;
  /** Runs an older CLI build (it was updated meanwhile): never reused, closed once its turn ends. */
  stale?: boolean;
  /** Output the agent produced on its own after its turn ended (a background task woke it), kept for `attach`. */
  held?: string[];
  /** Started background work (a background command or a Monitor): it may wake up by itself, so keep it open. */
  background?: boolean;
  /** The background work running right now, as Claude Code lists it (its descriptions). */
  tasks?: string[];
  /** Asked for a turn for the held output already (once until a turn takes it). */
  woke?: boolean;
}

/** An agent that finished its turn started working again by itself (its background work woke it up). */
export interface WakeEvent {
  account: Account;
  sessionId: string;
  cwd: string;
}

interface CodexServer {
  account: Account;
  cwd: string;
  key: string;
  child: ChildProcess;
  ready: Promise<boolean>;
  calls: Map<number, (m: any) => void>;
  nextId: number;
  loaded: Set<string>;
  turns: Map<string, TurnCtx & { turnId?: string }>;
  buf: string;
  dead: boolean;
  stale?: boolean;
}

/** The line that ends an agent's turn (Claude Code / Antigravity stream-json). */
const isTurnEnd = (p: { account: Account }, line: string) => (p.account.kind === 'claude' ? renderClaudeEvent(line) : renderAgyEvent(line)).final !== undefined;
/** A line where the agent acts (writes or uses a tool), as opposed to a status line. */
const isActing = (p: { account: Account }, line: string) =>
  p.account.kind === 'claude' ? /"type"\s*:\s*"assistant"/.test(line) : /"step_update"/.test(line) && /"text_delta"|"tool_name"/.test(line);

const sig = (mode: RunMode, autonomy: Autonomy, account: Account, browser: boolean) => JSON.stringify([mode, autonomy, account.model ?? '', account.effort ?? '', browser]);

export class HotAgents {
  private streams: StreamProc[] = [];
  private servers = new Map<string, CodexServer>();
  private byRun = new Map<string, () => void>();
  private steerable = new Map<string, (text: string, label: string) => Promise<boolean>>();
  private spareFailedAt = new Map<string, number>();
  /** Codex servers replaced after a CLI update, still finishing a turn. */
  private retired: CodexServer[] = [];
  /** CLIs being updated: no new processes for them (they would lock the binary or run the old build). */
  private paused = new Set<AgentKind>();
  private sweep = setInterval(() => this.closeIdle(), 5 * 60000);

  /** Called once per wake-up; the engine answers by running an `attach` turn for that session. */
  onWake?: (w: WakeEvent) => void;
  /** An agent's background work changed (started or ended), between turns too: what is still running. */
  onBackground?: (b: { account: Account; sessionId: string; tasks: string[] }) => void;

  constructor(private dataDir: string) {}

  /** Runs a turn on a hot process (starting one if needed); one-shot run if that's not possible. */
  run(req: RunRequest): Promise<RunResult> {
    try {
      if (req.account.kind === 'codex') return this.runCodex(req);
      return this.runStream(req);
    } catch {
      return runAgent(req);
    }
  }

  /** Adds a user message to a running turn (Codex); false when that isn't possible, so the caller restarts instead. */
  steer(runId: string, text: string, label = 'message from you'): Promise<boolean> {
    return this.steerable.get(runId)?.(text, label) ?? Promise.resolve(false);
  }

  /** Stops a run started here; false if it isn't one of ours. */
  cancel(runId: string): boolean {
    const stop = this.byRun.get(runId);
    if (!stop) return false;
    stop();
    return true;
  }

  /** Keeps every team member ready: a Codex server, or a spare Claude Code / Antigravity process. */
  warm(targets: WarmTarget[], o: WarmOptions): void {
    for (const { account, cliPath } of targets) {
      if (this.paused.has(account.kind)) continue;
      if (account.kind === 'codex') void this.server(account, cliPath, o.cwd, o.browser);
      else this.ensureSpare(account, cliPath, o.cwd, 'write', o.autonomy, o.browser);
    }
  }

  /** A CLI is about to be updated: close its idle processes and start no new ones until `resume`. */
  pause(kind: AgentKind): void {
    this.paused.add(kind);
    this.restartKind(kind);
  }

  /** The update is done: anything started meanwhile (or still on the old build) is replaced as it frees up. */
  resume(kind: AgentKind): void {
    this.paused.delete(kind);
    this.restartKind(kind);
  }

  /** Whether any turn of this CLI is running (background updates wait for none). */
  busy(kind: AgentKind): boolean {
    return this.streams.some((p) => p.account.kind === kind && !!p.turn) || [...this.servers.values(), ...this.retired].some((x) => x.account.kind === kind && x.turns.size > 0);
  }

  /**
   * A CLI was updated: its processes run the old build. Idle ones close now; busy ones finish their turn first.
   * The next run (or warm-up) starts the new build.
   */
  restartKind(kind: AgentKind): void {
    for (const p of this.streams.filter((x) => x.account.kind === kind)) {
      p.stale = true;
      if (!p.turn) this.kill(p.child);
    }
    for (const [key, s] of [...this.servers].filter(([, x]) => x.account.kind === kind)) {
      s.stale = true;
      this.servers.delete(key);
      if (s.turns.size) this.retired.push(s);
      else this.kill(s.child);
    }
    log('hot', `restarting ${kind} processes (CLI update)`);
  }

  /** An account was signed out or removed: its processes go (a turn in progress is stopped with them). */
  closeAccount(accountId: string): void {
    for (const p of this.streams.filter((x) => x.account.id === accountId)) this.kill(p.child);
    for (const [key, s] of [...this.servers].filter(([, x]) => x.account.id === accountId)) {
      this.servers.delete(key);
      this.kill(s.child);
    }
    log('hot', `closed the processes of account ${accountId} (signed out or removed)`);
  }

  dispose(): void {
    clearInterval(this.sweep);
    // VS Code is closing or reloading: stop every agent now and wait for it. A kill left to run in the background
    // may never happen, and an agent left running keeps editing on its own (next to the new window's agent).
    const pids = [...this.streams.map((p) => p.child), ...[...this.servers.values(), ...this.retired].map((s) => s.child)]
      .filter((c) => c.exitCode === null && c.pid)
      .map((c) => c.pid!);
    killTreesNow(pids);
    this.streams = [];
    this.servers.clear();
  }

  // ---------------------------------------------------------------- turns (shared)

  private open(req: RunRequest, resolve: (r: RunResult) => void, stop: (t: TurnCtx) => void): TurnCtx {
    fs.mkdirSync(path.dirname(req.logFile), { recursive: true });
    const t: TurnCtx = { req, log: fs.createWriteStream(req.logFile, { flags: 'a' }), raw: '', final: '', cancelled: false, timedOut: false, resolve, timer: undefined as never, deadline: 0, stop, asking: 0, files: new Map() };
    this.emit(t, `$ ${req.account.kind} (${req.account.label}) in ${req.cwd} · hot\n\n`);
    this.arm(t, req.timeoutMs);
    this.byRun.set(req.runId, () => {
      t.cancelled = true;
      stop(t);
    });
    return t;
  }

  /** The turn's time limit: stops it once `ms` have passed. */
  private arm(t: TurnCtx, ms: number): void {
    clearTimeout(t.timer);
    t.deadline = Date.now() + ms;
    t.timer = setTimeout(() => {
      t.timedOut = true;
      this.emit(t, `\n[super-agent] timed out after ${Math.round(t.req.timeoutMs / 60000)} min, stopping.\n`);
      t.stop(t);
    }, ms);
  }

  private emit(t: TurnCtx, text: string): void {
    if (!text) return;
    t.raw += text;
    t.log.write(text);
    t.req.onText(text);
  }

  private finish(t: TurnCtx, code: number | null): void {
    if (!this.byRun.has(t.req.runId)) return; // already finished
    this.byRun.delete(t.req.runId);
    this.steerable.delete(t.req.runId);
    clearTimeout(t.timer);
    const finalText = t.final.trim();
    const failed = code !== 0 || !finalText;
    const tail = t.raw.slice(-6000);
    const rateLimited = failed && RATE_LIMIT.test(tail);
    const authFailed = failed && !rateLimited && !t.cancelled && AUTH_FAILED.test(tail);
    const authReason = authFailed ? tail.split(/\r?\n/).reverse().find((l) => AUTH_FAILED.test(l))?.trim().slice(0, 240) : undefined;
    log('hot', `turn end on ${t.req.account.label}`, { run: t.req.runId, code, finalChars: finalText.length, rateLimited, authFailed, cancelled: t.cancelled, timedOut: t.timedOut });
    this.emit(t, `\n[super-agent] turn ended${rateLimited ? ' (rate limited)' : authFailed ? ' (account unavailable)' : failed ? ` (code ${code})` : ''}\n`);
    t.log.end();
    const error = failed && !t.cancelled ? errorOf(tail) : undefined;
    t.resolve({ code, finalText, rateLimited, authFailed, authReason, error, cancelled: t.cancelled, timedOut: t.timedOut, sessionId: t.sessionId, background: t.background });
  }

  private kill(child: ChildProcess): void {
    if (child.pid && child.exitCode === null) killTree(child.pid);
  }

  // ---------------------------------------------------------------- Claude Code / Antigravity (stream-json)

  private runStream(req: RunRequest): Promise<RunResult> {
    if (req.attach) return this.attachStream(req);
    const key = sig(req.mode, req.autonomy, req.account, !!req.browser);
    const fits = (p: StreamProc) => !p.dead && !p.stale && !p.turn && p.account.id === req.account.id && p.cwd === req.cwd && p.key === key;
    let p = req.resume ? this.streams.find((x) => fits(x) && x.sessionId === req.resume) : this.streams.find((x) => fits(x) && x.spare);
    if (p?.spare) {
      p.spare = false;
      setTimeout(() => this.ensureSpare(req.account, req.cliPath, req.cwd, req.mode, req.autonomy, !!req.browser), 1000);
    }
    p ??= this.spawnStream(req.account, req.cliPath, req.cwd, req.mode, req.autonomy, !!req.browser, req.resume);
    const proc = p;
    return new Promise((resolve) => {
      const t = this.open(req, resolve, () => {
        // A hot CLI can't be interrupted mid-turn reliably: end the process (the next turn resumes the session).
        this.kill(proc.child);
      });
      t.sessionId = proc.sessionId;
      proc.turn = t;
      proc.lastUsed = Date.now();
      // What it did on its own since its last reply belongs to this turn too (not that work's own end).
      for (const line of this.takeHeld(proc)) if (!isTurnEnd(proc, line)) this.onStreamLine(proc, line);
      const message = { role: 'user', content: req.prompt };
      if (req.account.kind === 'claude') t.awaitingEcho = true;
      const line = req.account.kind === 'claude' ? { type: 'user', message } : { event: 'user', message };
      proc.child.stdin?.write(JSON.stringify(line) + '\n');
    });
  }

  /** Takes over the turn a woken-up agent is running by itself: no prompt, just its output from the start. */
  private attachStream(req: RunRequest): Promise<RunResult> {
    const proc = this.streams.find((x) => !x.dead && !x.turn && x.account.id === req.account.id && x.sessionId === req.resume);
    if (!proc) return Promise.resolve({ code: null, finalText: '', sessionId: req.resume, rateLimited: false, cancelled: true, timedOut: false });
    return new Promise((resolve) => {
      const t = this.open(req, resolve, () => this.kill(proc.child));
      t.sessionId = proc.sessionId;
      proc.turn = t;
      proc.lastUsed = Date.now();
      for (const line of this.takeHeld(proc)) if (proc.turn === t) this.onStreamLine(proc, line);
    });
  }

  private takeHeld(p: StreamProc): string[] {
    const held = p.held ?? [];
    p.held = undefined;
    p.woke = false;
    return held;
  }

  private ensureSpare(account: Account, cliPath: string, cwd: string, mode: RunMode, autonomy: Autonomy, browser: boolean): void {
    if (this.paused.has(account.kind)) return;
    const key = sig(mode, autonomy, account, browser);
    if (this.streams.some((p) => !p.dead && !p.stale && p.spare && p.account.id === account.id && p.cwd === cwd && p.key === key)) return;
    if (Date.now() - (this.spareFailedAt.get(account.id) ?? 0) < RETRY_SPARE_MS) return;
    // A spare for other settings (model changed, browser toggled) is no longer useful.
    for (const p of this.streams.filter((x) => x.spare && x.account.id === account.id)) this.kill(p.child);
    const p = this.spawnStream(account, cliPath, cwd, mode, autonomy, browser);
    p.spare = true;
  }

  private spawnStream(account: Account, cliPath: string, cwd: string, mode: RunMode, autonomy: Autonomy, browser: boolean, resume?: string): StreamProc {
    const claude = account.kind === 'claude';
    const newSessionId = claude && !resume ? randomUUID() : undefined;
    const b = browser
      ? { outputDir: path.join(projectDir(cwd), 'screenshots'), configFile: path.join(this.dataDir, 'hot', `${account.id}.mcp.json`) }
      : undefined;
    if (b && claude) {
      fs.mkdirSync(path.dirname(b.configFile), { recursive: true });
      writeBrowserConfig(b.configFile, b.outputDir);
    }
    const args = buildArgs({ kind: account.kind, mode, autonomy, cwd, model: account.model, effort: account.effort, lastMessageFile: '', resume, newSessionId, browser: b, dirs: [projectDir(cwd)] });
    // Standard: what its permission mode doesn't allow (e.g. editing outside the folder) is asked of us, and we ask you.
    const ask = mode === 'write' && autonomy === 'standard' ? ['--permission-prompt-tool', 'stdio'] : [];
    const child = claude
      ? spawn(commandLine(cliPath, ['--input-format', 'stream-json', '--replay-user-messages', ...ask, ...args]), { cwd, env: accountEnv(account), shell: true, windowsHide: true })
      : spawn(cliPath, [...args, '--input-format', 'stream-json', '-p='], { cwd, env: accountEnv(account), windowsHide: true });
    const p: StreamProc = { account, cwd, key: sig(mode, autonomy, account, browser), child, sessionId: resume ?? newSessionId, spare: false, startedAt: Date.now(), lastUsed: Date.now(), buf: '', dead: false };
    this.streams.push(p);
    log('hot', `spawn ${account.kind} for ${account.label}${resume ? ' (resume)' : newSessionId ? ' (new session)' : ''}`, { pid: child.pid, cwd });

    child.stdout?.on('data', (d: Buffer) => {
      p.buf += d.toString('utf8').replace(ANSI, '');
      const lines = p.buf.split('\n');
      p.buf = lines.pop() ?? '';
      for (const line of lines) this.onStreamLine(p, line);
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (p.turn) this.emit(p.turn, d.toString('utf8').replace(ANSI, ''));
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', () => undefined);
    child.on('close', (code) => {
      log('hot', `exit ${account.kind} for ${account.label}`, { code, spare: p.spare, inTurn: !!p.turn, aliveMs: Date.now() - p.startedAt });
      p.dead = true;
      this.streams = this.streams.filter((x) => x !== p);
      if (p.spare && Date.now() - p.startedAt < FAST_FAIL_MS) this.spareFailedAt.set(account.id, Date.now());
      // Its background work ends with it: nothing will wake it up any more.
      if (p.tasks?.length && p.sessionId) this.onBackground?.({ account, sessionId: p.sessionId, tasks: [] });
      if (p.turn) {
        const t = p.turn;
        p.turn = undefined;
        this.finish(t, code ?? 1);
      }
    });
    return p;
  }

  private onStreamLine(p: StreamProc, line: string): void {
    if (!p.sessionId) p.sessionId = /"conversation_id"\s*:\s*"([^"]+)"/.exec(line)?.[1];
    this.trackTasks(p, line);
    const t = p.turn;
    if (!t) return this.onIdleLine(p, line);
    if (/"name"\s*:\s*"Monitor"|"run_in_background"\s*:\s*true/.test(line)) p.background = true;
    t.sessionId ??= p.sessionId;
    if (t.awaitingEcho && /"isReplay"\s*:\s*true/.test(line)) t.awaitingEcho = false; // it starts on our message now
    if (p.account.kind === 'claude' && /^\s*\{"type"\s*:\s*"control_request"/.test(line)) return void this.onClaudeRequest(p, t, line);
    const r = p.account.kind === 'claude' ? renderClaudeEvent(line) : renderAgyEvent(line);
    this.emit(t, r.text);
    if (r.final === undefined) return; // not the end of the turn yet
    // A turn Claude ran before getting to our message (e.g. a notice about a background task cut off by the restart).
    // (An error still ends it: a failure must not leave the turn waiting.)
    if (t.awaitingEcho && !/"is_error"\s*:\s*true/.test(line)) return log('hot', `${p.account.label}: a queued turn ended before ours; waiting for ours`, { run: t.req.runId });
    t.final = r.final;
    t.background = p.tasks?.length ? p.tasks : undefined;
    p.turn = undefined;
    p.lastUsed = Date.now();
    this.finish(t, r.final ? 0 : 1);
    this.trimIdle(p.account.id);
  }

  /** Claude Code lists its running background work whenever it changes (`background_tasks_changed`). */
  private trackTasks(p: StreamProc, line: string): void {
    if (p.account.kind !== 'claude' || !line.includes('"background_tasks_changed"')) return;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.subtype !== 'background_tasks_changed' || !Array.isArray(m.tasks)) return;
    const tasks: string[] = m.tasks.map((x: any) => String(x.description ?? x.task_type ?? 'a background task'));
    p.tasks = tasks;
    p.background = tasks.length > 0; // exact now: kept open only while something can still wake it
    if (p.sessionId) this.onBackground?.({ account: p.account, sessionId: p.sessionId, tasks });
  }

  /**
   * Output from an agent between turns: its background work woke it up and it carries on by itself. Keep it and ask
   * for a turn to show it in (once, when it starts acting: status lines alone don't count).
   */
  private onIdleLine(p: StreamProc, line: string): void {
    if (p.spare || !p.sessionId || !line.trim()) return;
    p.held = [...(p.held ?? []), line].slice(-5000);
    p.lastUsed = Date.now();
    if (p.woke || !isActing(p, line)) return;
    p.woke = true;
    log('hot', `${p.account.label} woke up by itself (background work)`, { session: p.sessionId });
    this.onWake?.({ account: p.account, sessionId: p.sessionId, cwd: p.cwd });
  }

  /** Keeps the most recently used idle conversations per account; closes the rest (not ones with background work). */
  private trimIdle(accountId: string): void {
    const idle = this.streams.filter((p) => p.account.id === accountId && !p.spare && !p.turn && !p.background).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const p of idle.slice(MAX_IDLE_SESSIONS)) this.kill(p.child);
  }

  private closeIdle(): void {
    // Closing one that waits for its background work would lose that work's wake-up (and its report) without a trace,
    // so those stay open much longer, even after a CLI update (stale).
    const tooLong = (p: StreamProc) => Date.now() - p.lastUsed > (p.background ? BACKGROUND_IDLE_MS : IDLE_MS);
    for (const p of this.streams) if (!p.turn && ((p.stale && !p.background) || (!p.spare && tooLong(p)))) this.kill(p.child);
    for (const s of this.retired.filter((x) => !x.turns.size)) this.kill(s.child);
    this.retired = this.retired.filter((x) => x.turns.size && !x.dead);
  }

  // ---------------------------------------------------------------- Codex (app-server)

  private server(account: Account, cliPath: string, cwd: string, browser: boolean): CodexServer {
    const key = `${account.id}|${cwd}|${browser}`;
    const existing = this.servers.get(key);
    if (existing && !existing.dead) return existing;
    // The model is chosen per thread (thread/start), so one server serves any model the account switches to.
    const extra = browser ? codexBrowser(path.join(projectDir(cwd), 'screenshots')) : [];
    const child = spawn(commandLine(cliPath, ['app-server', ...extra]), { cwd, env: accountEnv(account), shell: true, windowsHide: true });
    const s: CodexServer = { account, cwd, key, child, ready: Promise.resolve(false), calls: new Map(), nextId: 0, loaded: new Set(), turns: new Map(), buf: '', dead: false };
    this.servers.set(key, s);
    child.stdout?.on('data', (d: Buffer) => {
      s.buf += d.toString('utf8');
      let i: number;
      while ((i = s.buf.indexOf('\n')) >= 0) {
        const line = s.buf.slice(0, i).trim();
        s.buf = s.buf.slice(i + 1);
        if (!line) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id !== undefined && !m.method) {
          s.calls.get(m.id)?.(m);
          s.calls.delete(m.id);
        } else if (m.method && m.id !== undefined) {
          void this.onCodexRequest(s, m);
        } else if (m.method) {
          this.onCodexNote(s, m);
        }
      }
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', () => undefined);
    child.on('close', () => {
      s.dead = true;
      if (this.servers.get(key) === s) this.servers.delete(key);
      for (const cb of s.calls.values()) cb({ error: { message: 'Codex server stopped' } });
      for (const t of s.turns.values()) this.finish(t, 1);
      s.turns.clear();
    });
    s.ready = this.call(s, 'initialize', { clientInfo: { name: 'super-agent', version: '1' }, capabilities: null }).then((r) => {
      if (r.error) return false;
      child.stdin?.write(JSON.stringify({ method: 'initialized' }) + '\n');
      return true;
    });
    return s;
  }

  private call(s: CodexServer, method: string, params: unknown): Promise<any> {
    if (s.dead) return Promise.resolve({ error: { message: 'Codex server stopped' } });
    return new Promise((resolve) => {
      const id = ++s.nextId;
      s.calls.set(id, resolve);
      s.child.stdin?.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  private async runCodex(req: RunRequest): Promise<RunResult> {
    const s = this.server(req.account, req.cliPath, req.cwd, !!req.browser);
    if (!(await s.ready)) {
      log('hot', `codex server not ready for ${req.account.label}: one-shot run`);
      return runAgent(req);
    }
    // Sandboxed, and before going outside it Codex asks: you (standard), or its automatic reviewer (auto, "approve for
    // me" in its app). Unattended runs can't ask anyone, so the sandbox just blocks.
    const auto = req.autonomy === 'auto';
    const approvalPolicy = req.mode !== 'read-only' && req.autonomy !== 'full' && (req.onApproval || auto) ? 'on-request' : 'never';
    const approvalsReviewer = auto ? 'auto_review' : 'user';
    const opts = {
      cwd: req.cwd,
      approvalPolicy,
      approvalsReviewer,
      sandbox: req.mode === 'read-only' ? 'read-only' : req.autonomy === 'full' ? 'danger-full-access' : 'workspace-write',
      model: req.account.model ?? null,
    };
    let threadId = req.resume;
    if (threadId && !s.loaded.has(threadId)) {
      const r = await this.call(s, 'thread/resume', { threadId, ...opts });
      if (r.error) {
        log('hot', 'codex thread/resume failed: one-shot run', r.error);
        return runAgent(req); // e.g. a session from another CLI version: the one-shot run handles it
      }
    } else if (!threadId) {
      const r = await this.call(s, 'thread/start', opts);
      threadId = r.result?.thread?.id as string | undefined;
      if (!threadId) return runAgent(req);
    }
    s.loaded.add(threadId);
    const tid = threadId;
    return new Promise((resolve) => {
      const t: TurnCtx & { turnId?: string } = this.open(req, resolve, (ctx) => {
        const turnId = (ctx as typeof t).turnId;
        if (turnId) void this.call(s, 'turn/interrupt', { threadId: tid, turnId });
        else this.finish(ctx, 1);
      });
      t.sessionId = tid;
      s.turns.set(tid, t);
      this.steerable.set(req.runId, async (text, label) => {
        if (!t.turnId) return false;
        const r = await this.call(s, 'turn/steer', { threadId: tid, expectedTurnId: t.turnId, input: [{ type: 'text', text, text_elements: [] }] });
        if (!r.error) this.emit(t, `\n→ ${label}\n`); // in the activity: who the inserted message is from
        return !r.error;
      });
      void this.call(s, 'turn/start', { threadId: tid, approvalPolicy, approvalsReviewer, sandboxPolicy: sandboxPolicy(req), effort: req.account.effort ?? null, input: [{ type: 'text', text: req.prompt, text_elements: [] }] }).then((r) => {
        if (r.error) {
          this.emit(t, `\n[codex] error: ${r.error.message ?? JSON.stringify(r.error)}\n`);
          s.turns.delete(tid);
          this.finish(t, 1);
          return;
        }
        t.turnId = r.result?.turn?.id;
        if ((t.cancelled || t.timedOut) && t.turnId) void this.call(s, 'turn/interrupt', { threadId: tid, turnId: t.turnId });
      });
    });
  }

  /**
   * Codex asks before stepping outside its sandbox (a command or edit outside the folder, network access): you answer
   * in the panel. Anything else it asks the client for isn't supported.
   */
  private async onCodexRequest(s: CodexServer, m: any): Promise<void> {
    const reply = (msg: object) => s.child.stdin?.write(JSON.stringify({ id: m.id, ...msg }) + '\n');
    const p = m.params ?? {};
    const legacy = m.method === 'execCommandApproval' || m.method === 'applyPatchApproval';
    const t = s.turns.get(legacy ? p.conversationId : p.threadId);
    const ask = codexAsk(m.method, p, t?.files);
    if (!ask) return void reply({ error: { code: -32601, message: 'Not supported by Super Agent' } });
    const answer = t && !t.cancelled && t.req.onApproval ? await this.askUser(t, ask) : 'decline';
    log('hot', `codex approval: ${answer}`, { method: m.method, ask });
    reply({ result: codexAnswer(m.method, p, answer) });
  }

  /** Claude Code asks whether it may use a tool (`--permission-prompt-tool stdio`): you answer in the panel. */
  private async onClaudeRequest(p: StreamProc, t: TurnCtx, line: string): Promise<void> {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const reply = (response: object) => p.child.stdin?.write(JSON.stringify({ type: 'control_response', response: { request_id: m.request_id, ...response } }) + '\n');
    const r = m.request ?? {};
    if (r.subtype !== 'can_use_tool') return void reply({ subtype: 'error', error: `Not supported by Super Agent: ${r.subtype}` });
    const ask = claudeAsk(r);
    const answer = !t.cancelled && t.req.onApproval ? await this.askUser(t, ask) : 'decline';
    log('hot', `claude approval: ${answer}`, { tool: r.tool_name, ask });
    reply({ subtype: 'success', response: claudeAnswer(r, answer) });
  }

  /** Waits for your answer; the turn's time limit doesn't run meanwhile. */
  private async askUser(t: TurnCtx, ask: ApprovalAsk): Promise<ApprovalAnswer> {
    if (t.asking++ === 0) clearTimeout(t.timer);
    const left = Math.max(t.deadline - Date.now(), 5 * 60000);
    const answer = await t.req.onApproval!(ask).catch((): ApprovalAnswer => 'decline');
    if (--t.asking === 0 && this.byRun.has(t.req.runId)) this.arm(t, left);
    const verdict = answer === 'accept' ? 'allowed' : answer === 'acceptForSession' ? 'allowed for this session' : 'declined';
    if (answer !== 'cancel') this.emit(t, `\n→ you ${verdict}: ${askSummary(ask)}\n`);
    return answer;
  }

  /** Codex events → the same readable lines the one-shot runs log (the panel's activity view parses them). */
  private onCodexNote(s: CodexServer, m: any): void {
    const p = m.params ?? {};
    const t = s.turns.get(p.threadId);
    if (!t) return;
    const item = p.item ?? {};
    switch (m.method) {
      case 'item/started':
        if (item.type === 'reasoning') this.emit(t, '\nthinking\n');
        // Codex labels each message: commentary on the way, or the final answer (shown as the answer while it streams).
        else if (item.type === 'agentMessage') this.emit(t, item.phase === 'final_answer' ? '\ncodex final\n' : '\ncodex\n');
        else if (item.type === 'commandExecution') this.emit(t, `\n→ run command ${unwrap(String(item.command ?? ''))}\n`);
        else if (item.type === 'fileChange') {
          const files = (item.changes ?? []).map((c: any) => String(c.path));
          t.files.set(String(item.id), files);
          this.emit(t, `\n→ edit files ${files.join(', ')}\n`);
        }
        else if (item.type === 'mcpToolCall') this.emit(t, `\n→ ${toolLabel(`mcp__${item.server}__${item.tool ?? ''}`)}\n`);
        else if (item.type === 'webSearch') this.emit(t, `\n→ web search ${item.query ?? ''}\n`);
        return;
      case 'item/agentMessage/delta':
        return this.emit(t, String(p.delta ?? ''));
      case 'item/autoApprovalReview/completed': {
        // Approve for me: what Codex's reviewer decided, in the turn's steps.
        const r = p.review ?? {};
        const verdict = r.status === 'approved' ? 'approved' : r.status === 'denied' ? 'denied' : String(r.status ?? 'done');
        return this.emit(t, `\n→ auto-review ${verdict}: ${reviewAction(p.action)}${r.rationale ? ` (${String(r.rationale).replace(/\s+/g, ' ').slice(0, 300)})` : ''}\n`);
      }
      case 'item/completed':
        if (item.type === 'agentMessage') {
          t.final = String(item.text ?? '');
          this.emit(t, '\n');
        }
        return;
      case 'error':
        if (!p.willRetry) this.emit(t, `\n[codex] error: ${p.error?.message ?? ''}\n`);
        return;
      case 'turn/completed': {
        const turn = p.turn ?? {};
        if (turn.error?.message) this.emit(t, `\n[codex] ${turn.status}: ${turn.error.message}\n`);
        s.turns.delete(p.threadId);
        this.finish(t, turn.status === 'completed' ? 0 : 1);
        return;
      }
    }
  }
}

/** Shows the command itself, not the PowerShell wrapper Codex runs it in. */
function unwrap(cmd: string): string {
  const m = /powershell(?:\.exe)?"?\s+-Command\s+(.*)$/is.exec(cmd);
  return (m ? m[1] : cmd).replace(/^['"](.*)['"]$/s, '$1').replace(/\s+/g, ' ').slice(0, 6000); // whole: the panel expands long ones
}

/** One line for what an agent asks permission for (activity view). */
export function askSummary(a: ApprovalAsk): string {
  if (a.kind === 'command') return `run ${a.command ?? 'a command'}`;
  const paths = a.paths?.length ? a.paths.join(', ') : '';
  if (a.kind === 'files') return `edit ${paths || 'files'}`;
  if (a.kind === 'tool') return `use ${a.tool ?? 'a tool'}${paths ? ` on ${paths}` : ''}`;
  return [paths && `write to ${paths}`, a.network && 'network access'].filter(Boolean).join(' and ') || 'more permissions';
}

/** Codex's approval request as what is asked; undefined for requests that aren't approvals. */
export function codexAsk(method: string, p: any, files?: Map<string, string[]>): ApprovalAsk | undefined {
  const reason = p.reason ?? undefined;
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { kind: 'command', command: unwrap(String(p.command ?? '')), cwd: p.cwd ?? undefined, network: p.networkApprovalContext ? true : undefined, reason };
    case 'item/fileChange/requestApproval':
      return { kind: 'files', paths: files?.get(String(p.itemId)) ?? (p.grantRoot ? [p.grantRoot] : []), reason };
    case 'item/permissions/requestApproval': {
      const fsp = p.permissions?.fileSystem ?? {};
      const entries = (fsp.entries ?? []).filter((e: any) => e.access !== 'read').map((e: any) => (typeof e.path === 'string' ? e.path : e.path?.path ?? JSON.stringify(e.path)));
      return { kind: 'permissions', paths: [...(fsp.write ?? []), ...entries], network: p.permissions?.network?.enabled ? true : undefined, cwd: p.cwd ?? undefined, reason };
    }
    case 'execCommandApproval':
      return { kind: 'command', command: unwrap((p.command ?? []).join(' ')), cwd: p.cwd, reason };
    case 'applyPatchApproval':
      return { kind: 'files', paths: Object.keys(p.fileChanges ?? {}), reason };
  }
  return undefined;
}

/** Your answer in the shape the request expects. */
export function codexAnswer(method: string, p: any, a: ApprovalAnswer): object {
  const yes = a === 'accept' || a === 'acceptForSession';
  if (method === 'item/permissions/requestApproval') {
    const want = p.permissions ?? {};
    const granted = yes ? { ...(want.network ? { network: want.network } : {}), ...(want.fileSystem ? { fileSystem: want.fileSystem } : {}) } : {};
    return { permissions: granted, scope: a === 'acceptForSession' ? 'session' : 'turn' };
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: a === 'accept' ? 'approved' : a === 'acceptForSession' ? 'approved_for_session' : a === 'cancel' ? 'abort' : { denied: { rejection: 'The user declined.' } } };
  }
  return { decision: a };
}

/** Claude Code's `can_use_tool` request as what is asked. */
export function claudeAsk(r: any): ApprovalAsk {
  const input = r.input ?? {};
  const reason = r.decision_reason ?? undefined;
  const file = input.file_path ?? input.notebook_path;
  if (r.tool_name === 'Bash' || r.tool_name === 'PowerShell') return { kind: 'command', command: String(input.command ?? ''), reason };
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(r.tool_name) && file) return { kind: 'files', paths: [String(file)], reason };
  const target = file ?? input.path ?? input.url;
  return { kind: 'tool', tool: String(r.display_name ?? r.tool_name ?? 'a tool'), paths: target ? [String(target)] : undefined, reason };
}

/** Your answer as Claude Code's permission result; "for this session" applies the rule it suggested (e.g. add the folder). */
export function claudeAnswer(r: any, a: ApprovalAnswer): object {
  if (a === 'accept' || a === 'acceptForSession') {
    const rules = a === 'acceptForSession' && Array.isArray(r.permission_suggestions) ? { updatedPermissions: r.permission_suggestions } : {};
    return { behavior: 'allow', updatedInput: r.input ?? {}, ...rules };
  }
  return a === 'cancel' ? { behavior: 'deny', message: 'The turn was stopped.', interrupt: true } : { behavior: 'deny', message: 'The user declined this.' };
}

/** What Codex's automatic reviewer looked at, in one line. */
function reviewAction(a: any): string {
  if (!a) return 'an action';
  if (a.type === 'command') return `run ${unwrap(String(a.command ?? ''))}`;
  if (a.type === 'execve') return `run ${[a.program, ...(a.argv ?? [])].join(' ')}`;
  if (a.type === 'applyPatch') return `edit ${(a.files ?? []).join(', ')}`;
  if (a.type === 'networkAccess') return `network access to ${a.host ?? a.target ?? ''}`;
  if (a.type === 'mcpToolCall') return `use ${a.server ?? ''} ${a.tool ?? ''}`.trim();
  return String(a.type ?? 'an action');
}

/** The sandbox for each turn, so a change of access level applies from the next message (not only to new threads). */
function sandboxPolicy(req: RunRequest): object {
  if (req.mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  if (req.autonomy === 'full') return { type: 'dangerFullAccess' };
  // Also Super Agent's folder for this project (hand-offs, team status), which is outside the workspace.
  return { type: 'workspaceWrite', writableRoots: [projectDir(req.cwd)], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}
