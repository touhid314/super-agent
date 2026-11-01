import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Account, AccountStatus, AccountUsage } from '../../../super-agent/src/shared/types';
import { AgentLogo } from '../../../super-agent/src/renderer/src/components/Logos';
import { Markdown } from '../../../super-agent/src/renderer/src/components/Markdown';
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
function chime(kind: 'done' | 'task' | 'failed'): void {
  try {
    audio ??= new AudioContext();
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

// ---------------------------------------------------------------- app

function App() {
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<string | null>(vscode.getState()?.selected ?? null);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<Record<string, string>>({});
  const [showUsage, setShowUsage] = useState(false);
  const [showTelegram, setShowTelegram] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  // Thumbnail URLs for files attached in the box (sent ones come with the state).
  const [pending, setPending] = useState<Record<string, string>>({});
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'state') setState(m.state);
      else if (m.type === 'output') setLive((l) => ({ ...l, [m.threadId]: ((l[m.threadId] ?? '') + m.text).slice(-4000) }));
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
  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [thread?.messages.length, thread?.status, live[selected ?? '']]);
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

  const submit = () => {
    const text = draft.trim();
    if (!text && !attachments.length) return;
    send({ type: 'send', threadId: thread?.id, text, attachments });
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

      <section className="feed" ref={feed}>
        {!thread && (
          <div className="hero">
            <div className="hero-logos">
              {team.slice(0, 4).map((a) => (
                <Logo key={a.id} kind={a.kind} />
              ))}
            </div>
            <h1>Let's build</h1>
            <div className="muted">{state.workspace ? state.workspace.split(/[\\/]/).pop() : 'No folder open'}</div>
            <p className="muted hint">
              One agent leads and works right away, handing independent pieces to free teammates. If it runs out of usage, another continues with the same context.
            </p>
            {!state.workspace && <div className="warn">Open a folder first: agents work in the open workspace folder.</div>}
          </div>
        )}
        {thread?.messages.map((m, i) =>
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
            </div>
          ),
        )}
        {thread?.status === 'working' && (
          <div className="live">
            <button className="status" onClick={() => setShowActivity((v) => !v)} title="Show what the agent is doing">
              {acc(thread.leadId) && <Logo kind={acc(thread.leadId)!.kind} />}
              <span className="shimmer">{modelName(thread.leadId)} is working</span>
              <span className="caret">{showActivity ? '▾' : '▸'}</span>
            </button>
            {showActivity && (
              <div className="activity">
                <pre>{tail(live[thread.id])}</pre>
                <a onClick={() => send({ type: 'openLog', threadId: thread.id })}>Open full log</a>
              </div>
            )}
          </div>
        )}
        {helpers.length > 0 && (
          <div className="helpers">
            {helpers.map((t) => (
              <button key={t.id} className="tchip" onClick={() => setSelected(t.id)}>
                {acc(t.leadId) && <Logo kind={acc(t.leadId)!.kind} />}
                <span className={`dot ${t.status}`} />
                {t.title}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="composer">
        {showTelegram && <TelegramCard t={state.telegram ?? { state: 'off' }} send={send} onClose={() => setShowTelegram(false)} />}
        {showUsage && (
          <div className="usage-panel">
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
                  </div>
                ))}
                {!state.usage[a.id]?.windows.length && <div className="muted">{state.usage[a.id]?.note ?? 'No limit data'}</div>}
              </div>
            ))}
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
            placeholder={!thread ? 'Ask the team to do anything' : working ? 'Message the team (a free agent takes it if the lead is busy)' : 'Ask for follow-up changes'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
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
              <button className="send" title="Send (Enter)" disabled={!canSend} onClick={submit}>
                ↑
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Member({ a, model, st, u }: { a: Account; model?: { id: string; name: string; isDefault: boolean }; st?: AccountStatus; u?: AccountUsage }) {
  const name = model?.name ?? KIND_SHORT[a.kind];
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
      <button className="act" title="Choose model" onClick={() => send({ type: 'pickModel', id: a.id })}>
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

function tail(text?: string): string {
  if (!text) return 'starting…';
  return text
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('$ '))
    .slice(-12)
    .join('\n');
}

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
