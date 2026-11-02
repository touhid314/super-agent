import { describe, expect, it } from 'vitest';
import { ActivityParser } from '../src/engine/activity';

describe('activity for the panel (Codex-style)', () => {
  it('keeps what the agent says whole, as Markdown paragraphs, between its steps', () => {
    const p = new ActivityParser(8000, 300, true);
    p.feed('codex\nI checked the catalog: **37** papers so far.\n\nNext I will review SecAlign.\n');
    p.feed('→ run command python build.py\n');
    p.feed('codex\nDone.\n');
    p.flush();
    expect(p.items).toEqual(['💬 I checked the catalog: **37** papers so far.\n\nNext I will review SecAlign.', '🔧 run command python build.py', '💬 Done.']);
  });

  it("Telegram's compact mode still gives short single lines", () => {
    const p = new ActivityParser();
    p.feed('codex\nI checked the catalog: **37** papers so far.\nNext I will review SecAlign.\n');
    expect(p.items).toEqual(['💬 I checked the catalog: 37 papers so far.', '💬 Next I will review SecAlign.']);
  });
});
