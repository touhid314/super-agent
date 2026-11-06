import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Account, AccountStatus, AccountUsage } from '../core/types';
import { AgentLogo, TelegramLogo } from './components/Logos';
import { CopyButton, Markdown } from './components/Markdown';
import type { RunChanges, Thread } from '../engine/types';
import { TelegramCard, type TelegramView } from './telegram';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const send = (m: unknown) => vscode.postMessage(m);
const openLink = (url: string) => send({ type: 'openLink', url });

interface State {
  accounts: Account[];
  status: Record<string, AccountStatus>;
  usage: Record<string, AccountUsage>;
  threads: Thread[];
  workspace: string | null;
  soundOnDone: boolean;
  autonomy?: 'standard' | 'auto' | 'full';
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
  /** The one overlay open above the prompt box (opening another closes it; a click anywhere else closes it). */
  const [overlay, setOverlay] = useState<'usage' | 'telegram' | 'access' | null>(null);
  const toggleOverlay = (o: 'usage' | 'telegram' | 'access') => setOverlay((v) => (v === o ? null : o));
  const showUsage = overlay === 'usage';
  const showTelegram = overlay === 'telegram';
  useEffect(() => {
    if (!overlay) return;
    // Clicks inside the overlay, or on the buttons that open one (they toggle it themselves), don't close it.
    const away = (e: MouseEvent) => !(e.target as Element).closest?.('.overlay, [data-overlay]') && setOverlay(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOverlay(null);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [overlay]);
  const [refreshing, setRefreshing] = useState(false);
  /** The mic: idle, setting up (first use), recording (with loudness), or turning speech into text. */
  const [voice, setVoice] = useState<{ state: 'idle' | 'installing' | 'recording' | 'transcribing'; level?: number; startedAt?: number }>({ state: 'idle' });
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
      else if (m.type === 'usageRefreshed') setRefreshing(false);
      else if (m.type === 'voice') setVoice({ state: m.state, level: m.level, startedAt: m.startedAt });
      else if (m.type === 'voiceText' && m.text) {
        // What was said goes into the box (after anything typed), ready to edit or send.
        setDraft((d) => (d.trim() ? `${d.trimEnd()} ${m.text}` : m.text));
        input.current?.focus();
      }
      else if (m.type === 'selected') setSelected(m.threadId);
      else if (m.type === 'newThread') setSelected(null);
      else if (m.type === 'showTelegram') setOverlay('telegram');
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
    // The panel's own state doesn't survive a window reload: the extension remembers the open thread too.
    send({ type: 'selectedChanged', threadId: selected });
  }, [selected]);

