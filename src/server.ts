import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AccountService } from './core/agents/accounts';
import { CLI_META, ensureAgyBrowser } from './core/agents/cli';
import { CommandCatalog } from './core/agents/commands';
import { HotAgents } from './core/agents/hot';
import { AccountPool } from './core/agents/pool';
import { cancelAll, cancelRun, runAgent } from './core/agents/runner';
import { CliUpdater } from './core/agents/updater';
import { UsageService } from './core/agents/usage';
import { ConfigStore } from './core/store/config';
import { paths } from './core/store/paths';
import { configureLog, log } from './core/log';
import { ChangeTracker } from './engine/changes';
import { Engine } from './engine/engine';
import { listModels, modelInfo, type ModelOption } from './engine/models';
import { FileStore, TelegramRelay } from './telegram';

export const HELP = `Super Agent server (Node.js 22+)

Usage: node dist/server.cjs --workspace /absolute/path/to/project

Configure accounts in Super Agent using VS Code Remote SSH first, then stop its
team before running the server. Set SUPER_AGENT_TELEGRAM_TOKEN to a bot token.
SUPER_AGENT_HOME optionally selects the account/configuration directory.
Threads, pairing and logs are stored separately under <SUPER_AGENT_HOME>/server.
Use a separate Telegram bot from your VS Code relay.
`;

export function serverOptions(args: string[], env: NodeJS.ProcessEnv = process.env): { workspace: string; token: string } | undefined {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return undefined;
  if (args.length !== 2 || args[0] !== '--workspace' || !path.isAbsolute(args[1])) {
    throw new Error('Provide --workspace with an absolute project folder. Use --help for setup.');
  }
  const workspace = fs.realpathSync(args[1]);
  if (!fs.statSync(workspace).isDirectory()) throw new Error('The workspace must be a directory.');
  const token = env.SUPER_AGENT_TELEGRAM_TOKEN?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Set SUPER_AGENT_TELEGRAM_TOKEN to a valid Telegram bot token.');
  return { workspace, token };
}

