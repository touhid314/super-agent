import { left, type Btn, type View } from './telegram-files';

/** One agent account, as the bot shows it. */
export interface Member {
  id: string;
  /** Agent (CLI): "Codex", "Claude Code", "Antigravity". */
  agent: string;
  /** Model it runs, e.g. "Opus 5.5". */
  model: string;
  /** Account name (email-ish). */
  account: string;
  onTeam: boolean;
  lead: boolean;
  busy: boolean;
  /** Signed out, or out of usage for now. */
  out?: string;
  /** e.g. "5h 80% · week 60% left". */
  usage?: string;
}

export interface TeamDeps {
  api<T = unknown>(method: string, body: Record<string, unknown>): Promise<T>;
  members(): Member[];
  toggle(id: string): void;
  makeLead(id: string): void;
  /** Models this account can run; the current one is marked. */
  models(id: string): Promise<{ id: string; name: string; current: boolean }[]>;
  /** '' = the CLI's own default. */
  setModel(id: string, model: string): void;
}

/** /team: who's on the team and who leads, with buttons to change it (same as the chips in VS Code). */
export class TeamPanel {
  /** Model choices per account, by position (model ids can exceed Telegram's 64-byte button data). */
  private choices = new Map<string, string[]>();

  constructor(private d: TeamDeps) {}

  async open(chat: number): Promise<void> {
    const v = this.view();
    await this.d.api('sendMessage', { chat_id: chat, text: v.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: v.buttons } });
  }

  /** Handles a button tap. Returns false if the data isn't ours. */
  async onCallback(chat: number, messageId: number, queryId: string, data: string): Promise<boolean> {
    const [ns, action, id, arg] = data.split(':');
    if (ns !== 'tm') return false;
    const m = this.d.members().find((x) => x.id === id);
    const toast = (text?: string) => this.d.api('answerCallbackQuery', { callback_query_id: queryId, ...(text ? { text } : {}) }).catch(() => undefined);
    let v: View = this.view();
    if (action === 't' && m) {
      this.d.toggle(m.id);
      await toast(m.onTeam ? `${m.model} left the team` : `${m.model} joined the team`);
      v = this.view();
    } else if (action === 'l' && m) {
      if (!m.lead) this.d.makeLead(m.id);
      await toast(`♛ ${m.model} leads`);
      v = this.view();
    } else if (action === 'm' && m) {
      await toast();
      v = await this.modelView(m);
    } else if (action === 'p' && m) {
      const model = this.choices.get(m.id)?.[Number(arg)];
      if (model === undefined) return (await toast('That list expired. Open it again.')), true;
      this.d.setModel(m.id, model);
      await toast('Model updated');
      v = this.view();
    } else {
      await toast();
    }
    await this.d
      .api('editMessageText', { chat_id: chat, message_id: messageId, text: v.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: v.buttons } })
      .catch((e: Error) => {
        if (!/not modified/i.test(e.message)) throw e;
      });
    return true;
  }

  view(): View {
    const all = this.d.members();
    const team = all.filter((m) => m.onTeam);
    const lead = all.find((m) => m.lead && m.onTeam);
    const line = (m: Member) => {
      const mark = !m.onTeam ? '⬜' : m.lead ? '♛' : '✅';
      const state = [m.busy ? '⚙️ working' : '', m.out ? `⚠️ ${m.out}` : '', !m.onTeam ? 'off the team' : ''].filter(Boolean).join(' · ');
      return `${mark} <b>${esc(m.model)}</b>  <i>${esc(m.agent)} · ${esc(m.account)}</i>${m.usage ? `\n      ${esc(m.usage)}` : ''}${state ? `\n      ${esc(state)}` : ''}`;
    };
    const head = `👥 <b>Team of ${team.length}</b>${lead ? `  ·  ♛ lead: ${esc(lead.model)}` : ''}`;
    const text = all.length ? `${head}\n\n${[...team, ...all.filter((m) => !m.onTeam)].map(line).join('\n\n')}` : 'No agents yet. Add one in VS Code (the + in the Super Agent panel).';
    const buttons: Btn[][] = [...team, ...all.filter((m) => !m.onTeam)].map((m) => [
      { text: `${m.onTeam ? '✅' : '⬜'} ${m.model}`, callback_data: `tm:t:${m.id}` },
      { text: m.lead ? '♛ Lead' : '♔ Make lead', callback_data: `tm:l:${m.id}` },
      { text: '🧠 Model', callback_data: `tm:m:${m.id}` },
    ]);
    buttons.push([{ text: '🔄 Refresh', callback_data: 'tm:r' }]);
    return { text: `${text}\n\n<i>✅ on the team · ⬜ off · ♛ leads new work</i>`, buttons };
  }

  private async modelView(m: Member): Promise<View> {
    const options = await this.d.models(m.id).catch(() => []);
    const current = options.find((o) => o.current);
    this.choices.set(m.id, ['', ...options.map((o) => o.id)]);
    const buttons: Btn[][] = [
      [{ text: left(`${current ? '' : '✓ '}CLI default`), callback_data: `tm:p:${m.id}:0` }],
      ...options.slice(0, 40).map((o, i) => [{ text: left(`${o.current ? '✓ ' : ''}${o.name}`), callback_data: `tm:p:${m.id}:${i + 1}` }]),
      [{ text: '⬅ Team', callback_data: 'tm:r' }],
    ];
    const text = `🧠 <b>Model for ${esc(m.agent)}</b>  <i>${esc(m.account)}</i>\nNow: <b>${esc(m.model)}</b>${options.length ? '' : '\n<i>No model list available for this agent right now.</i>'}`;
    return { text, buttons };
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
