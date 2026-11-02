import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Account, Autonomy } from '../types';
import { accountEnv, buildArgs, codexBrowser, commandLine, writeBrowserConfig, type RunMode } from './cli';
import { log } from '../log';
import { ANSI, AUTH_FAILED, RATE_LIMIT, killTree, renderAgyEvent, renderClaudeEvent, runAgent, type RunRequest, type RunResult } from './runner';

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
  cancelled: boolean;
  timedOut: boolean;
  sessionId?: string;
  resolve: (r: RunResult) => void;
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
}

const sig = (mode: RunMode, autonomy: Autonomy, account: Account, browser: boolean) => JSON.stringify([mode, autonomy, account.model ?? '', account.effort ?? '', browser]);

export class HotAgents {
  private streams: StreamProc[] = [];
  private servers = new Map<string, CodexServer>();
  private byRun = new Map<string, () => void>();
  private steerable = new Map<string, (text: string, label: string) => Promise<boolean>>();
  private spareFailedAt = new Map<string, number>();
  private sweep = setInterval(() => this.closeIdle(), 5 * 60000);

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
      if (account.kind === 'codex') void this.server(account, cliPath, o.cwd, o.browser);
      else this.ensureSpare(account, cliPath, o.cwd, 'write', o.autonomy, o.browser);
    }
  }

  dispose(): void {
    clearInterval(this.sweep);
    for (const p of this.streams) this.kill(p.child);
    for (const s of this.servers.values()) this.kill(s.child);
    this.streams = [];
    this.servers.clear();
  }

  // ---------------------------------------------------------------- turns (shared)

  private open(req: RunRequest, resolve: (r: RunResult) => void, stop: (t: TurnCtx) => void): TurnCtx {
    fs.mkdirSync(path.dirname(req.logFile), { recursive: true });
    const t: TurnCtx = { req, log: fs.createWriteStream(req.logFile, { flags: 'a' }), raw: '', final: '', cancelled: false, timedOut: false, resolve, timer: undefined as never };
    this.emit(t, `$ ${req.account.kind} (${req.account.label}) in ${req.cwd} · hot\n\n`);
    t.timer = setTimeout(() => {
      t.timedOut = true;
      this.emit(t, `\n[super-agent] timed out after ${Math.round(req.timeoutMs / 60000)} min, stopping.\n`);
      stop(t);
    }, req.timeoutMs);
    this.byRun.set(req.runId, () => {
      t.cancelled = true;
      stop(t);
    });
    return t;
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
    t.resolve({ code, finalText, rateLimited, authFailed, authReason, cancelled: t.cancelled, timedOut: t.timedOut, sessionId: t.sessionId });
  }

  private kill(child: ChildProcess): void {
    if (child.pid && child.exitCode === null) killTree(child.pid);
  }

  // ---------------------------------------------------------------- Claude Code / Antigravity (stream-json)

  private runStream(req: RunRequest): Promise<RunResult> {
    const key = sig(req.mode, req.autonomy, req.account, !!req.browser);
    const fits = (p: StreamProc) => !p.dead && !p.turn && p.account.id === req.account.id && p.cwd === req.cwd && p.key === key;
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
      const message = { role: 'user', content: req.prompt };
      const line = req.account.kind === 'claude' ? { type: 'user', message } : { event: 'user', message };
      proc.child.stdin?.write(JSON.stringify(line) + '\n');
    });
  }

  private ensureSpare(account: Account, cliPath: string, cwd: string, mode: RunMode, autonomy: Autonomy, browser: boolean): void {
    const key = sig(mode, autonomy, account, browser);
    if (this.streams.some((p) => !p.dead && p.spare && p.account.id === account.id && p.cwd === cwd && p.key === key)) return;
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
      ? { outputDir: path.join(cwd, '.super-agent', 'screenshots'), configFile: path.join(this.dataDir, 'hot', `${account.id}.mcp.json`) }
      : undefined;
    if (b && claude) {
      fs.mkdirSync(path.dirname(b.configFile), { recursive: true });
      writeBrowserConfig(b.configFile, b.outputDir);
    }
    const args = buildArgs({ kind: account.kind, mode, autonomy, cwd, model: account.model, effort: account.effort, lastMessageFile: '', resume, newSessionId, browser: b });
    const child = claude
      ? spawn(commandLine(cliPath, ['--input-format', 'stream-json', ...args]), { cwd, env: accountEnv(account), shell: true, windowsHide: true })
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
    const t = p.turn;
    if (!t) return;
    t.sessionId ??= p.sessionId;
    const r = p.account.kind === 'claude' ? renderClaudeEvent(line) : renderAgyEvent(line);
    this.emit(t, r.text);
    if (r.final === undefined) return; // not the end of the turn yet
    t.final = r.final;
    p.turn = undefined;
    p.lastUsed = Date.now();
    this.finish(t, r.final ? 0 : 1);
    this.trimIdle(p.account.id);
  }

  /** Keeps the most recently used idle conversations per account; closes the rest. */
  private trimIdle(accountId: string): void {
    const idle = this.streams.filter((p) => p.account.id === accountId && !p.spare && !p.turn).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const p of idle.slice(MAX_IDLE_SESSIONS)) this.kill(p.child);
  }

  private closeIdle(): void {
    for (const p of this.streams) if (!p.spare && !p.turn && Date.now() - p.lastUsed > IDLE_MS) this.kill(p.child);
  }

  // ---------------------------------------------------------------- Codex (app-server)

  private server(account: Account, cliPath: string, cwd: string, browser: boolean): CodexServer {
    const key = `${account.id}|${cwd}|${browser}`;
    const existing = this.servers.get(key);
    if (existing && !existing.dead) return existing;
    // The model is chosen per thread (thread/start), so one server serves any model the account switches to.
    const extra = browser ? codexBrowser(path.join(cwd, '.super-agent', 'screenshots')) : [];
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
          // Approvals etc.: nobody can answer in a headless run.
          child.stdin?.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Not supported by Super Agent' } }) + '\n');
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
    const opts = {
      cwd: req.cwd,
      approvalPolicy: 'never',
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
      void this.call(s, 'turn/start', { threadId: tid, effort: req.account.effort ?? null, input: [{ type: 'text', text: req.prompt, text_elements: [] }] }).then((r) => {
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

  /** Codex events → the same readable lines the one-shot runs log (the panel's activity view parses them). */
  private onCodexNote(s: CodexServer, m: any): void {
    const p = m.params ?? {};
    const t = s.turns.get(p.threadId);
    if (!t) return;
    const item = p.item ?? {};
    switch (m.method) {
      case 'item/started':
        if (item.type === 'reasoning') this.emit(t, '\nthinking\n');
        else if (item.type === 'agentMessage') this.emit(t, '\ncodex\n');
        else if (item.type === 'commandExecution') this.emit(t, `\n→ run command ${unwrap(String(item.command ?? ''))}\n`);
        else if (item.type === 'fileChange') this.emit(t, `\n→ edit files ${(item.changes ?? []).map((c: any) => c.path).join(', ')}\n`);
        else if (item.type === 'mcpToolCall') this.emit(t, `\n→ ${item.server} ${item.tool ?? ''}\n`);
        else if (item.type === 'webSearch') this.emit(t, `\n→ web search ${item.query ?? ''}\n`);
        return;
      case 'item/agentMessage/delta':
        return this.emit(t, String(p.delta ?? ''));
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
  return (m ? m[1] : cmd).replace(/^['"](.*)['"]$/s, '$1').replace(/\s+/g, ' ').slice(0, 200);
}