/** One engine per server data directory; a dead owner's lock can be reclaimed. */
export function acquireServerLock(dir: string): () => void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'server.lock');
  const owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, owner, { flag: 'wx', mode: 0o600 });
      return () => {
        try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); } catch { /* already removed */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let old: string;
      let pid: number;
      try {
        old = fs.readFileSync(file, 'utf8');
        pid = JSON.parse(old).pid;
      } catch {
        throw new Error(`Server lock is unreadable: ${file}. Stop any running server before removing it.`);
      }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid server lock: ${file}. Stop any running server before removing it.`);
      try { process.kill(pid, 0); } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH' && fs.readFileSync(file, 'utf8') === old) {
          fs.unlinkSync(file);
          continue;
        }
      }
      throw new Error(`A Super Agent server already owns ${dir} (PID ${pid}).`);
    }
  }
  throw new Error(`Could not acquire the server lock in ${dir}.`);
}

/** The daemon shares configured accounts with VS Code, but owns its threads and relay. */
export async function startServer(options: { workspace: string; token: string }, onShutdownReady?: (stop: () => void) => void): Promise<() => void> {
  // Agent tools inherit process.env; keep the relay secret only in this closure.
  delete process.env.SUPER_AGENT_TELEGRAM_TOKEN;
  const dir = path.join(paths.data, 'server');
  const release = acquireServerLock(dir);
  let shutdown = release;
  try {
    configureLog(dir, (line) => console.log(line.replaceAll(options.token, '[redacted]')));
    const config = new ConfigStore();
    const pool = new AccountPool();
    const accounts = new AccountService(config, pool, () => { throw new Error('Sign in using VS Code Remote SSH before starting the server.'); });
    accounts.refreshClis();
    accounts.bootstrap();
    if (!config.accounts.some((a) => a.role !== 'off' && pool.get(a.id).login !== 'signed-out' && accounts.cliPath(a.kind))) {
      throw new Error('No usable team accounts. Add and sign in to an account using Super Agent in VS Code Remote SSH on this server first.');
    }
    const hot = new HotAgents(dir);
    let relay: TelegramRelay | undefined;
    let engine: Engine | undefined;
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    let unsubscribe = () => undefined as void;
    shutdown = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      unsubscribe();
      relay?.stop();
      cancelAll();
      hot.dispose();
      engine?.dispose();
      release();
    };
    const usage = new UsageService(config, { all: () => [] }, () => engine?.usageChanged());
    const catalog = new CommandCatalog();
    const models: Record<string, ModelOption[]> = {};
    const name = (id?: string) => {
      const a = config.account(id ?? '');
      return a ? modelInfo(a, models[a.id] ?? []).name : 'Agent';
    };
    // Keep a ready process per team member, as the extension does: otherwise each new conversation pays the CLI's
    // cold start (and the browser MCP's npx start), which takes many seconds on a server.
    const warmTeam = () => {
      if (config.settings.hotAgents === false) return;
      const team = config.accounts.filter((a) => a.role !== 'off' && pool.get(a.id).login !== 'signed-out').flatMap((account) => {
        const cliPath = accounts.cliPath(account.kind);
        return cliPath ? [{ account, cliPath }] : [];
      });
      hot.warm(team, { cwd: options.workspace, autonomy: config.settings.autonomy, browser: true });
    };
    const updater = new CliUpdater((k) => accounts.cliPath(k), {
      before: (k) => hot.pause(k),
      after: (k) => { accounts.refreshClis(); hot.resume(k); warmTeam(); },
    });
    engine = new Engine({
      config, pool, dataDir: dir, changes: new ChangeTracker(dir),
      cliPath: (kind) => accounts.cliPath(kind),
      runAgent: (req) => (config.settings.hotAgents === false ? runAgent(req) : hot.run(req)).finally(() => usage.soon(req.account.id)),
      cancelRun: (id) => void (hot.cancel(id) || cancelRun(id)),
      steer: (id, text, label) => hot.steer(id, text, label),
      usageLoad: (id) => usage.load(id), usageResetAt: (id) => usage.resetAt(id),
      refreshUsage: (id) => usage.refresh(id, true), updateCli: (kind) => updater.update(kind),
      autonomy: () => config.settings.autonomy,
      onChange: () => undefined,
      onOutput: (id, text) => relay?.onOutput(id, text),
      onFinished: (t, outcome) => { void relay?.onFinished(t, outcome).catch(() => log('server', 'Could not deliver a Telegram reply.')); },
      onApproval: (t) => { void relay?.onApproval(t).catch(() => log('server', 'Could not deliver a Telegram approval request.')); },
    });
    const eng = engine;
    hot.onWake = (w) => void eng.wake(w.account.id, w.sessionId);
    hot.onBackground = (b) => eng.backgroundTasks(b.account.id, b.sessionId, b.tasks);
    const changed = () => { warmTeam(); eng.teamChanged(); };
    unsubscribe = pool.onChange(changed);
    const store = new FileStore(path.join(dir, 'telegram.json'));
    relay = new TelegramRelay({
      engine: eng, store, lockFile: path.join(dir, 'telegram.lock'),
      cwd: () => options.workspace,
      attachmentDir: () => {
        const attachments = path.join(dir, 'attachments');
        fs.mkdirSync(attachments, { recursive: true });
        return attachments;
      },
      agentName: name,
      isLeadCommand: async (id, command) => {
        const a = eng.commandAccountFor(id);
        return !!a && (await catalog.list(a, accounts.cliPath(a.kind), options.workspace)).some((c) => c.name === command && c.source === 'cli');
      },
      team: {
        members: () => config.accounts.map((a) => {
          const status = pool.get(a.id);
          return {
            id: a.id, agent: CLI_META[a.kind].name, model: name(a.id), account: a.label,
            onTeam: a.role !== 'off', lead: a.role === 'master', busy: status.busyRuns > 0,
            out: status.login === 'signed-out' ? 'signed out' : (status.cooldownUntil ?? 0) > Date.now() || usage.load(a.id) >= 100 ? 'out of usage for now' : undefined,
          };
        }),
        toggle: (id) => { accounts.toggleTeam(id); changed(); },
        makeLead: (id) => { accounts.setMaster(id); changed(); },
        models: async (id) => {
          const a = config.account(id);
          if (!a) return [];
          models[id] = await listModels(a, accounts.cliPath(a.kind)).catch(() => []);
          return models[id].map((m) => ({ id: m.id, name: m.name, current: a.model === m.id }));
        },
        setModel: (id, model) => { accounts.update(id, { model }); changed(); },
      },
      log: (line) => log('telegram', line.replaceAll(options.token, '[redacted]')),
      onChange: () => undefined,
    });
    // Verify before polling so invalid tokens fail clearly and systemd can restart.
    onShutdownReady?.(shutdown);
    const bot = await relay.verify(options.token);
    relay.start(options.token);
    console.log(`Super Agent server: ${options.workspace}`);
    console.log(`Telegram: @${bot}`);
    if (relay.pairCode) console.log(`Pair your phone: https://t.me/${bot}?start=${relay.pairCode}`);
    else console.log('Telegram is already paired.');
    warmTeam();
    void usage.refreshAll().catch(() => log('server', 'Usage refresh failed.'));
    timer = setInterval(() => {
      accounts.refreshAll();
      warmTeam();
      void usage.refreshAll().catch(() => log('server', 'Usage refresh failed.'));
    }, 5 * 60000);
    const agy = accounts.cliPath('antigravity');
    if (agy && config.accounts.some((a) => a.kind === 'antigravity' && a.role !== 'off')) ensureAgyBrowser(agy);
    return shutdown;
  } catch (err) {
    shutdown();
    throw new Error((err as Error).message.replaceAll(options.token, '[redacted]'));
  }
}

async function main(): Promise<void> {
  const options = serverOptions(process.argv.slice(2));
  if (!options) return void console.log(HELP);
  let stop: (() => void) | undefined;
  const end = () => { stop?.(); process.exit(0); };
  // Register before network startup so systemd can stop during token verification.
  process.once('SIGTERM', end);
  process.once('SIGINT', end);
  stop = await startServer(options, (ready) => { stop = ready; });
}

if (typeof require !== 'undefined' && require.main === module) {
  void main().catch((err: Error) => {
    // Do not print HTTP request URLs, which can contain a bot token.
    const token = process.env.SUPER_AGENT_TELEGRAM_TOKEN;
    console.error(`Super Agent server: ${token ? err.message.replaceAll(token, '[redacted]') : err.message}`);
    process.exitCode = 1;
  });
}
