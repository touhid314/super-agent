import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';

export interface TelegramView {
  /** paused: turned off with one tap; the bot and the paired chat are kept, so turning it on needs no pairing. */
  state: 'off' | 'pairing' | 'on' | 'standby' | 'error' | 'paused';
  bot?: string;
  /** A chat is paired (set while paused). */
  paired?: boolean;
  /** t.me link that pairs your chat when opened (scan it with your phone). */
  pairLink?: string;
  /** The same pairing code, for typing it into the bot chat. */
  code?: string;
  error?: string;
}

const BOTFATHER = 'https://t.me/BotFather';

/** A QR code as inline SVG (dark modules on white, so phone cameras read it in any theme). */
function Qr({ text, size = 148 }: { text: string; size?: number }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Connect / pair / manage the Telegram relay, right in the panel. */
export function TelegramCard({ t, send, onClose }: { t: TelegramView; send: (m: unknown) => void; onClose: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const open = (url: string) => send({ type: 'openLink', url });
  const connect = () => {
    if (!token.trim()) return;
    setBusy(true);
    send({ type: 'telegramConnect', token });
    setTimeout(() => setBusy(false), 4000);
  };

  let body;
  if (t.state === 'on' || t.state === 'standby') {
    body = (
      <>
        <div className="tg-ok">✓ Connected to @{t.bot ?? 'your bot'}</div>
        <p className="muted">Message the bot from your phone: the team works here on this laptop and replies in Telegram.</p>
        {t.bot && (
          <div className="tg-qr-row">
            <Qr text={`https://t.me/${t.bot}`} size={112} />
            <span className="muted">Scan to open the chat on your phone.</span>
          </div>
        )}
        {t.state === 'standby' && <p className="muted">Another VS Code window is currently answering the bot.</p>}
        <div className="tg-actions">
          <button className="ghost" title="Stop answering the bot for now; it stays paired" onClick={() => send({ type: 'telegramPause' })}>
            Disconnect
          </button>
          <a className="small muted" onClick={() => send({ type: 'telegramForget' })}>
            Forget this bot
          </a>
        </div>
      </>
    );
  } else if (t.state === 'paused') {
    body = (
      <>
        <div className="tg-step">
          Telegram is off: nothing is sent to @{t.bot ?? 'your bot'} and it doesn't answer. It stays {t.paired ? 'paired' : 'set up'}, so connecting again takes one tap.
        </div>
        <div className="tg-actions">
          <button className="ghost" onClick={() => send({ type: 'telegramResume' })}>
            Connect
          </button>
          <a className="small muted" onClick={() => send({ type: 'telegramForget' })}>
            Forget this bot
          </a>
        </div>
      </>
    );
  } else if (t.state === 'pairing' && t.pairLink) {
    body = (
      <>
        <div className="tg-step">
          <b>Scan with your phone</b> to open @{t.bot} and press <b>Start</b>. That pairs your chat.
        </div>
        <div className="tg-qr-row">
          <Qr text={t.pairLink} />
          <div className="tg-side">
            <span className="muted">On this laptop instead?</span>
            <button className="ghost" onClick={() => open(t.pairLink!)}>
              Open in Telegram
            </button>
            <span className="muted small">Only the chat that pairs can use the bot.</span>
          </div>
        </div>
        {t.code && (
          <div className="muted small">
            Chat already open and nothing happened? Send this code to the bot: <b className="tg-code">{t.code}</b>
          </div>
        )}
        <a className="small" onClick={() => send({ type: 'telegramForget' })}>
          Use a different bot
        </a>
      </>
    );
  } else {
    body = (
      <>
        <div className="tg-step">
          <span className="num">1</span>
          <div>
            Create your bot: open <a onClick={() => open(BOTFATHER)}>@BotFather</a>, send <code>/newbot</code>, pick a name. It replies with a token.
            <div className="muted small">
              Already made one? No need for another: in @BotFather send <code>/mybots</code>, pick your bot, then <b>API Token</b>.
            </div>
            <div className="tg-qr-row compact">
              <Qr text={BOTFATHER} size={96} />
              <span className="muted small">Or scan to do it on your phone.</span>
            </div>
          </div>
        </div>
        <div className="tg-step">
          <span className="num">2</span>
          <div className="grow">
            Paste the token here:
            <div className="tg-input">
              <input
                type="password"
                value={token}
                placeholder="123456789:AAH…"
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && connect()}
              />
              <button className="ghost" disabled={!token.trim() || busy} onClick={connect}>
                {busy ? 'Checking…' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
        <div className="tg-step">
          <span className="num">3</span>
          <div className="muted">Scan the QR code that appears to pair your phone.</div>
        </div>
        {t.error && <div className="warn">{t.error}</div>}
      </>
    );
  }

  return (
    <div className="tg-card">
      <div className="tg-head">
        <b>Telegram</b>
        <span className="spacer" />
        <button className="x" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {body}
    </div>
  );
}
