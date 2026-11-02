import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../core/types';
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
  // The request in progress (a take-over mid-task): what was said and done so far, step by step. Or, after a turn
  // that was cut off (VS Code closed, stopped), the steps it got through: "continue" means carry on from there.
  // (The latest such turn since the last answer; notes like "c leads this thread now" may come after it.)
  const since = t.messages.slice(t.messages.map((m) => m.role).lastIndexOf('agent') + 1);
  const cut = since.filter((m) => m.role === 'system' && m.activity?.length).at(-1);
  const items = t.work?.items.length ? t.work.items : (cut?.activity ?? []);
  const steps = items.filter((s) => !s.startsWith('💭')).slice(-60);
  const plain = (s: string) => s.replace(/^▶\s*/u, 'Ran ').replace(/^(💬|🏁|🔧|✏️|🔎)\s*/u, '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const doneSoFar = steps.map((s) => `- ${plain(s)}`).join('\n');
  let lastWork = '';
  try {
    if (t.lastLog && !doneSoFar) {
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
    doneSoFar &&
      `### The current request: what was done so far (oldest first)\nThe previous agent stopped in the middle of this request. Its last step may not have finished, so check the files it was working on before relying on them; then carry on from there.\n${doneSoFar}`,
    lastWork && `### What the previous agent was doing most recently (its own output)\n${lastWork}`,
    (status || stat) && `### Current uncommitted changes in the folder\n${status}\n${stat}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Live team status, kept in the workspace so every agent can read it at any time. */
export const TEAM_FILE = '.super-agent/team.md';

/**
 * What every agent (lead or helper) is told once per session. These are strong agents: they get the facts and the
 * mechanism, not a playbook.
 */
export function leadPreamble(handoffDir: string): string {
  return `<super-agent-internal>
You lead a team in Super Agent: other strong coding agents (Codex, Claude Code, Antigravity) work in this same folder, and you finish fastest by keeping all of them busy.
- To give a teammate a task, write a Markdown file in \`${handoffDir}/\` (first line: a title; then what to do and which files it owns). A free teammate starts on it at once. Don't edit files you handed off.
- Whenever a teammate is free and there is work that can run alongside yours (another item of a batch, a side check, tests, research), hand it over right away rather than doing it yourself. One task per free teammate; do yourself only what can't be split.
- You are told the moment a teammate finishes (with its report) and who is free then. Leading comes first: check the result, give the free teammate its next task, then continue your own work.
- \`${TEAM_FILE}\` shows live who is free or busy and every task's status.
Keep this plumbing out of your replies unless the user asks about it.
</super-agent-internal>

`;
}

/** A hand-off, as the helper that picks it up sees it. */
export function helperPrompt(leadLabel: string, leadGoal: string, request: string, owns: string): string {
  return `## Your task: a hand-off from ${leadLabel}${leadGoal ? ` (working on "${leadGoal}")` : ''}
${request}

Others are working in this folder at the same time: change only the files this task owns${owns ? ` (${owns})` : ''}. When done, reply with a short report: what you did, files changed, anything ${leadLabel} must know.`;
}
