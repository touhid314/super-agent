import { describe, expect, it } from 'vitest';
import { TeamPanel, type Member } from '../src/telegram-team';

function panel() {
  const members: Member[] = [
    { id: 'a', agent: 'Claude Code', model: 'Opus 9', account: 'tesla', onTeam: true, lead: true, busy: true, usage: '5h 80% · week 60% left' },
    { id: 'b', agent: 'Codex', model: 'GPT-9', account: 'oppie', onTeam: true, lead: false, busy: false },
    { id: 'c', agent: 'Antigravity', model: 'Gemini 9', account: 'Antigravity 1', onTeam: false, lead: false, busy: false, out: 'signed out' },
  ];
  const models: Record<string, string | undefined> = { a: 'claude-opus-9-long-model-id-that-would-not-fit-in-button-data-20990101' };
  const edits: { text: string; buttons: { text: string; callback_data: string }[] }[] = [];
  const toasts: string[] = [];
  const p = new TeamPanel({
    api: async (method, body) => {
      if (method === 'editMessageText' || method === 'sendMessage')
        edits.push({ text: String(body.text), buttons: (body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat() });
      if (method === 'answerCallbackQuery' && body.text) toasts.push(String(body.text));
      return true as never;
    },
    members: () => members,
    toggle: (id) => {
      const m = members.find((x) => x.id === id)!;
      m.onTeam = !m.onTeam;
    },
    makeLead: (id) => members.forEach((m) => (m.lead = m.id === id)),
    models: async (id) => [
      { id: 'claude-opus-9-long-model-id-that-would-not-fit-in-button-data-20990101', name: 'Opus 9', current: models[id] === 'claude-opus-9-long-model-id-that-would-not-fit-in-button-data-20990101' },
      { id: 'claude-sonnet-9-also-a-very-long-identifier-for-a-model-20990101', name: 'Sonnet 9', current: false },
    ],
    setModel: (id, model) => void (models[id] = model),
  });
  const tap = async (label: string) => {
    const b = edits.at(-1)!.buttons.find((x) => x.text.includes(label));
    if (!b) throw new Error(`no "${label}" in ${edits.at(-1)!.buttons.map((x) => x.text).join(' | ')}`);
    expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    await p.onCallback(1, 5, 'q', b.callback_data);
  };
  return { p, members, models, edits, toasts, tap };
}

describe('Telegram /team', () => {
  it('shows the team, the lead, usage and status, members first', async () => {
    const h = panel();
    await h.p.open(1);
    const v = h.edits[0];
    expect(v.text).toMatch(/Team of 2<\/b>\s+·\s+♛ lead: Opus 9/);
    expect(v.text).toContain('♛ <b>Opus 9</b>  <i>Claude Code · tesla</i>');
    expect(v.text).toContain('5h 80% · week 60% left');
    expect(v.text).toMatch(/⬜ <b>Gemini 9<\/b>[\s\S]*signed out · off the team/);
    expect(v.buttons.map((b) => b.text).slice(0, 3)).toEqual(['✅ Opus 9', '♛ Lead', '🧠 Model']);
  });

  it('toggles members, moves the lead, and picks a model (long ids go by position)', async () => {
    const h = panel();
    await h.p.open(1);
    await h.tap('⬜ Gemini 9');
    expect(h.members[2].onTeam).toBe(true);
    expect(h.edits.at(-1)!.text).toContain('Team of 3');

    const makeLead = h.edits.at(-1)!.buttons.findIndex((b) => b.text === '♔ Make lead'); // first non-lead: GPT-9
    await h.p.onCallback(1, 5, 'q', h.edits.at(-1)!.buttons[makeLead].callback_data);
    expect(h.members.find((m) => m.lead)!.id).toBe('b');
    expect(h.toasts.at(-1)).toBe('♛ GPT-9 leads');

    await h.tap('🧠 Model'); // first row: GPT-9 is now listed... members keep config order
    await h.tap('Sonnet 9');
    expect(Object.values(h.models)).toContain('claude-sonnet-9-also-a-very-long-identifier-for-a-model-20990101');
    expect(h.edits.at(-1)!.text).toContain('Team of 3');
  });
});
