import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Account, AccountStatus, AccountUsage } from '../core/types';
import { AgentLogo, TelegramLogo } from './components/Logos';
import { Markdown } from './components/Markdown';
import type { Thread } from '../engine/types';
import { TelegramCard, type TelegramView } from './telegram';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const send = (m: unknown) => vscode.postMessage(m);

interface State {
  accounts: Account[];
  status: Record<string, AccountStatus>;
  usage: Record<string, AccountUsage>;
  threads: Thread[];
  workspace: string | null;
  soundOnDone: boolean;
  browserTools: boolean;
  fileUris: Record<string, string>;
  telegram: TelegramView;
  models: Record<string, { id: string; name: string; isDefault: boolean }>;
}

// ---------------------------------------------------------------- chime (no audio files)

let audio: AudioContext | null = null;
// Chromium starts audio created without a user gesture "suspended" (silent), and chimes come from agents, not clicks:
// unlock it on the first click or key press in the panel.
const unlockAudio = () => {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    /* audio unavailable */
  }
};
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });

function chime(kind: 'done' | 'task' | 'failed'): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const tones = kind === 'done' ? [660, 880, 1320] : kind === 'task' ? [880, 1175] : [523, 392];
    const t0 = audio.currentTime + 0.02;
    tones.forEach((f, i) => {
      const o = audio!.createOscillator();
      const g = audio!.createGain();
      o.frequency.value = f;
      const s = t0 + i * 0.13;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.25, s + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.35);
      o.connect(g).connect(audio!.destination);
      o.start(s);
      o.stop(s + 0.4);
    });
  } catch {
    /* audio unavailable */
  }
}

const AGENT_TYPES: { kind: Account['kind']; name: string; maker: string }[] = [
  { kind: 'codex', name: 'Codex', maker: 'OpenAI' },
  { kind: 'claude', name: 'Claude Code', maker: 'Anthropic' },
  { kind: 'antigravity', name: 'Antigravity', maker: 'Google' },
];

