/**
 * Speed test: one agent vs. the whole team on the same parallelizable task, with the real engine, hot runner and
 * accounts (low reasoning effort, browser off, nothing saved to your settings). Workspaces go to the OS temp folder;
 * results (JSON) go to evaluation/results/.
 *
 *   npx esbuild evaluation/speed-test.ts --bundle --platform=node --format=esm --outfile=evaluation/.out/speed-test.mjs
 *   node evaluation/.out/speed-test.mjs solo|army code|docs|tools [lead-account-label]
 *
 * code: 8 small Python modules + tests (each item is quick) · docs: 6 ~250-word explainers (each item is real writing)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCli } from '../src/core/agents/cli';
import { HotAgents } from '../src/core/agents/hot';
import { AccountPool } from '../src/core/agents/pool';
import { UsageService } from '../src/core/agents/usage';
import { configureLog } from '../src/core/log';
import { ConfigStore } from '../src/core/store/config';
import { Engine } from '../src/engine/engine';

const MODULES = ['primes (is_prime)', 'fib (fibonacci)', 'palindrome (is_palindrome)', 'gcd (gcd)', 'roman (to_roman)', 'anagram (is_anagram)', 'wordcount (word_count)', 'binary (to_binary)'];
const TOPICS = ['TCP congestion control', 'B-tree indexes', 'garbage collection', 'consistent hashing', 'Bloom filters', 'the Raft consensus algorithm'];
const TOOLS = [
  'calc: an arithmetic expression evaluator (+ - * / parentheses, operator precedence, no eval())',
  'ini: an INI file parser (sections, key=value, comments, typed get_int/get_bool)',
  'csvstats: per-column mean, median and standard deviation for a CSV file',
  'rle: run-length encode/decode for strings, round-trip safe when the input contains digits',
  'mdtable: format a list of rows as an aligned Markdown table with left/right/center alignment',
];
const tick = '`';
const TASKS = {
  code: `Build a small Python library in this folder. Create these 8 independent modules in ${tick}lib/${tick}: ${MODULES.map((m) => `${tick}${m.split(' ')[0]}.py${tick} ${m.slice(m.indexOf('('))}`).join(', ')}. Each module: the function with a docstring. For each module also write ${tick}tests/test_<module>.py${tick} with at least 4 plain-assert checks that imports from lib (add lib to sys.path), and run it with python until it passes. Then reply with which tests pass.`,
  tools: `Build 5 independent mini-tools in Python, each in its own folder ${tick}tools/<name>/${tick} with ${tick}<name>.py${tick} and ${tick}test_<name>.py${tick} (at least 6 plain-assert checks, covering edge cases), runnable from that folder as ${tick}python test_<name>.py${tick}: ${TOOLS.join('; ')}. Run each test file until it passes. Then reply with which tests pass.`,
  docs: `Write 6 independent technical explainers in ${tick}docs/${tick}, one Markdown file each: ${TOPICS.map((t, i) => `${tick}docs/topic${i + 1}.md${tick} on ${t}`).join(', ')}. Each must be about 250 words (at least 200), with a title, a short intuition, how it works, and one trade-off. Then reply with the list of files.`,
};

const mode = process.argv[2] === 'solo' ? 'solo' : 'army';
const task: keyof typeof TASKS = (['docs', 'tools'] as const).find((x) => x === process.argv[3]) ?? 'code';
const leadLabel = process.argv[4] ?? 'Codex · mdtouhidul.islam';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = fs.mkdtempSync(path.join(os.tmpdir(), `sa-speed-${task}-${mode}-`));
const cwd = path.join(root, 'ws');
fs.mkdirSync(cwd);
const logFile = configureLog(root);

const config = new ConfigStore();
const lead = config.accounts.find((a) => a.label === leadLabel);
if (!lead) throw new Error(`No account "${leadLabel}"`);
for (const a of config.accounts) {
  a.effort = 'low'; // in memory only: never saved
  a.role = a === lead ? 'master' : mode === 'solo' ? 'off' : a.role === 'off' ? 'off' : 'worker';
}
const pool = new AccountPool();
const usage = new UsageService(config, { all: () => [] }, () => undefined);
await usage.refreshAll();
// Accounts out of usage can't take part (same in both setups).
for (const a of config.accounts) if (a !== lead && usage.load(a.id) >= 100) a.role = 'off';
const team = config.accounts.filter((a) => a.role !== 'off');
const clis = Object.fromEntries((['codex', 'claude', 'antigravity'] as const).map((k) => [k, resolveCli(k).path ?? null]));
const hot = new HotAgents(root);
hot.warm(team.flatMap((account) => (clis[account.kind] ? [{ account, cliPath: clis[account.kind]! }] : [])), { cwd, autonomy: 'standard', browser: false });

const runs: { who: string; kind: string; helper: boolean; title: string; start: number; end?: number; ok?: boolean }[] = [];
let engine!: Engine;
engine = new Engine({
  config: Object.assign(Object.create(Object.getPrototypeOf(config)), config, { settings: { ...config.settings, browserTools: false, taskTimeoutMin: 15 } }),
  pool,
  dataDir: root,
  cliPath: (k) => clis[k],
  runAgent: async (req) => {
    const t = engine.threads.find((x) => x.runId === req.runId);
    const r = { who: req.account.label, kind: req.account.kind, helper: !!t?.helperFile, title: t?.title ?? '', start: Date.now() } as (typeof runs)[number];
    runs.push(r);
    const res = await hot.run(req);
    r.end = Date.now();
    r.ok = !!res.finalText && !res.cancelled;
    return res;
  },
  cancelRun: (id) => void hot.cancel(id),
  steer: (id, text, label) => hot.steer(id, text, label),
  usageLoad: (id) => usage.load(id),
  usageResetAt: (id) => usage.resetAt(id),
  autonomy: () => 'standard',
  onChange: () => undefined,
  onOutput: () => undefined,
  onFinished: () => undefined,
});

console.log(`${task}/${mode}: team = ${team.map((a) => a.label).join(', ')}`);
await new Promise((r) => setTimeout(r, 15000)); // let the hot agents finish starting (not counted)
const t0 = Date.now();
const thread = engine.send(undefined, TASKS[task], cwd);
let tEnd = 0;
for (let i = 0; i < 15 * 60 * 2 && !tEnd; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (thread.status === 'idle' && thread.messages.some((m) => m.role === 'agent') && engine.threads.every((x) => x.status === 'idle')) tEnd = Date.now();
}
const wall = ((tEnd || Date.now()) - t0) / 1000;

// Check the result ourselves: run every test file (code) / count words in every explainer (docs).
const dir = path.join(cwd, task === 'docs' ? 'docs' : task === 'tools' ? 'tools' : 'tests');
const files = !fs.existsSync(dir)
  ? []
  : task === 'tools'
    ? fs.readdirSync(dir).flatMap((d) => (fs.existsSync(path.join(dir, d, `test_${d}.py`)) ? [path.join(d, `test_${d}.py`)] : []))
    : fs.readdirSync(dir).filter((f) => (task === 'docs' ? /^topic\d+\.md$/ : /^test_.*\.py$/).test(f));
const passed = files.filter((f) => {
  if (task === 'docs') return fs.readFileSync(path.join(dir, f), 'utf8').split(/\s+/).filter(Boolean).length >= 200;
  try {
    execFileSync('python', [path.basename(f)], { cwd: path.dirname(path.join(dir, f)), stdio: 'ignore', timeout: 60000 });
    return true;
  } catch {
    return false;
  }
});
const expected = task === 'docs' ? TOPICS.length : task === 'tools' ? TOOLS.length : MODULES.length;

const rel = (ms: number) => Math.round((ms - t0) / 100) / 10;
const result = {
  task,
  mode,
  date: new Date().toISOString(),
  lead: lead.label,
  team: team.map((a) => a.label),
  effort: 'low',
  finished: !!tEnd,
  wallSeconds: Math.round(wall * 10) / 10,
  firstHandoffSeconds: (() => {
    const h = runs.find((r) => r.helper);
    return h ? rel(h.start) : null;
  })(),
  checks: { found: files.length, passed: passed.length, expected },
  runs: runs.map((r) => ({ ...r, start: rel(r.start), end: r.end ? rel(r.end) : null })),
  agents: team.map((a) => {
    const mine = runs.filter((r) => r.who === a.label);
    const busy = mine.reduce((n, r) => n + ((r.end ?? Date.now()) - r.start), 0) / 1000;
    return { agent: a.label, runs: mine.length, helperTasks: mine.filter((r) => r.helper).length, busySeconds: Math.round(busy), utilization: Math.round((100 * busy) / wall) };
  }),
  finalAnswer: thread.messages.filter((m) => m.role === 'agent').at(-1)?.text ?? null,
  log: logFile,
};
const out = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'results');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `${task}-${mode}-${stamp}.json`), JSON.stringify(result, null, 2));
console.log(`${task}/${mode}: ${result.wallSeconds}s, checks ${passed.length}/${expected} pass, first hand-off ${result.firstHandoffSeconds ?? '-'}s`);
for (const a of result.agents) console.log(`  ${a.agent.padEnd(28)} runs ${a.runs}  helper tasks ${a.helperTasks}  busy ${a.busySeconds}s (${a.utilization}%)`);
engine.dispose();
hot.dispose();
process.exit(0);
