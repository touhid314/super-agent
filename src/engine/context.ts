import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../../super-agent/src/shared/types';
import type { Thread, ThreadSession } from './types';

/**
 * Carry an agent's exact conversation to another account of the same CLI by copying the session
 * transcript into the new account's config folder (the new agent then resumes it). Returns false if
 * the transcript can't be found, in which case the caller falls back to a written brief.
 */
export function transferSession(session: ThreadSession, from: Account, to: Account): boolean {
  if (from.kind !== to.kind || from.id === to.id) return from.id === to.id;
  try {
    if (session.kind === 'claude') {
      const fromProjects = path.join(from.home ?? path.join(os.homedir(), '.claude'), 'projects');
      const toProjects = path.join(to.home ?? path.join(os.homedir(), '.claude'), 'projects');
      for (const dir of fs.readdirSync(fromProjects)) {
        const src = path.join(fromProjects, dir, `${session.id}.jsonl`);
        if (!fs.existsSync(src)) continue;
        fs.mkdirSync(path.join(toProjects, dir), { recursive: true });
        fs.copyFileSync(src, path.join(toProjects, dir, `${session.id}.jsonl`));
        return true;
      }
      return false;
    }
    if (session.kind === 'codex') {
      const fromRoot = path.join(from.home ?? path.join(os.homedir(), '.codex'), 'sessions');
      const toRoot = path.join(to.home ?? path.join(os.homedir(), '.codex'), 'sessions');
      const rel = findFile(fromRoot, (n) => n.includes(session.id) && n.endsWith('.jsonl'));
      if (!rel) return false;
      fs.mkdirSync(path.dirname(path.join(toRoot, rel)), { recursive: true });
      fs.copyFileSync(path.join(fromRoot, rel), path.join(toRoot, rel));
      return true;
    }
  } catch {
    /* fall back to a brief */
  }
  return false;
}

function findFile(root: string, match: (name: string) => boolean, rel = ''): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) {
    const r = path.join(rel, e.name);
    if (e.isFile() && match(e.name)) return r;
    if (e.isDirectory()) {
      const f = findFile(root, match, r);
      if (f) return f;
    }
  }
  return null;
}

/**
 * Written hand-over for a different CLI (or when a transcript can't be moved): the conversation,
 * what the previous agent was last doing, and the current state of the files.
 */
export function contextBrief(t: Thread, labelOf: (id?: string) => string, why: string): string {
  const convo = t.messages
    .filter((m) => m.role !== 'system')
    .slice(-14)
    .map((m) => `${m.role === 'user' ? 'USER' : labelOf(m.accountId).toUpperCase()}: ${m.text.length > 1800 ? m.text.slice(0, 1800) + ' …' : m.text}`)
    .join('\n\n');
  let lastWork = '';
  try {
    if (t.lastLog) {
      const log = fs.readFileSync(t.lastLog, 'utf8');
      lastWork = log.length > 6000 ? '…' + log.slice(-6000) : log;
    }
  } catch {
    /* no log yet */
  }
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: t.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
    } catch {
      return '';
    }
  };
  const status = git(['status', '--short']);
  const stat = git(['diff', '--stat']);
  return [
    `## Context hand-over (${why})`,
    'You are continuing work another agent started in this folder. Everything it knew is summarised below. Continue seamlessly: do not start over, do not redo finished work.',
    convo && `### Conversation so far\n${convo}`,
    lastWork && `### What the previous agent was doing most recently (its own output)\n${lastWork}`,
    (status || stat) && `### Current uncommitted changes in the folder\n${status}\n${stat}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Standing instructions every lead gets: work yourself, and spin off parallel helpers when useful. */
export function leadPreamble(handoffDir: string): string {
  return `You are working inside Super Agent, which gives you a team of other coding agents (Codex, Claude Code, Antigravity) who are free to help.
Do the work yourself. While working, if you notice a piece of work that is INDEPENDENT of what you are doing right now and would save time if someone did it in parallel (e.g. tests for a finished module, a separate page, docs, a script), hand it off:
- Create a Markdown file in \`${handoffDir}\` (e.g. \`${handoffDir}/write-api-tests.md\`) containing: a one-line title, the goal, the exact files the helper owns, and any context it needs.
- A free teammate starts on it immediately in this same folder. Do not edit the files you gave away.
- When it finishes, its report appears next to your request as \`<name>.result.md\`.
Only hand off clearly separable work; small or tightly coupled tasks are faster to do yourself.

`;
}

export function helperPrompt(leadLabel: string, leadGoal: string, request: string, owns: string): string {
  return `You are a helping hand in Super Agent. ${leadLabel} is working on: "${leadGoal}" and asked you to take this part in parallel, in the same folder.
Other agents are editing other files here right now: change only the files listed in the request${owns ? ` (${owns})` : ''}.

## Your task
${request}

When done, reply with a short report: what you did, files changed, anything the lead must know.`;
}