function resetsIn(ts?: number): string {
  if (!ts) return '';
  const m = Math.max(0, Math.round((ts - Date.now()) / 60000));
  if (m < 60) return `resets in ${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `resets in ${h}h ${m % 60}m` : `resets in ${Math.round(h / 24)}d`;
}

// ---------------------------------------------------------------- app

function App() {
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<string | null>(vscode.getState()?.selected ?? null);
  const [draft, setDraft] = useState('');
  /** Recent clean activity lines per thread (from the extension's parser). */
  const [steps, setSteps] = useState<Record<string, { items: string[]; startedAt?: number }>>({});
  // Live timers ("Working for 1m 5s") tick once a second while anything runs.
  const [, tick] = useState(0);
  const anyRunning = !!state?.threads.some((t) => t.status !== 'idle');
  useEffect(() => {
    if (!anyRunning) return;
    const h = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(h);
  }, [anyRunning]);
  const [showUsage, setShowUsage] = useState(false);
  const [showTelegram, setShowTelegram] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  // Thumbnail URLs for files attached in the box (sent ones come with the state).
  const [pending, setPending] = useState<Record<string, string>>({});
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'state') setState(m.state);
      else if (m.type === 'activity') setSteps((s) => ({ ...s, [m.threadId]: { items: m.items, startedAt: m.startedAt } }));
      else if (m.type === 'chime') chime(m.kind);
      else if (m.type === 'selected') setSelected(m.threadId);
      else if (m.type === 'newThread') setSelected(null);
      else if (m.type === 'showTelegram') setShowTelegram(true);
      else if (m.type === 'attached') {
        setAttachments((a) => [...a, ...m.files.filter((f: string) => !a.includes(f))]);
        setPending((u) => ({ ...u, ...m.uris }));
      }
    };
    window.addEventListener('message', on);
    // Ask for the current state only once we're listening (messages sent earlier are lost).
    send({ type: 'ready' });
    return () => window.removeEventListener('message', on);
  }, []);
  // Braces matter: whatever an effect returns, React later calls as its cleanup.
  useEffect(() => {
    vscode.setState({ selected });
  }, [selected]);

  const thread = state?.threads.find((t) => t.id === selected);
  // Follow new output only while you're at the bottom; scrolled up to read, the view stays put.
  const feedPinned = useRef(true);
  useEffect(() => {
    if (feed.current && feedPinned.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [thread?.messages.length, thread?.status, steps[selected ?? '']?.items.length]);
  // A thread you open starts at its latest message.
  useEffect(() => {
    feedPinned.current = true;
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [selected]);
  // The box grows with the draft, like a chat input.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  if (!state) return <div className="empty">Loading…</div>;
  const uris = { ...state.fileUris, ...pending };
  const tg = state.telegram?.state ?? 'off';
  const acc = (id?: string) => state.accounts.find((a) => a.id === id);
  const modelName = (id?: string) => (acc(id) ? (state.models?.[id!]?.name ?? KIND_SHORT[acc(id)!.kind]) : 'Agent');
  const team = state.accounts.filter((a) => a.role !== 'off');
  const working = thread?.status === 'working' || thread?.status === 'waiting';
  const helpers = thread ? state.threads.filter((t) => t.parentId === thread.id) : [];
  /** Anything still running in this thread or the helpers under it. */
  const inFlight = (t: Thread): boolean => t.status !== 'idle' || state.threads.some((x) => x.parentId === t.id && inFlight(x));
  // Helpers belong to the user turn they were started in. A finished turn's helpers are drawn right after the answer
  // that wrapped them up; the live graph at the bottom shows only the current turn's work (and anything still running).
  const msgs = thread?.messages ?? [];
  const turnOf = (at: number) => msgs.reduce((n, m, i) => (m.role === 'user' && m.at <= at ? i : n), -1);
  const placed = new Map<number, Thread[]>(); // message index → finished helpers shown after it
  const turns = new Map<number, Thread[]>();
  for (const h of helpers) turns.set(turnOf(h.createdAt), [...(turns.get(turnOf(h.createdAt)) ?? []), h]);
  for (const group of turns.values()) {
    if (group.some(inFlight)) continue;
    const doneAt = Math.max(...group.map((h) => h.updatedAt));
    const at = msgs.findIndex((m) => m.role === 'agent' && m.at >= doneAt);
    if (at >= 0) placed.set(at, [...(placed.get(at) ?? []), ...group]);
  }
  const isPlaced = (h: Thread) => [...placed.values()].some((g) => g.includes(h));
  const liveKids = helpers.filter((h) => !isPlaced(h));
  // This turn's activity: the live list for this turn if we have it, else what the engine saved so far.
  const live = thread ? steps[thread.id] : undefined;
  const liveItems = thread?.work ? (live && live.startedAt === thread.work.startedAt ? live.items : thread.work.items) : [];
  /** The threads above this one (root first), for the back bar on helper threads. */
  const parents: Thread[] = [];
  for (let p = state.threads.find((x) => x.id === thread?.parentId); p && !parents.includes(p); p = state.threads.find((x) => x.id === p!.parentId)) parents.unshift(p);

  /** One agent in the work graph: what it is doing now, then the helpers it brought in, nested the same way. */
  const graphNode = (t: Thread, depth: number, only?: Thread[]): ReactNode => {
    const kids = (only ?? state.threads.filter((x) => x.parentId === t.id)).slice().reverse(); // oldest first
    const a = acc(t.leadId);
    const recent = (steps[t.id]?.items ?? []).slice(-4);
    return (
      <div key={t.id} className="g-node">
        <div className={`g-head ${depth ? 'link' : ''}`} onClick={depth ? () => setSelected(t.id) : undefined} title={depth ? 'Open this helper thread' : undefined}>
          {depth > 0 && <span className="g-arrow">↳</span>}
          {a ? <Logo kind={a.kind} /> : <span className="g-none" />}
          <b>{t.leadId ? modelName(t.leadId) : 'Next free agent'}</b>
          {depth > 0 && <span className="muted g-title">{t.title}</span>}
          <span className="spacer" />
          {t.status === 'working' ? (
            <span className="shimmer g-state">working</span>
          ) : t.status === 'waiting' ? (
            <span className="g-state wait">{t.awaitingHelpers ? 'waiting for helpers' : t.helperFile ? 'queued' : 'waiting for a free agent'}</span>
          ) : (
            <span className="g-state done">✓ done</span>
          )}
        </div>
        {t.status === 'working' && depth > 0 && (
          <div className="g-steps">
            {recent.length ? recent.map((s, i) => <Step key={i} text={s} live={i === recent.length - 1} />) : <div className="g-step now"><i>Thinking…</i></div>}
          </div>
        )}
        {kids.length > 0 && <div className="g-kids">{kids.map((k) => graphNode(k, depth + 1))}</div>}
      </div>
    );
  };

  /** now: straight to the working agent · queue: its next turn, after the current one. */
  const submit = (mode: 'now' | 'queue' = 'now') => {
    const text = draft.trim();
    if (!text && !attachments.length) return;
    send({ type: 'send', threadId: thread?.id, text, attachments, mode });
    setDraft('');
    setAttachments([]);
  };
  const canSend = !!draft.trim() || attachments.length > 0;
  // Pasted images (screenshots etc.) become attachments.
  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const r = new FileReader();
      r.onload = () => send({ type: 'pasteFile', name: f.name && f.name !== 'image.png' ? f.name : `pasted-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, data: r.result });
      r.readAsDataURL(f);
    }
  };

  return (
    <div className="app">
      <section className="team">
        {state.accounts.map((a) => (
          <Member key={a.id} a={a} model={state.models?.[a.id]} st={state.status[a.id]} u={state.usage[a.id]} />
        ))}
        <button className="chip add" title="Add an agent account" onClick={() => send({ type: 'addAccount' })}>
          +
        </button>
      </section>

      <section
        className="feed"
        ref={feed}
        onScroll={(e) => {
          const el = e.currentTarget;
          feedPinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {parents.length > 0 && (
          <nav className="crumbs">
            <button className="back" title="Back to the thread this one helps" onClick={() => setSelected(parents.at(-1)!.id)}>
              ←
            </button>
            {parents.map((p) => (
              <span key={p.id} className="crumb">
                <a onClick={() => setSelected(p.id)}>{p.title}</a>
                <span className="sep">›</span>
              </span>
            ))}
            <span className="crumb here">{thread!.title}</span>
          </nav>
        )}
        {!thread && (
          <div className="hero">
            <h1>Agents that work in harmony</h1>
            <p className="muted hint">
              Add as many accounts as you like. They work together as one team: one leads, teammates take on independent pieces, and when one runs out of usage another carries on with the same context.
            </p>
            <div className="hero-agents">
              {AGENT_TYPES.map(({ kind, name, maker }) => (
                <button key={kind} className="hero-card" title={`Add a ${name} account`} onClick={() => send({ type: 'addAccount', kind })}>
                  <span className={`logo ${kind}`}>
                    <AgentLogo kind={kind} size={28} />
                  </span>
                  <b>{name}</b>
                  <span className="muted">{maker}</span>
                  <span className="hero-add">+ Add</span>
                </button>
              ))}
            </div>
            <button className="hero-tg" onClick={() => setShowTelegram(true)}>
              <TelegramLogo size={36} />
              <span className="hero-tg-text">
                <b>Your workstation, from your phone</b>
                <span className="muted">Connect Telegram to message your agents and follow their work from anywhere.</span>
              </span>
              <span className="hero-add">{tg === 'on' || tg === 'standby' ? 'Connected ✓' : 'Connect'}</span>
            </button>
            <div className="muted ws">{state.workspace ? `Working in ${state.workspace.split(/[\\/]/).pop()}` : 'No folder open'}</div>
            {!state.workspace && <div className="warn">Open a folder first: agents work in the open workspace folder.</div>}
          </div>
        )}
        {thread?.messages.map((m, i) => [
          // A finished turn's work graph sits just above the answer that wrapped it up (it happened first).
          // Codex-style: what led to this answer, collapsed into "Worked for …" above it.
          m.workedMs !== undefined && <WorkedFor key="worked" ms={m.workedMs} items={m.activity ?? []} />,
          placed.has(i) && (
            <div key="graph" className="graph">
              {graphNode(thread, 0, placed.get(i))}
            </div>
          ),
          m.role === 'user' ? (
            <div key={i} className="mine">
              {m.attachments?.some(isImage) && (
                <div className="thumbs">
                  {m.attachments.filter(isImage).map((f) => (
                    <Thumb key={f} file={f} uri={uris[f]} />
                  ))}
                </div>
              )}
              {(m.text || m.attachments?.some((f) => !isImage(f))) && (
                <div className="msg me">
                  {m.text}
                  {m.attachments?.some((f) => !isImage(f)) && (
                    <div className="files">
                      {m.attachments
                        .filter((f) => !isImage(f))
                        .map((f) => (
                          <span key={f} className="file link" title={`Open ${f}`} onClick={() => send({ type: 'openFile', path: f })}>
                            📄 {baseName(f)}
                          </span>
                        ))}
                    </div>
                  )}
                </div>
              )}
              <div className="stamp">{when(m.at)}</div>
            </div>
          ) : m.role === 'system' ? (
            <div key={i} className="msg sys">
              {m.text}
            </div>
          ) : (
            <div key={i} className="msg agent">
              <div className="who">
                {acc(m.accountId) && <Logo kind={acc(m.accountId)!.kind} />}
                <span>{modelName(m.accountId)}</span>
              </div>
              <Markdown text={m.text} />
              <div className="stamp">{when(m.at)}</div>
            </div>
          ),
        ])}
        {thread && inFlight(thread) && (
          <div className="work">
            <div className="work-head shimmer">
              {thread.awaitingHelpers ? 'Waiting for helpers' : 'Working'}
              {thread.work ? ` for ${duration(Date.now() - thread.work.startedAt)}` : ''}
            </div>
            <Timeline items={liveItems} live={thread.status === 'working'} />
          </div>
        )}
        {thread && liveKids.length > 0 && <div className="graph">{liveKids.slice().reverse().map((k) => graphNode(k, 1))}</div>}
      </section>

      <section className="composer">
        {showTelegram && <TelegramCard t={state.telegram ?? { state: 'off' }} send={send} onClose={() => setShowTelegram(false)} />}
        {showUsage && (
          <div className="usage-panel">
            <div className="usage-head">
              <b>Usage</b>
              <span className="spacer" />
              <button className="x" title="Close" onClick={() => setShowUsage(false)}>
                ×
              </button>
            </div>
            <div className="usage-grid">
            {team.map((a) => (
              <div key={a.id} className="usage-item">
                <div className="row">
                  <Logo kind={a.kind} />
                  <b>{modelName(a.id)}</b>
                </div>
                {(state.usage[a.id]?.windows ?? []).map((w) => (
                  <div key={w.label} className="u-row">
                    <span>{w.label}</span>
                    <span className="u-bar">
                      <i className={w.label.startsWith('week') ? 'week' : 'short'} style={{ width: `${Math.max(2, 100 - w.percent)}%` }} />
                    </span>
                    <span>{Math.round(100 - w.percent)}% left</span>
                    <span className="muted u-reset">{resetsIn(w.resetsAt)}</span>
                  </div>
                ))}
                {!state.usage[a.id]?.windows.length && <div className="muted">{state.usage[a.id]?.note ?? 'No limit data'}</div>}
              </div>
            ))}
            </div>
          </div>
        )}
        <div className="box" onClick={() => input.current?.focus()}>
          {attachments.length > 0 && (
            <div className="files">
              {attachments.map((f) => (
                <span key={f} className={`file ${isImage(f) && uris[f] ? 'pic' : ''}`} title={f}>
                  {isImage(f) && uris[f] ? <img src={uris[f]} alt="" /> : '📄'} {baseName(f)}
                  <button
                    title="Remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAttachments((a) => a.filter((x) => x !== f));
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            onPaste={onPaste}
            ref={input}
            value={draft}
            rows={1}
            placeholder={!thread ? 'Ask the team to do anything' : working ? 'Message the lead while it works (Enter: now · Alt+Enter: queue)' : 'Ask for follow-up changes'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(e.altKey && working ? 'queue' : 'now');
              }
            }}
          />
          <div className="toolbar">
            <button className="tool" title="Attach files (or paste an image)" onClick={() => send({ type: 'attach' })}>
              +
            </button>
            <span className="spacer" />
            <a className={`opt ${showUsage ? 'on' : ''}`} onClick={() => setShowUsage((v) => !v)}>
              Usage
            </a>
            <a
              className={`opt ${state.browserTools ? 'on' : ''}`}
              title={state.browserTools ? 'Agents have a browser: they can open pages, click, fill forms and take screenshots. Click to turn off.' : 'Browser tools are off. Click to give agents a browser.'}
              onClick={() => send({ type: 'toggleBrowser' })}
            >
              {state.browserTools ? 'Browser on' : 'Browser off'}
            </a>
            <a
              className={`opt ${showTelegram || tg === 'on' || tg === 'standby' ? 'on' : ''}`}
              title={TELEGRAM_TIP[tg]}
              onClick={() => setShowTelegram((v) => !v)}
            >
              {tg === 'on' || tg === 'standby' ? 'Telegram ✓' : tg === 'error' ? 'Telegram ⚠' : 'Telegram'}
            </a>
            <a className="opt" title="Chime when agents finish" onClick={() => send({ type: 'toggleSound' })}>
              {state.soundOnDone ? '🔔' : '🔕'}
            </a>
            {working && !draft.trim() ? (
              <button className="send stop" title="Stop" onClick={() => send({ type: 'stop', threadId: thread!.id })}>
                <span className="square" />
              </button>
            ) : (
              <>
                {working && (
                  <button className="queue-btn" title="Queue: runs after the current step (Alt+Enter)" disabled={!canSend} onClick={() => submit('queue')}>
                    Queue
                  </button>
                )}
                <button className="send" title={working ? 'Send now: the agent takes it right away (Enter)' : 'Send (Enter)'} disabled={!canSend} onClick={() => submit()}>
                  ↑
                </button>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Member({ a, model, st, u }: { a: Account; model?: { id: string; name: string; isDefault: boolean }; st?: AccountStatus; u?: AccountUsage }) {
  const name = `${model?.name ?? KIND_SHORT[a.kind]}${a.effort ? ` · ${a.effort}` : ''}`;
  const busy = (st?.busyRuns ?? 0) > 0;
  const out = st?.login === 'signed-out' || (st?.cooldownUntil ?? 0) > Date.now();
  const windows = useMemo(() => [...(u?.windows ?? [])].sort((x, y) => (x.label.startsWith('week') ? 1 : 0) - (y.label.startsWith('week') ? 1 : 0)), [u]);
  // Account labels are "Claude · name"; the first line already names the agent, so show just the account.
  const account = a.label.replace(/^[^·]+·\s*/, '');
  const tip = `${KIND_SHORT[a.kind]} · ${name}${model?.isDefault ? ' (CLI default)' : ''}\nAccount: ${account}${st?.email ? ` (${st.email})` : ''}\n${a.role === 'off' ? 'Off the team' : a.role === 'master' ? 'Preferred lead' : 'On the team'}${busy ? ' · working' : ''}${out ? ` · ${st?.lastError ?? 'unavailable'}` : ''}\n${windows.map((w) => `${w.label}: ${Math.round(100 - w.percent)}% left`).join('\n')}\nClick: ${a.role === 'off' ? 'add to' : 'remove from'} team`;
  return (
    <span className={`chip ${a.role} ${busy ? 'busy' : ''} ${out ? 'out' : ''}`}>
      <button className="main" title={tip} onClick={() => send({ type: 'toggleTeam', id: a.id })}>
        <Logo kind={a.kind} />
        <span className="name">
          {name}
          <span className="meters">
            {windows.map((w) => (
              <span key={w.label} className="meter">
                <i className={w.label.startsWith('week') ? 'week' : 'short'} style={{ width: `${Math.max(3, 100 - w.percent)}%` }} />
              </span>
            ))}
          </span>
        </span>
      </button>
      <button className="act" title="Choose model and reasoning effort" onClick={() => send({ type: 'pickModel', id: a.id })}>
        ▾
      </button>
      <button className={`act crown ${a.role === 'master' ? 'on' : ''}`} title={a.role === 'master' ? 'Lead' : 'Make lead'} onClick={() => send({ type: 'setMaster', id: a.id })}>
        ♛
      </button>
      {out && (
        <button className="act" title="Sign in" onClick={() => send({ type: 'signIn', id: a.id })}>
          ⟳
        </button>
      )}
    </span>
  );
}

// Agent (CLI) names, so the hover says which agent runs the model: "Claude Code", not the model family "Claude".
const KIND_SHORT: Record<Account['kind'], string> = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' };
function Logo({ kind }: { kind: Account['kind'] }) {
  return (
    <span className={`logo ${kind}`}>
      <AgentLogo kind={kind} size={16} />
    </span>
  );
}

const TELEGRAM_TIP: Record<TelegramView['state'], string> = {
  off: 'Use the team from your phone through a Telegram bot.',
  pairing: 'Scan the QR code to pair your phone.',
  on: 'Telegram relay is on: messages to your bot reach the team, and replies come back.',
  standby: 'Telegram relay is on (answered by another VS Code window).',
  error: 'Telegram rejected the bot token. Click to connect again.',
};

const baseName = (f: string) => f.split(/[\\/]/).pop() ?? f;
const isImage = (f: string) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f);

/** An attached image above the message; click opens it full size in VS Code. */
function Thumb({ file, uri }: { file: string; uri?: string }) {
  const open = () => send({ type: 'openFile', path: file });
  return uri ? (
    <img className="thumb" src={uri} alt={baseName(file)} title={`${baseName(file)} (click to open)`} onClick={open} />
  ) : (
    <span className="file link" title={`Open ${file}`} onClick={open}>
      🖼 {baseName(file)}
    </span>
  );
}

/** Codex-style activity: what the agent said, in full, and its steps as compact lines. */
function Timeline({ items, live }: { items: string[]; live?: boolean }) {
  // Its own scroll box: follows new output, unless you scrolled up to read.
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    if (box.current && pinned.current) box.current.scrollTop = box.current.scrollHeight;
  }, [items.length, items.at(-1)?.length]);
  // Like Codex, "Thinking…" only shows while it's happening (the last item), not after every step.
  items = items.filter((s, i) => !s.startsWith('💭') || i === items.length - 1);
  if (!items.length) return <div className="g-step now"><i>Thinking…</i></div>;
  return (
    <div
      className="timeline"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {items.map((s, i) =>
        s.startsWith('💬') ? (
          <div key={i} className="tl-say">
            <Markdown text={s.slice(2).trim()} />
          </div>
        ) : (
          <Step key={i} text={s} live={!!live && i === items.length - 1} />
        ),
      )}
    </div>
  );
}

/** A finished turn's activity, collapsed above its answer like Codex's "Worked for 2m 13s". */
function WorkedFor({ ms, items }: { ms: number; items: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="worked">
      <button className="worked-head" disabled={!items.length} onClick={() => setOpen((o) => !o)}>
        Worked for {duration(ms)}
        {items.length > 0 && <span className="caret">{open ? '▾' : '›'}</span>}
      </button>
      {open && <Timeline items={items} />}
    </div>
  );
}

/** "today 4:05 PM", or the date for older messages (shown under a message on hover). */
function when(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `today ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One activity line, Codex-style: a short verb and what it acted on, narration as plain text. */
function Step({ text, live }: { text: string; live: boolean }) {
  const m = /^(💭|🔧|▶|✏️|🔎|💬)\s*(.*)$/u.exec(text);
  const [icon, rest] = m ? [m[1], m[2]] : ['💬', text];
  const tool = /^(\S+(?: files| file| command)?)\s*(.*)$/.exec(rest); // "read file C:\x" → "read file" + "C:\x"
  const body =
    icon === '💭' ? <i>Thinking…</i>
    : icon === '✏️' ? <><b>Edited</b> files</>
    : icon === '▶' ? <><b>Ran</b> <code>{rest}</code></>
    : icon === '🔎' ? <><b>Searched</b> {rest}</>
    : icon === '🔧' && tool ? <><b>{cap(tool[1].replace(/_/g, ' '))}</b> <span className="g-arg">{short(tool[2])}</span></>
    : <span className="g-say">{rest}</span>;
  // Narration wraps in full; commands and paths stay on one line.
  const say = !['💭', '✏️', '▶', '🔎', '🔧'].includes(icon) || (icon === '🔧' && !tool);
  return <div className={`g-step ${live ? 'now' : ''} ${say ? 'say' : ''}`}>{body}</div>;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Paths shown by their last two parts; anything else as is. */
const short = (s: string) => (/^([a-zA-Z]:)?[\\/]/.test(s) ? s.split(/[\\/]/).slice(-2).join('/') : s);

// Any crash is reported to the extension (logged to ~/.super-agent/vscode-errors.log) and shown instead of a blank panel.
const report = (message: string, stack?: string) => send({ type: 'clientError', message, stack });
window.addEventListener('error', (e) => report(String(e.message), e.error?.stack));
window.addEventListener('unhandledrejection', (e) => report(String(e.reason?.message ?? e.reason), e.reason?.stack));

class Guard extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    report(error.message, `${error.stack ?? ''}\n${info.componentStack ?? ''}`);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty">
        <b>The Super Agent panel hit an error.</b>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre>
        <button onClick={() => this.setState({ error: null })}>Reload panel</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <Guard>
    <App />
  </Guard>,
);
