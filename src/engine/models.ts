import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../../super-agent/src/shared/types';

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
}

/** What a chip shows: the model an account will run, and whether it's the CLI's own default. */
export interface ModelInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

const HOME = os.homedir();
/** Newest-first model list per Claude account, straight from Anthropic (nothing hard-coded). */
const claudeCache = new Map<string, ModelOption[]>();

async function claudeModels(acc: Account): Promise<ModelOption[]> {
  const key = acc.home ?? 'default';
  if (claudeCache.has(key)) return claudeCache.get(key)!;
  const creds = JSON.parse(fs.readFileSync(path.join(acc.home ?? path.join(HOME, '.claude'), '.credentials.json'), 'utf8'))?.claudeAiOauth;
  if (!creds?.accessToken) return [];
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { Authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const data = ((await res.json()) as { data?: { id: string; display_name?: string; created_at?: string }[] }).data ?? [];
  const list = data
    .sort((x, y) => Date.parse(y.created_at ?? '') - Date.parse(x.created_at ?? ''))
    .map((m) => ({ id: m.id, name: (m.display_name ?? m.id).replace(/^Claude\s+/, ''), description: m.id }));
  if (list.length) claudeCache.set(key, list);
  return list;
}

/** Claude Code aliases (`opus`, `sonnet[1m]`…) follow the newest model of that family in the live list. */
function resolveAlias(id: string, options: ModelOption[]): string | undefined {
  const m = /^([a-z]+)(\[1m\])?$/i.exec(id);
  if (!m) return undefined;
  const newest = options.find((o) => o.id.toLowerCase().includes(`-${m[1].toLowerCase()}-`) || o.id.toLowerCase().endsWith(`-${m[1].toLowerCase()}`));
  return newest ? `${newest.name}${m[2] ? ' 1M' : ''}` : undefined;
}
let agyCache: ModelOption[] | null = null;

/** Models this account's CLI offers. */
export async function listModels(acc: Account, cliPath: string | null): Promise<ModelOption[]> {
  if (acc.kind === 'codex') {
    for (const home of [acc.home, path.join(HOME, '.codex')]) {
      if (!home) continue;
      try {
        const cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8')) as { models?: any[] };
        const list = (cache.models ?? []).filter((m) => m.visibility !== 'hide');
        if (list.length) return list.map((m) => ({ id: m.slug, name: m.display_name ?? m.slug, description: m.description }));
      } catch {
        /* try the next home */
      }
    }
    return [];
  }
  if (acc.kind === 'claude') return claudeModels(acc).catch(() => []);
  if (agyCache) return agyCache;
  if (!cliPath) return [];
  const out = await new Promise<string>((resolve) =>
    execFile(cliPath, ['models'], { timeout: 30000, windowsHide: true }, (_e, stdout) => resolve(String(stdout ?? ''))),
  );
  const parsed = out
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && p[0].trim())
    .map(([id, name]) => ({ id: id.trim(), name: name.trim() }));
  if (parsed.length) agyCache = parsed;
  return parsed;
}

/** The model the CLI uses when Super Agent doesn't pass one. */
function cliDefault(acc: Account): string | undefined {
  try {
    if (acc.kind === 'codex') {
      const toml = fs.readFileSync(path.join(acc.home ?? path.join(HOME, '.codex'), 'config.toml'), 'utf8');
      return /^\s*model\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
    }
    if (acc.kind === 'claude') {
      const settings = JSON.parse(fs.readFileSync(path.join(acc.home ?? path.join(HOME, '.claude'), 'settings.json'), 'utf8'));
      return typeof settings.model === 'string' ? settings.model : undefined;
    }
  } catch {
    /* no default configured */
  }
  return undefined;
}

export function modelInfo(acc: Account, options: ModelOption[]): ModelInfo {
  const id = acc.model || cliDefault(acc) || '';
  const known = options.find((o) => o.id === id);
  const name = known?.name ?? (acc.kind === 'claude' ? resolveAlias(id, options) : undefined) ?? (id ? prettify(id) : 'Default model');
  return { id, name, isDefault: !acc.model };
}

function prettify(id: string): string {
  return id.replace(/\[1m\]$/i, ' 1M').replace(/^claude-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
