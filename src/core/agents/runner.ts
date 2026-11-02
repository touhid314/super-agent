import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Account, Autonomy } from '../types';
import { accountEnv, buildArgs, commandLine, writeBrowserConfig, type RunMode } from './cli';

export interface RunRequest {
  runId: string;
  account: Account;
  cliPath: string;
  mode: RunMode;
  autonomy: Autonomy;
  cwd: string;
  prompt: string;
  logFile: string;
  timeoutMs: number;
  onText: (text: string) => void;
  /** Continue an earlier CLI session instead of starting fresh (keeps the agent's full context). */
  resume?: string;
  /** Give the agent a browser; its screenshots go to <cwd>/.super-agent/screenshots. */
  browser?: boolean;
  /**
   * Don't send a prompt: take over the turn the agent (session `resume`) started by itself, e.g. when one of its
   * background tasks woke it up after its last reply (hot agents only).
   */
  attach?: boolean;
}

export interface RunResult {
  code: number | null;
  finalText: string;
  rateLimited: boolean;
  /** The CLI session this run used/created, for resuming later. */
  sessionId?: string;
  /** The CLI could not authenticate (not logged in / expired login / account not eligible). */
  authFailed?: boolean;
  /** The provider's own explanation, when it gave one. */
  authReason?: string;
  /** For a failed run: the CLI's own error message, when it printed one. */
  error?: string;
  cancelled: boolean;
  timedOut: boolean;
}

/** The account can't be used right now (logged out, expired, or no longer eligible for this CLI). */
export const AUTH_FAILED =
  /please (run )?\/?login|not logged in|log ?in required|authentication (failed|cancelled|required)|set an auth method|invalid api key|invalid_grant|token (has )?expired|unauthorized|\b401\b|IneligibleTier|no longer supported|not eligible|account (is )?(disabled|suspended)/i;
/** Out of usage, in any provider's wording ("You've hit your 5-hour limit", "weekly limit reached", "out of credits", …). */
export const RATE_LIMIT =
  /rate.?limit|usage limit|quota (exceeded|exhausted)|too many requests|\b429\b|hit your [\w\s-]{0,24}limit|(5-hour|five.hour|daily|weekly|monthly|session) limit (reached|exceeded|hit)|limit (reached|exceeded)[^\n]{0,40}reset|out of (usage|credits)|resource.?exhausted/i;
// eslint-disable-next-line no-control-regex
export const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

const active = new Map<string, { child: ChildProcess; cancelled: boolean }>();

export function cancelRun(runId: string): void {
  const a = active.get(runId);
  if (!a?.child.pid) return;
  a.cancelled = true;
  killTree(a.child.pid);
}

export function cancelAll(): void {
  for (const id of active.keys()) cancelRun(id);
}

export function killTree(pid: number): void {
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
}