  const thread = state?.threads.find((t) => t.id === selected);
  /** This workspace's latest conversations (helpers' threads are reached from their lead's). */
  const recent = useMemo(() => {
    const ws = state?.workspace?.toLowerCase();
    return (state?.threads ?? [])
      .filter((t) => !t.parentId && t.messages.length > 0 && (!ws || t.cwd.toLowerCase() === ws))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6);
  }, [state?.threads, state?.workspace]);
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
  // Only helpers still at work are shown: once one is done, its lead has its report and it's gone from view.
  const liveKids = helpers.filter(inFlight);
  // This turn's activity: the live list for this turn if we have it, else what the engine saved so far.
  const live = thread ? steps[thread.id] : undefined;
  const liveItems = thread?.work ? (live && live.startedAt === thread.work.startedAt ? live.items : thread.work.items) : [];
  // The lead's final answer while it streams (only when the CLI marks it as such, like Codex's final_answer phase):
  // it shows in the answer area, under the work box. Other agents' words stay in the work box until the turn ends.
  const speaking = thread?.status === 'working' && liveItems.at(-1)?.startsWith('🏁') ? liveItems.at(-1)!.slice(2).trim() : '';
  const workItems = speaking ? liveItems.slice(0, -1) : liveItems;
  /** The threads above this one (root first), for the back bar on helper threads. */
  const parents: Thread[] = [];
  for (let p = state.threads.find((x) => x.id === thread?.parentId); p && !parents.includes(p); p = state.threads.find((x) => x.id === p!.parentId)) parents.unshift(p);

  const isUnder = (x: Thread, rootId: string): boolean => {
    for (let p = state.threads.find((y) => y.id === x.parentId); p; p = state.threads.find((y) => y.id === p!.parentId)) if (p.id === rootId) return true;
    return false;
  };

  /** One agent in the work graph: what it is doing now, then the helpers it brought in, nested the same way. */
  const graphNode = (t: Thread, depth: number): ReactNode => {
    const kids = state.threads.filter((x) => x.parentId === t.id && inFlight(x)).slice().reverse(); // oldest first, still working
    const a = acc(t.leadId);
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
        {/* A helper is an agent too: its whole work, scrollable, like its lead's (only shorter). */}
        {t.status === 'working' && depth > 0 && (
          <div className="g-steps">
            <Timeline items={steps[t.id]?.items ?? []} live sub />
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
            {recent.length > 0 && (
              <div className="recent">
                <div className="recent-head">
                  <span>Recent conversations</span>
                  <a className="opt" onClick={() => send({ type: 'showHistory' })}>
                    All
                  </a>
                </div>
                {recent.map((t) => (
                  <button key={t.id} className="recent-row" onClick={() => setSelected(t.id)}>
                    <span className="recent-title">
                      {t.status !== 'idle' && <span className="dot" />}
                      {t.title}
                    </span>
                    <span className="muted">{when(t.updatedAt)}</span>
                  </button>
                ))}
              </div>
            )}
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
            <button className="hero-tg" data-overlay onClick={() => setOverlay("telegram")}>
              <TelegramLogo size={36} />
              <span className="hero-tg-text">
                <b>Your workstation, from your phone</b>
                <span className="muted">Connect Telegram to message your agents and follow their work from anywhere.</span>
              </span>
              <span className="hero-add">{tg === 'on' || tg === 'standby' ? 'Connected ✓' : tg === 'paused' ? 'Off' : 'Connect'}</span>
            </button>
            <div className="muted ws">{state.workspace ? `Working in ${state.workspace.split(/[\\/]/).pop()}` : 'No folder open'}</div>
            {!state.workspace && <div className="warn">Open a folder first: agents work in the open workspace folder.</div>}
          </div>
        )}
        {thread?.messages.map((m, i) => [
          // Codex-style: what led to this answer, collapsed into "Worked for …" above it.
          m.workedMs !== undefined && <WorkedFor key="worked" ms={m.workedMs} items={m.activity ?? []} />,
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
              <div className="stamp">
                {m.text && <CopyButton text={m.text} />}
                {when(m.at)}
              </div>
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
              <Markdown text={m.text} onLink={openLink} />
              <div className="stamp">
                {when(m.at)}
                <CopyButton text={m.text} />
              </div>
            </div>
          ),
          m.changes && <Changes key="changes" threadId={thread.id} at={m.at} c={m.changes} />,
        ])}
        {thread && inFlight(thread) && (
          <div className="work">
            <div className="work-head shimmer">
              {thread.awaitingHelpers ? 'Waiting for helpers' : 'Working'}
              {thread.work ? ` for ${duration(Date.now() - thread.work.startedAt)}` : ''}
              {/* Who is on it: a stand-in may differ from the crowned lead. */}
              {thread.leadId && thread.status === 'working' ? ` · ${modelName(thread.leadId)}` : ''}
            </div>
            {(workItems.length > 0 || !speaking) && <Timeline items={workItems} live={thread.status === 'working' && !speaking} />}
          </div>
        )}
        {/* Requests to allow something, from this thread's agent or any helper under it. */}
        {thread &&
          [thread, ...state.threads.filter((x) => x.approval && x.id !== thread.id && parents.every((p) => p.id !== x.id) && isUnder(x, thread.id))]
            .filter((x) => x.approval)
            .map((x) => <Approval key={x.approval!.id} t={x} who={modelName(x.leadId)} />)}
        {thread && liveKids.length > 0 && <div className="graph">{liveKids.slice().reverse().map((k) => graphNode(k, 1))}</div>}
        {thread && speaking && (
          <div className="msg agent">
            <div className="who">
              {acc(thread.leadId) && <Logo kind={acc(thread.leadId)!.kind} />}
              <span>{modelName(thread.leadId)}</span>
            </div>
            <Markdown text={speaking} onLink={openLink} />
          </div>
        )}
        {/* The agent replied but left work running in the background: it picks up by itself when that ends. */}
        {thread && thread.status === 'idle' && thread.waitingOn && thread.waitingOn.length > 0 && (
          <div className="bg-wait" title={thread.waitingOn.join('\n')}>
            <span className="bg-wait-dot" />
            <span>
              {modelName(thread.leadId)} is waiting for {thread.waitingOn.length === 1 ? 'a background task' : `${thread.waitingOn.length} background tasks`}
              <span className="muted"> ({thread.waitingOn.join(', ')})</span>. It continues by itself when {thread.waitingOn.length === 1 ? 'it ends' : 'they end'}.
            </span>
          </div>
        )}
      </section>

      <section className="composer">
        {showTelegram && <TelegramCard t={state.telegram ?? { state: 'off' }} send={send} />}
        {showUsage && (
          <div className="overlay usage-panel">
            <div className="usage-head">
              <b>Usage</b>
              <span className="spacer" />
              <button
                className={`refresh ${refreshing ? 'spin' : ''}`}
                title="Refresh usage now"
                disabled={refreshing}
                onClick={() => {
                  setRefreshing(true);
                  send({ type: 'refreshUsage' });
                }}
              >
                ↻
              </button>
            </div>
            <div className="usage-grid">
            {/* Every signed-in account (the team first): any of them can step in when the team runs out. */}
            {state.accounts
              .filter((a) => state.status[a.id]?.login !== 'signed-out')
              .sort((x, y) => (x.role === 'off' ? 1 : 0) - (y.role === 'off' ? 1 : 0))
              .map((a) => (
              <div key={a.id} className={`usage-item${a.role === 'off' ? ' off' : ''}`}>
                <div className="row">
                  <Logo kind={a.kind} />
                  <b>{modelName(a.id)}</b>
                  <span className={`u-team${a.role === 'off' ? '' : ' on'}`}>{a.role === 'master' ? '♛ lead' : a.role === 'off' ? 'off the team' : 'on the team'}</span>
                </div>
                <div className="muted u-acct">{a.label.replace(/^[^·]+·\s*/, '')}</div>
                {(state.usage[a.id]?.windows ?? []).map((w, i, all) => {
                  // "5h · Gemini": the window in the row, the model group (Antigravity) as a heading above its rows.
                  const [win, group] = w.label.split(' · ');
                  return [
                    group && group !== all[i - 1]?.label.split(' · ')[1] && (
                      <div key={`g-${group}`} className={`u-group${w.other ? ' other' : ''}`}>
                        {group}
                      </div>
                    ),
                    <div key={w.label} className={`u-row${w.other ? ' other' : ''}`} title={w.other ? 'For models this agent is not using now' : undefined}>
                    <span>{win}</span>
                    <span className="u-bar">
                      <i className={w.label.startsWith('week') ? 'week' : 'short'} style={{ width: `${Math.max(2, 100 - w.percent)}%` }} />
                    </span>
                    <span>{Math.round(100 - w.percent)}% left</span>
                    <span className="muted u-reset">{resetsIn(w.resetsAt)}</span>
                    </div>,
                  ];
                })}
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
          {/* The text, with the mic beside it (top right): talk instead of typing. */}
          <div className="input-row">
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
            <Mic voice={voice} />
          </div>
          <div className="toolbar">
            <button className="tool" title="Attach files (or paste an image)" onClick={() => send({ type: 'attach' })}>
              +
            </button>
            {team.length > 0 && (
              <span className="team-count" title={team.map((a) => `${modelName(a.id)} (${a.label.replace(/^[^·]+·\s*/, '')})${(state.status[a.id]?.busyRuns ?? 0) > 0 ? ' · working' : ''}`).join('\n')}>
                {team.length} agent team
                {(() => {
                  const busy = team.filter((a) => (state.status[a.id]?.busyRuns ?? 0) > 0).length;
                  return busy > 0 ? ` · ${busy} working` : '';
                })()}
              </span>
            )}
            <span className="spacer" />
            <Access value={state.autonomy ?? 'standard'} open={overlay === 'access'} onToggle={() => toggleOverlay('access')} onPicked={() => setOverlay(null)} />
            <a className={`opt ${showUsage ? 'on' : ''}`} data-overlay onClick={() => toggleOverlay('usage')}>
              Usage
            </a>
            <a
              className={`opt ${showTelegram || tg === 'on' || tg === 'standby' ? 'on' : ''}`}
              title={`${state.telegram?.bot ? `@${state.telegram.bot}${state.telegram.paired ? ' · paired' : ''}\n` : ''}${TELEGRAM_TIP[tg]}`}
              data-overlay
              // Once paired, one tap turns the bot on or off; right-click (or before pairing, a tap) opens its card.
              onClick={() => {
                const on = tg === 'on' || tg === 'standby';
                if (!on && !(tg === 'paused' && state.telegram?.paired)) return toggleOverlay('telegram');
                send({ type: on ? 'telegramPause' : 'telegramResume' });
                if (overlay !== 'telegram') setOverlay(null); // like a click elsewhere (an open card shows the new state)
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                toggleOverlay('telegram');
              }}
            >
              {/* Once a bot is set up, a dot says at a glance whether it's on (green), off (hollow), half-way (amber) or broken (red). */}
              {tg !== 'off' && <span className={`tg-dot ${tg}`} />}
              Telegram
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
  const name = `${model?.name ?? KIND_SHORT[a.kind]}${a.effort ? ` · ${a.effort === 'medium' ? 'med' : a.effort}` : ''}`;
  const busy = (st?.busyRuns ?? 0) > 0;
  const out = st?.login === 'signed-out' || (st?.cooldownUntil ?? 0) > Date.now() || (u?.windows ?? []).some((w) => !w.other && w.percent >= 100);
  const windows = useMemo(() => (u?.windows ?? []).filter((w) => !w.other).sort((x, y) => (x.label.startsWith('week') ? 1 : 0) - (y.label.startsWith('week') ? 1 : 0)), [u]);
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
      <button className="act" title="Model, reasoning effort, sign out" onClick={() => send({ type: 'pickModel', id: a.id })}>
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
  on: 'Telegram is on: messages to your bot reach the team, and replies come back.\nClick: turn off (stays paired) · Right-click: settings',
  standby: 'Telegram is on (answered by another VS Code window).\nClick: turn off (stays paired) · Right-click: settings',
  paused: 'Telegram is off: nothing is sent to your bot.\nClick: turn on (no pairing needed) · Right-click: settings',
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
/** `sub`: a helper's work, under its lead's: the same view, just not as tall. */
function Timeline({ items, live, sub }: { items: string[]; live?: boolean; sub?: boolean }) {
  // Its own scroll box: follows new output, unless you scrolled up to read.
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    if (box.current && pinned.current) box.current.scrollTop = box.current.scrollHeight;
  }, [items.length, items.at(-1)?.length]);
  // When the current step began: a slow command shows how long it has been running instead of looking stuck.
  const stepSince = useRef({ n: -1, at: Date.now() });
  if (stepSince.current.n !== items.length) stepSince.current = { n: items.length, at: Date.now() };
  // Like Codex, "Thinking…" only shows while it's happening (the last item), not after every step.
  items = items.filter((s, i) => !s.startsWith('💭') || i === items.length - 1);
  if (!items.length) return <div className="g-step now"><i>Thinking…</i></div>;
  return (
    <div
      className={`timeline${sub ? ' sub' : ''}`}
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {groups(items).map((g) =>
        g.say ? (
          <div key={g.at} className="tl-say">
            <Markdown text={g.items[0].slice(2).trim()} onLink={openLink} />
          </div>
        ) : (
          // What the agent did (reads, edits, commands) sits in its own shaded block, apart from what it says.
          <div key={g.at} className="tl-tools">
            {g.items.map((s, j) => (
              <Step key={j} text={s} live={!!live && g.at + j === items.length - 1} since={stepSince.current.at} />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

/** Speech to text: click to talk, click again to stop (or ✕ to drop it); the text lands in the prompt box. */
function Mic({ voice }: { voice: { state: 'idle' | 'installing' | 'recording' | 'transcribing'; level?: number; startedAt?: number } }) {
  if (voice.state === 'recording') {
    const secs = voice.startedAt ? Math.max(0, Math.floor((Date.now() - voice.startedAt) / 1000)) : 0;
    return (
      <span className="mic-live">
        <button className="tool mic on" title="Stop and turn into text" onClick={() => send({ type: 'voiceStop' })} style={{ boxShadow: `0 0 0 ${2 + Math.round((voice.level ?? 0) * 8)}px rgba(229, 72, 77, 0.25)` }}>
          <MicIcon />
        </button>
        <span className="mic-time">
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        </span>
        <button className="tool mic-x" title="Discard the recording" onClick={() => send({ type: 'voiceStop', cancel: true })}>
          ✕
        </button>
      </span>
    );
  }
  const busy = voice.state !== 'idle';
  return (
    <span className="mic-live">
      <button className={`tool mic ${busy ? 'busy' : ''}`} disabled={busy} title="Speech to text, done on your local machine: your voice is never sent to a server" onClick={() => send({ type: 'voiceStart' })}>
        <MicIcon />
      </button>
      {voice.state === 'transcribing' && <span className="mic-time shimmer">Transcribing…</span>}
      {voice.state === 'installing' && <span className="mic-time shimmer">Setting up voice…</span>}
    </span>
  );
}

const MicIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <path d="M12 17v4" />
  </svg>
);

/** The agent's words one by one; consecutive tool steps together. `at`: index of the group's first item. */
function groups(items: string[]): { say: boolean; at: number; items: string[] }[] {
  const out: { say: boolean; at: number; items: string[] }[] = [];
  items.forEach((s, i) => {
    const say = /^(💬|🏁)/u.test(s);
    const last = out.at(-1);
    if (!say && last && !last.say) last.items.push(s);
    else out.push({ say, at: i, items: [s] });
  });
  return out;
}

type Level = 'standard' | 'auto' | 'full';
const ACCESS_NAME: Record<Level, string> = { standard: 'Ask', auto: 'Approve for me', full: 'Auto' };

/**
 * The access level, as a compact button with its menu in the shared overlay above the prompt box (a native select is
 * as wide as its longest option, and VS Code closes its list whenever the panel re-renders).
 */
function Access({ value, open, onToggle, onPicked }: { value: Level; open: boolean; onToggle: () => void; onPicked: () => void }) {
  return (
    <>
      <a className={`opt access-btn ${value} ${open ? 'on' : ''}`} data-overlay title={ACCESS_TIP[value]} onClick={onToggle}>
        {ACCESS_NAME[value]} ▾
      </a>
      {open && (
        <div className="overlay access-menu">
          {(['standard', 'auto', 'full'] as Level[]).map((l) => (
            <div
              key={l}
              className={`access-item ${l === value ? 'on' : ''}`}
              onClick={() => {
                send({ type: 'setAutonomy', value: l });
                onPicked();
              }}
            >
              <b className={l}>{ACCESS_NAME[l]}</b>
              <span>{ACCESS_TIP[l].replace(/^[^:]+:\s*/, '')}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** What each access level means (the prompt box's selector). */
const ACCESS_TIP: Record<Level, string> = {
  standard: 'Ask: agents work in this folder; before going outside it (other folders, network) they ask you. Antigravity cannot ask: it stays in its sandbox.',
  auto: 'Approve for me: same limits, but an automatic reviewer (Codex auto-review, Claude Code auto mode) approves or blocks requests instead of you. Antigravity has no reviewer: it works as in Ask.',
  full: 'Auto: full access, no sandbox and no questions, for every agent. Undo per turn still works.',
};

/** An agent asks for something its sandbox blocks (outside the folder, network): allow it once, for the session, or deny. */
function Approval({ t, who }: { t: Thread; who: string }) {
  const a = t.approval!;
  const [sent, setSent] = useState(false);
  const answer = (x: 'accept' | 'acceptForSession' | 'decline') => {
    setSent(true);
    send({ type: 'approve', threadId: t.id, id: a.id, answer: x });
  };
  const what = a.kind === 'command' ? 'wants to run a command' : a.kind === 'files' ? 'wants to edit files' : a.kind === 'tool' ? `wants to use ${a.tool ?? 'a tool'}` : 'asks for more access';
  return (
    <div className="approval">
      <div className="approval-head">
        <b>{who}</b> {what}
        {a.cwd && <span className="muted"> in {a.cwd}</span>}
      </div>
      {a.reason && <div className="approval-reason">{a.reason}</div>}
      {a.command && <pre className="approval-cmd">{a.command}</pre>}
      {a.paths && a.paths.length > 0 && (
        <div className="approval-paths">
          {a.kind === 'permissions' && <span className="muted">Write access to:</span>}
          {a.paths.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      {a.network && <div className="approval-reason">Network access</div>}
      <div className="approval-actions">
        <button className="primary" disabled={sent} onClick={() => answer('accept')}>
          Allow
        </button>
        <button className="ghost" disabled={sent} onClick={() => answer('acceptForSession')} title="Allow this and similar requests for the rest of this session">
          Allow for this session
        </button>
        <button className="ghost danger" disabled={sent} onClick={() => answer('decline')} title="The agent is told you declined and carries on without it">
          Deny
        </button>
      </div>
    </div>
  );
}

/** Codex-style summary of the files a turn changed, with +/- line counts, a diff per file, and undo/redo. */
function Changes({ threadId, at, c }: { threadId: string; at: number; c: RunChanges }) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [c.undone]);
  const add = c.files.reduce((n, f) => n + f.add, 0);
  const del = c.files.reduce((n, f) => n + f.del, 0);
  const shown = all ? c.files : c.files.slice(0, 6);
  const act = (type: 'undoChanges' | 'redoChanges') => {
    setBusy(true);
    send({ type, threadId, at });
    setTimeout(() => setBusy(false), 8000); // the result comes back as new state (or an error message)
  };
  return (
    <div className={`changes${c.undone ? ' undone' : ''}${c.expired ? ' expired' : ''}`}>
      <div className="changes-head">
        <span>
          {c.files.length} file{c.files.length === 1 ? '' : 's'} changed <span className="plus">+{add}</span> <span className="minus">-{del}</span>
          {c.undone && <span className="muted"> · undone</span>}
        </span>
        {c.expired ? (
          <span className="muted" title="Only the last few turns in a workspace keep the snapshots needed to undo them">
            too old to undo
          </span>
        ) : (
          <button className="ghost" disabled={busy} onClick={() => act(c.undone ? 'redoChanges' : 'undoChanges')} title={c.undone ? 'Put these changes back' : 'Revert every change this turn made'}>
            {c.undone ? 'Redo' : 'Undo'}
          </button>
        )}
      </div>
      {shown.map((f) => (
        <div key={f.path} className="change-row" title={c.expired ? f.path : `Show what changed in ${f.path}`} onClick={() => !c.expired && send({ type: 'openDiff', threadId, at, path: f.path })}>
          <span className="change-path">
            {baseName(f.path)}
            {f.path.includes('/') && <span className="muted"> {f.path.slice(0, f.path.lastIndexOf('/'))}</span>}
          </span>
          {f.binary ? (
            <span className="muted">binary</span>
          ) : (
            <span>
              <span className="plus">+{f.add}</span> <span className="minus">-{f.del}</span>
            </span>
          )}
        </div>
      ))}
      {c.files.length > 6 && (
        <div className="change-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show ${c.files.length - shown.length} more`}
        </div>
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
function Step({ text, live, since }: { text: string; live: boolean; since?: number }) {
  // A long command or path shows on one line; click it to see all of it (exactly as the agent ran it).
  const [open, setOpen] = useState(false);
  const m = /^(💭|🔧|▶|✏️|🔎|💬)\s*(.*)$/u.exec(text);
  const [icon, rest] = m ? [m[1], m[2]] : ['💬', text];
  const tool = /^(\S+(?: files| file| command)?)\s*(.*)$/.exec(rest); // "read file C:\x" → "read file" + "C:\x"
  const body =
    icon === '💭' ? <i>Thinking…</i>
    : icon === '✏️' ? <><b>Edited</b> files</>
    : icon === '▶' ? <><b>Ran</b> <code>{rest}</code></>
    : icon === '🔎' ? <><b>Searched</b> {rest}</>
    : icon === '🔧' && tool ? <><b>{cap(tool[1].replace(/_/g, ' '))}</b> <span className="g-arg">{open ? tool[2] : short(tool[2])}</span></>
    : <span className="g-say">{rest.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')}</span>; // links in narration: just their text
  // Narration wraps in full; commands and paths stay on one line until clicked.
  const say = !['💭', '✏️', '▶', '🔎', '🔧'].includes(icon) || (icon === '🔧' && !tool);
  const long = !say && rest.length > 60;
  // The step running now: after a few seconds, for how long (a slow command, not a stuck one).
  const ms = live && since ? Date.now() - since : 0;
  return (
    <div
      className={`g-step ${live ? 'now' : ''} ${say ? 'say' : ''} ${long ? 'long' : ''} ${open ? 'open' : ''}`}
      title={long && !open ? 'Click to see all of it' : undefined}
      onClick={long ? () => setOpen((v) => !v) : undefined}
    >
      {ms >= 5000 && !say && <span className="g-elapsed">{duration(ms)}</span>}
      {body}
    </div>
  );
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
