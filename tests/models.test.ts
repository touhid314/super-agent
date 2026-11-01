import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Account } from '../src/core/types';
import { listModels, modelInfo } from '../src/engine/models';

const acc = (kind: Account['kind'], home: string | null, model?: string): Account => ({ id: 'x', kind, label: 'x', home, role: 'worker', model, createdAt: 0 });

describe('models', () => {
  it('lists Codex models from the account cache and shows its configured default', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-models-'));
    fs.writeFileSync(
      path.join(home, 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-a', display_name: 'GPT A', visibility: 'list' }, { slug: 'hidden', display_name: 'H', visibility: 'hide' }] }),
    );
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-a"\n');
    const a = acc('codex', home);
    const opts = await listModels(a, null);
    expect(opts.map((o) => o.id)).toEqual(['gpt-a']);
    expect(modelInfo(a, opts)).toEqual({ id: 'gpt-a', name: 'GPT A', isDefault: true });
  });

  it('a model chosen for the account wins over the CLI default', () => {
    const a = acc('claude', null, 'claude-sonnet-x-1');
    expect(modelInfo(a, [{ id: 'claude-sonnet-x-1', name: 'Sonnet X.1' }])).toEqual({ id: 'claude-sonnet-x-1', name: 'Sonnet X.1', isDefault: false });
  });

  it('resolves Claude aliases to the newest model of that family from the live list (no hard-coded versions)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-models-'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }));
    const live = [
      { id: 'claude-opus-9-1', name: 'Opus 9.1' }, // newest first, as the API returns them
      { id: 'claude-sonnet-9', name: 'Sonnet 9' },
      { id: 'claude-opus-9', name: 'Opus 9' },
    ];
    expect(modelInfo(acc('claude', home), live).name).toBe('Opus 9.1 1M');
    expect(modelInfo(acc('claude', home, 'sonnet'), live).name).toBe('Sonnet 9');
  });});