/** Run one headless agent turn. The prompt goes in on stdin; output is streamed, logged and returned. */
export function runAgent(req: RunRequest): Promise<RunResult> {
  fs.mkdirSync(path.dirname(req.logFile), { recursive: true });
  const log = fs.createWriteStream(req.logFile, { flags: 'a' });
  const lastMessageFile = req.logFile.replace(/\.log$/, '.final.txt');
  const newSessionId = randomUUID();
  const browser = req.browser ? { outputDir: path.join(req.cwd, '.super-agent', 'screenshots'), configFile: req.logFile.replace(/\.log$/, '.mcp.json') } : undefined;
  if (browser && req.account.kind === 'claude') writeBrowserConfig(browser.configFile, browser.outputDir);
  const args = buildArgs({
    browser,
    kind: req.account.kind,
    mode: req.mode,
    autonomy: req.autonomy,
    cwd: req.cwd,
    model: req.account.model,
    effort: req.account.effort,
    lastMessageFile,
    resume: req.resume,
    newSessionId: req.account.kind === 'claude' && !req.resume ? newSessionId : undefined,
  });

  const emit = (text: string) => {
    if (!text) return;
    log.write(text);
    req.onText(text);
  };
  emit(`$ ${req.account.kind} (${req.account.label}) in ${req.cwd}\n\n`);

  // Antigravity (agy) ignores stdin, so its prompt is an argument; agy.exe is started directly (no shell,
  // ~32k argument limit). Rare longer prompts go into an ignored file in the workspace.
  const agy = req.account.kind === 'antigravity';
  const promptFile = path.join(req.cwd, '.sa-prompt.md');
  let agyPrompt = req.prompt;
  if (agy && req.prompt.length > 30000) {
    fs.writeFileSync(promptFile, req.prompt);
    agyPrompt = 'Read the file .sa-prompt.md in the current directory and follow its instructions exactly.';
  }

  return new Promise((resolve) => {
    const child = agy
      ? spawn(req.cliPath, [...args, '-p', agyPrompt], { cwd: req.cwd, env: accountEnv(req.account), windowsHide: true })
      : spawn(commandLine(req.cliPath, args), { cwd: req.cwd, env: accountEnv(req.account), shell: true, windowsHide: true });
    const entry = { child, cancelled: false };
    active.set(req.runId, entry);

    let raw = '';
    let claudeFinal = '';
    let stdoutText = '';
    let lineBuf = '';

    const onStdout = (buf: Buffer) => {
      const s = buf.toString('utf8').replace(ANSI, '');
      raw += s;
      if (req.account.kind !== 'claude' && !agy) {
        stdoutText += s;
        emit(s);
        return;
      }
      lineBuf += s;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';
      for (const line of lines) {
        const r = agy ? renderAgyEvent(line) : renderClaudeEvent(line);
        if (r.final !== undefined) claudeFinal = r.final;
        emit(r.text);
      }
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', (buf: Buffer) => {
      const s = buf.toString('utf8').replace(ANSI, '');
      raw += s;
      emit(s);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      emit(`\n[super-agent] timed out after ${Math.round(req.timeoutMs / 60000)} min, stopping.\n`);
      if (child.pid) killTree(child.pid);
    }, req.timeoutMs);

    child.on('error', (err) => emit(`\n[super-agent] failed to start: ${err.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      active.delete(req.runId);
      if (agy && fs.existsSync(promptFile)) fs.rmSync(promptFile, { force: true });
      if (lineBuf) {
        const r = agy ? renderAgyEvent(lineBuf) : renderClaudeEvent(lineBuf);
        if (r.final !== undefined) claudeFinal = r.final;
        emit(r.text);
      }
      let finalText = '';
      if (req.account.kind === 'codex') {
        try {
          finalText = fs.readFileSync(lastMessageFile, 'utf8');
        } catch {
          finalText = stdoutText;
        }
      } else if (req.account.kind === 'claude' || agy) {
        finalText = claudeFinal;
      } else {
        finalText = stdoutText;
      }
      finalText = finalText.trim();
      const failed = code !== 0 || !finalText;
      const tail = raw.slice(-6000);
      const rateLimited = failed && RATE_LIMIT.test(tail);
      const authFailed = failed && !rateLimited && !entry.cancelled && AUTH_FAILED.test(tail);
      const authReason = authFailed
        ? tail.split(/\r?\n/).reverse().find((l) => AUTH_FAILED.test(l) && !/^\s+at /.test(l))?.replace(/^.*?(Error:|error:)\s*/, '').trim().slice(0, 240)
        : undefined;
      emit(`\n[super-agent] exited with code ${code}${rateLimited ? ' (rate limited)' : authFailed ? ' (account unavailable)' : ''}\n`);
      log.end();
      const error = failed && !entry.cancelled ? errorOf(tail) : undefined;
      resolve({ code, finalText, rateLimited, authFailed, authReason, error, cancelled: entry.cancelled, timedOut, sessionId: sessionOf(req, raw, newSessionId) });
    });

    child.stdin?.on('error', () => undefined);
    child.stdin?.end(agy ? '' : req.prompt, 'utf8');
  });
}

/** The CLI's own error message in a failed run's output (the provider's `"message"` when it's an API error). */
export function errorOf(tail: string): string | undefined {
  const line = tail
    .split(/\r?\n/)
    .reverse()
    .find((l) => /error/i.test(l) && !/^\s+at /.test(l) && !l.startsWith('[super-agent]'));
  if (!line) return undefined;
  const msg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
  return (msg ? msg.replace(/\\"/g, '"') : line.replace(/^.*?(Error:|error:)\s*/, '')).trim().slice(0, 300) || undefined;
}

/** Turn one Antigravity (agy) stream-json line into readable console text. */
export function renderAgyEvent(line: string): { text: string; final?: string } {
  const trimmed = line.trim();
  if (!trimmed) return { text: '' };
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return { text: line + '\n' };
  }
  if (ev.event === 'step_update') {
    const s = ev.step_update ?? {};
    if (s.text_delta) return { text: String(s.text_delta) };
    if (s.state === 'ACTIVE' && s.step_type && !['user_input', 'agent_response'].includes(s.step_type)) {
      const what = s.tool_name ?? s.step_type;
      return { text: `\n→ ${String(what).replace(/_/g, ' ')} ${agyDetail(s)}\n` };
    }
    if (s.state === 'ERROR' && s.tool_info?.error?.message) return { text: `  ✗ ${String(s.tool_info.error.message).split('\n')[0].slice(0, 300)}\n` };
    return { text: '' };
  }
  if (ev.event === 'result') {
    const r = ev.result ?? {};
    const ok = r.status === 'SUCCESS';
    // Headless agy can't ask for permission: a denied action often ends the run with an empty answer.
    const denied = (r.denied_actions ?? []).map((d: any) => d.display_name ?? d.action).filter(Boolean);
    const note = denied.length ? `\n[antigravity] permission denied: ${denied.join(', ')}\n` : '';
    return { text: (ok ? '' : `\n[antigravity] ${r.status ?? 'error'}: ${r.error ?? r.response ?? ''}\n`) + note, final: ok ? String(r.response ?? '') : '' };
  }
  if (ev.event === 'error') return { text: `\n[antigravity] error: ${JSON.stringify(ev.error ?? ev).slice(0, 400)}\n` };
  return { text: '' };
}

/** Turn one Claude stream-json line into readable console text. */
export function renderClaudeEvent(line: string): { text: string; final?: string } {
  const trimmed = line.trim();
  if (!trimmed) return { text: '' };
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return { text: line + '\n' };
  }
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    const parts = ev.message.content.map((c: any) => {
      if (c.type === 'text') return c.text + '\n';
      if (c.type === 'tool_use') return `→ ${c.name} ${describeTool(c.input)}\n`;
      return '';
    });
    return { text: parts.join('') };
  }
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    const errs = ev.message.content.filter((c: any) => c.type === 'tool_result' && c.is_error);
    return { text: errs.map((c: any) => `  ✗ ${String(typeof c.content === 'string' ? c.content : 'tool error').slice(0, 300)}\n`).join('') };
  }
  if (ev.type === 'result') {
    const final = typeof ev.result === 'string' ? ev.result : '';
    const meta = ev.is_error ? `\n[claude] error: ${final || ev.subtype}\n` : '';
    return { text: meta, final: ev.is_error ? '' : final };
  }
  return { text: '' };
}

/** The file, command or query an Antigravity step acts on (its parameters use PascalCase names). */
function agyDetail(s: any): string {
  const p = s.tool_info?.parameters ?? {};
  const v =
    p.CommandLine ?? p.Path ?? p.AbsolutePath ?? p.TargetFile ?? p.FilePath ?? p.DirectoryPath ?? p.SearchPath ?? p.Query ?? p.Pattern ?? p.Url ??
    s.command ?? s.path ?? s.file_path ?? s.title ??
    // A tool we don't know yet: its first short text parameter.
    Object.values(p).find((x) => typeof x === 'string' && x.length < 300) ?? '';
  return oneLine(v);
}

/** The file, command or query a Claude Code tool call acts on: whole (the panel shows long ones on click). */
export function describeTool(input: any): string {
  if (!input || typeof input !== 'object') return '';
  return oneLine(input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? '');
}

/** A tool's target on one activity line, in full (only an absurdly long one is cut). */
const oneLine = (v: unknown) => String(v).replace(/\s+/g, ' ').slice(0, 6000);

/** Which CLI session a run used, so the next turn (or the next agent) can continue it. */
function sessionOf(req: RunRequest, raw: string, newSessionId: string): string | undefined {
  if (req.resume) return req.resume;
  if (req.account.kind === 'claude') return newSessionId;
  if (req.account.kind === 'codex') return /session id:\s*([0-9a-f-]{36})/i.exec(raw)?.[1];
  return /"conversation_id"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
}