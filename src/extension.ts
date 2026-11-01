import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { AccountService } from '../../super-agent/src/main/agents/accounts';
import { ensureAgyBrowser } from '../../super-agent/src/main/agents/cli';
import { AccountPool } from '../../super-agent/src/main/agents/pool';
import { cancelRun, cancelAll, runAgent } from '../../super-agent/src/main/agents/runner';
import { UsageService } from '../../super-agent/src/main/agents/usage';
import { ConfigStore } from '../../super-agent/src/main/store/config';
import { paths } from '../../super-agent/src/main/store/paths';
import type { AgentKind } from '../../super-agent/src/shared/types';
import { Engine } from './engine/engine';
import { FileStore, TelegramRelay, uniqueIn } from './telegram';
import { listModels, modelInfo, type ModelOption } from './engine/models';
import type { Thread } from './engine/types';

let engine: Engine | undefined;
/** Agent (CLI) names, as shown in hovers and the Telegram bot. */
const AGENT_NAME: Record<AgentKind, string> = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' };

export function activate(context: vscode.ExtensionContext): void {
  // Electron hosts leak this into child processes, which would turn Node-based CLIs into plain node.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const config = new ConfigStore();
  const pool = new AccountPool();
  const accounts = new AccountService(config, pool, (title, hint, command, env) => {
    // Sign-in / install happen in a VS Code terminal with only this account's variables set.
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined && process.env[k] !== v) extra[k] = v;
    const term = vscode.window.createTerminal({ name: title, env: extra, shellPath: 'cmd.exe' });
    term.show();
    term.sendText(`echo ${hint.replace(/[&|<>^]/g, '')} & ${command}`);
  });
  accounts.refreshClis();
  accounts.bootstrap();

  let view: vscode.WebviewView | undefined;
  // Created once the engine exists; state pushes before that just report it as off.
  let telegram: TelegramRelay | undefined;
  // Each account's selectable models (Codex: its models cache; Claude: live list; Antigravity: `agy models`).
  // Declared early: usage refreshes can push state before the rest of activation has run.
  const modelOptions: Record<string, ModelOption[]> = {};
  const log = vscode.window.createOutputChannel('Super Agent');
  context.subscriptions.push(log);
  const post = (msg: unknown) => void view?.webview.postMessage(msg);
  const usage = new UsageService(config, { all: () => [] } as never, () => pushState());

  const decorations = new AgentDecorations();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'superAgent.focus';
  status.show();

  const cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  engine = new Engine({
    config,
    pool,
    dataDir: paths.data,
    cliPath: (k: AgentKind) => accounts.cliPath(k),
    runAgent: (req) => runAgent(req).finally(() => usage.soon(req.account.id)),
    cancelRun,
    usageLoad: (id) => usage.load(id),
    usageResetAt: (id) => usage.resetAt(id),
    autonomy: () => config.settings.autonomy,
    onChange: () => pushState(),
    onOutput: (threadId, text) => {
      post({ type: 'output', threadId, text });
      telegram?.onOutput(threadId, text);
    },
    onFinished: (t, outcome) => onFinished(t, outcome),
  });
  const eng = engine;
  // Usage refreshes push state, so they start only once the engine exists.
  void usage.refreshAll();
  const usageTimer = setInterval(() => void usage.refreshAll(), 5 * 60000);

  function onFinished(t: Thread, outcome: 'done' | 'failed'): void {
    if (config.settings.soundOnDone) post({ type: 'chime', kind: outcome === 'done' ? (t.helperFile ? 'task' : 'done') : 'failed' });
    void telegram?.onFinished(t, outcome).catch((e) => log.appendLine(`Telegram: ${e.message}`));
  }

  // ---------------------------------------------------------------- Telegram relay
  const TOKEN_KEY = 'superAgent.telegramToken';
  const modelName = (id?: string) => {
    const a = config.accounts.find((x) => x.id === id);
    return a ? modelInfo(a, modelOptions[a.id] ?? []).name : 'Agent';
  };
  // Shared by all VS Code windows: pairing code, paired chat, bot name.
  const tgStore = new FileStore(path.join(paths.data, 'telegram.json'));
  const relay = new TelegramRelay({
    engine: eng,
    store: tgStore,
    lockFile: path.join(paths.data, 'telegram.lock'),
    cwd,
    attachmentDir: () => {
      const folder = cwd();
      if (!folder) return undefined;
      const dir = path.join(folder, '.super-agent', 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    agentName: modelName,
    status: () =>
      config.accounts
        .filter((a) => a.role !== 'off')
        .map((a) => {
          const busy = (pool.get(a.id).busyRuns ?? 0) > 0 ? ' (working)' : '';
          const left = usage.all()[a.id]?.windows.map((w) => `${w.label} ${Math.round(100 - w.percent)}%`).join(', ');
          return `${a.role === 'master' ? '♛ ' : ''}${modelName(a.id)}${busy}${left ? ` · ${left} left` : ''}`;
        })
        .join('\n') || 'No agents on the team.',
    team: {
      members: () =>
        config.accounts.map((a) => {
          const st = pool.get(a.id);
          const windows = usage.all()[a.id]?.windows ?? [];
          const out = st.login === 'signed-out' ? 'signed out' : (st.cooldownUntil ?? 0) > Date.now() || usage.load(a.id) >= 100 ? 'out of usage for now' : undefined;
          return {
            id: a.id,
            agent: AGENT_NAME[a.kind],
            model: modelName(a.id),
            account: a.label.replace(/^[^·]+·\s*/, ''),
            onTeam: a.role !== 'off',
            lead: a.role === 'master',
            busy: (st.busyRuns ?? 0) > 0,
            out,
            usage: windows.length ? `${windows.map((w) => `${w.label} ${Math.round(100 - w.percent)}%`).join(' · ')} left` : undefined,
          };
        }),
      toggle: (id) => {
        accounts.toggleTeam(id);
        pushState();
      },
      makeLead: (id) => {
        accounts.setMaster(id);
        pushState();
      },
      models: async (id) => {
        const a = config.accounts.find((x) => x.id === id);
        if (!a) return [];
        if (!modelOptions[id]?.length) modelOptions[id] = await listModels(a, accounts.cliPath(a.kind)).catch(() => []);
        return modelOptions[id].map((o) => ({ id: o.id, name: o.name, current: a.model === o.id }));
      },
      setModel: (id, model) => {
        accounts.update(id, { model });
        pushState();
      },
    },
    log: (line) => log.appendLine(line),
    onChange: () => pushState(),
  });
  telegram = relay;
  const BOT_KEY = 'telegram.bot';
  let telegramError: string | undefined;
  void context.secrets.get(TOKEN_KEY).then(async (token) => {
    if (!token) return;
    // The QR code needs the bot's @name (older versions kept it per window).
    if (!tgStore.get(BOT_KEY)) tgStore.update(BOT_KEY, await relay.verify(token).catch(() => undefined));
    relay.start(token);
  });

  /** What the panel's Telegram card shows (the same in every window, from the shared store). */
  function telegramView() {
    const bot = tgStore.get<string>(BOT_KEY);
    const running = relay.state !== 'off' && relay.state !== 'error';
    const paired = relay.chatId !== undefined;
    const code = relay.pairCode;
    return {
      state: !running ? relay.state : !paired ? 'pairing' : relay.state === 'standby' ? 'standby' : 'on',
      bot,
      code: running && !paired ? code : undefined,
      // Scanning this opens the bot and sends "/start CODE", which pairs your chat.
      pairLink: running && !paired && bot && code ? `https://t.me/${bot}?start=${code}` : undefined,
      error: telegramError ?? relay.error,
    };
  }
  // Pairing can complete in another window; keep this panel's card current.
  let lastTelegram = '';
  const telegramTimer = setInterval(() => {
    const now = JSON.stringify(telegramView());
    if (now !== lastTelegram) {
      lastTelegram = now;
      pushState();
    }
  }, 3000);

  async function connectTelegram(raw: string): Promise<void> {
    const token = raw.trim();
    telegramError = undefined;
    if (!/^\d+:[\w-]{20,}$/.test(token)) {
      telegramError = 'That does not look like a bot token. It looks like 123456789:AAH… (BotFather sends it after /newbot).';
      return pushState();
    }
    let bot: string;
    try {
      bot = await relay.verify(token);
    } catch (e) {
      telegramError = `Telegram did not accept that token (${(e as Error).message}).`;
      return pushState();
    }
    if ((await context.secrets.get(TOKEN_KEY)) !== token) relay.unpair();
    await context.secrets.store(TOKEN_KEY, token);
    tgStore.update(BOT_KEY, bot);
    relay.start(token);
    pushState();
  }

  async function disconnectTelegram(): Promise<void> {
    relay.stop();
    relay.unpair();
    telegramError = undefined;
    await context.secrets.delete(TOKEN_KEY);
    tgStore.update(BOT_KEY, undefined);
    pushState();
  }

  const showTelegram = () => {
    void vscode.commands.executeCommand('superAgent.team.focus');
    setTimeout(() => post({ type: 'showTelegram' }), 300);
  };

  function pushState(): void {
    const working = eng.working;
    status.text = working ? `$(sync~spin) Super Agent: ${working} working` : '$(organization) Super Agent';
    status.tooltip = config.accounts
      .filter((a) => a.role !== 'off')
      .map((a) => {
        const u = usage.all()[a.id];
        const left = u?.windows.map((w) => `${w.label} ${Math.round(100 - w.percent)}% left`).join(', ');
        return `${a.label}${a.role === 'master' ? ' (preferred lead)' : ''}${left ? ` · ${left}` : ''}`;
      })
      .join('\n');
    decorations.update(eng, (id) => eng.label(id));
    // VS Code shows this as "Super Agent: Team Of n" in the panel's top bar.
    if (view) view.title = `Team of ${config.accounts.filter((a) => a.role !== 'off').length}`;
    post({
      type: 'state',
      state: {
        accounts: config.accounts,
        status: pool.all(),
        usage: usage.all(),
        clis: accounts.clis,
        threads: eng.threads.map((t) => ({ ...t, messages: t.messages.slice(-150) })),
        fileUris: fileUris(eng.threads.flatMap((t) => t.messages.flatMap((m) => m.attachments ?? []))),
        workspace: cwd() ?? null,
        soundOnDone: config.settings.soundOnDone,
        browserTools: config.settings.browserTools !== false,
        telegram: telegram ? telegramView() : { state: 'off' },
        models: Object.fromEntries(config.accounts.map((a) => [a.id, modelInfo(a, modelOptions[a.id] ?? [])])),
      },
    });
  }
  pool.onChange(() => pushState());

  const refreshModels = async () => {
    for (const a of config.accounts) modelOptions[a.id] = await listModels(a, accounts.cliPath(a.kind)).catch(() => []);
    pushState();
  };
  void refreshModels();

  /** Webview URLs for attached files, so images show as thumbnails. */
  function fileUris(files: string[]): Record<string, string> {
    return view ? Object.fromEntries(files.map((f) => [f, view!.webview.asWebviewUri(vscode.Uri.file(f)).toString()])) : {};
  }

  // Attachments are copied into the workspace so every agent (sandboxed or not) can read them.
  function attachmentDir(): string | undefined {
    const folder = cwd();
    if (!folder) {
      void vscode.window.showWarningMessage('Open a folder first: attachments are stored in the workspace for the agents.');
      return undefined;
    }
    const dir = path.join(folder, '.super-agent', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function attachFiles(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', defaultUri: cwd() ? vscode.Uri.file(cwd()!) : undefined });
    const dir = picked?.length ? attachmentDir() : undefined;
    if (!picked || !dir) return;
    const files = picked.map((u) => {
      const dest = uniqueIn(dir, u.fsPath);
      fs.copyFileSync(u.fsPath, dest);
      return dest;
    });
    post({ type: 'attached', files, uris: fileUris(files) });
  }

  function pasteFile(name: string, data: string): void {
    const dir = attachmentDir();
    if (!dir || typeof data !== 'string') return;
    const dest = uniqueIn(dir, name || `pasted-${Date.now()}.png`);
    fs.writeFileSync(dest, Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64'));
    post({ type: 'attached', files: [dest], uris: fileUris([dest]) });
  }

  // Antigravity keeps one MCP list per PC; add the browser there once (off the activation path).
  function registerAgyBrowser(): void {
    const agy = accounts.cliPath('antigravity');
    if (agy && config.accounts.some((a) => a.kind === 'antigravity')) setTimeout(() => ensureAgyBrowser(agy), 3000);
  }
  if (config.settings.browserTools !== false) registerAgyBrowser();

  async function pickModel(id: string): Promise<void> {
    const a = config.accounts.find((x) => x.id === id);
    if (!a) return;
    if (!modelOptions[id]?.length) modelOptions[id] = await listModels(a, accounts.cliPath(a.kind)).catch(() => []);
    const current = modelInfo(a, modelOptions[id]);
    const items = [
      { label: `${!a.model ? '$(check) ' : ''}CLI default`, description: current.isDefault ? current.name : '', id: '' },
      ...modelOptions[id].map((o) => ({ label: `${a.model === o.id ? '$(check) ' : ''}${o.name}`, description: o.id, detail: o.description, id: o.id })),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Model for ${a.label}`, matchOnDescription: true });
    if (!pick) return;
    accounts.update(id, { model: pick.id });
    pushState();
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'superAgent.team',
      {
        resolveWebviewView(v) {
          view = v;
          // Workspace folders too, so attached images can be shown as thumbnails.
          v.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)],
          };
          v.webview.html = html(v.webview, context.extensionUri);
          v.webview.onDidReceiveMessage((m) => handle(m));
          v.onDidDispose(() => (view = undefined));
          pushState();
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerFileDecorationProvider(decorations),
    status,
    vscode.commands.registerCommand('superAgent.focus', () => vscode.commands.executeCommand('superAgent.team.focus')),
    vscode.commands.registerCommand('superAgent.newThread', () => post({ type: 'newThread' })),
    vscode.commands.registerCommand('superAgent.history', async () => {
      const items = eng.threads.map((t) => ({
        label: `${t.status === 'working' ? '$(sync~spin) ' : t.status === 'waiting' ? '$(clock) ' : ''}${t.parentId ? '↳ ' : ''}${t.title}`,
        description: eng.label(t.leadId),
        detail: t.messages.filter((m) => m.role === 'agent').pop()?.text.slice(0, 120),
        id: t.id,
      }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: items.length ? 'Open a thread' : 'No threads yet', matchOnDetail: true });
      if (pick) post({ type: 'selected', threadId: pick.id });
    }),
    vscode.commands.registerCommand('superAgent.addAccount', () => addAccount()),
    vscode.commands.registerCommand('superAgent.importLogins', () => {
      const n = accounts.importDefaults();
      void refreshModels();
      void vscode.window.showInformationMessage(n ? `Super Agent: imported ${n} login(s).` : 'Super Agent: no new signed-in CLI logins found.');
      pushState();
    }),
    vscode.commands.registerCommand('superAgent.stopAll', () => eng.threads.forEach((t) => eng.stop(t.id))),
    vscode.commands.registerCommand('superAgent.connectTelegram', showTelegram),
    vscode.commands.registerCommand('superAgent.telegram', showTelegram),
    { dispose: () => clearInterval(usageTimer) },
    { dispose: () => relay.stop() },
    { dispose: () => clearInterval(telegramTimer) },
  );

  async function addAccount(): Promise<void> {
    const kinds: { label: string; agent: AgentKind }[] = [
      { label: 'Codex (OpenAI)', agent: 'codex' },
      { label: 'Claude Code (Anthropic)', agent: 'claude' },
      { label: 'Antigravity (Google)', agent: 'antigravity' },
    ];
    const pick = await vscode.window.showQuickPick(kinds, { placeHolder: 'Which agent account do you want to add?' });
    if (!pick) return;
    try {
      const acc = accounts.add(pick.agent, '');
      if (accounts.cliPath(pick.agent)) accounts.signIn(acc.id);
      else accounts.installCli(pick.agent);
    } catch (err) {
      void vscode.window.showErrorMessage(String((err as Error).message));
    }
    pushState();
  }

  function handle(m: any): void {
    const folder = cwd();
    switch (m.type) {
      case 'ready':
        return pushState();
      case 'pickModel':
        return void pickModel(m.id);
      case 'clientError': {
        const line = `[${new Date().toISOString()}] ${m.message}\n${m.stack ?? ''}\n\n`;
        log.appendLine(line);
        try {
          fs.appendFileSync(path.join(paths.data, 'vscode-errors.log'), line);
        } catch {
          /* best effort */
        }
        return;
      }
      case 'send':
        if (!folder) {
          void vscode.window.showWarningMessage('Open a folder first: Super Agent agents work in the open workspace folder.');
          return;
        }
        post({ type: 'selected', threadId: eng.send(m.threadId, m.text, folder, Array.isArray(m.attachments) ? m.attachments : []).id });
        return;
      case 'attach':
        return void attachFiles();
      case 'pasteFile':
        return pasteFile(m.name, m.data);
      case 'telegramConnect':
        return void connectTelegram(String(m.token ?? ''));
      case 'telegramDisconnect':
        return void disconnectTelegram();
      case 'openLink':
        // Only Telegram links (BotFather, your bot).
        if (typeof m.url === 'string' && /^https:\/\/t\.me\/[\w?=&/]+$/.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
      case 'toggleBrowser':
        config.saveSettings({ browserTools: !config.settings.browserTools });
        if (config.settings.browserTools) registerAgyBrowser();
        return pushState();
      case 'stop':
        return eng.stop(m.threadId);
      case 'setLead':
        return eng.setLead(m.threadId, m.accountId);
      case 'deleteThread':
        return eng.deleteThread(m.threadId);
      case 'toggleTeam':
        accounts.toggleTeam(m.id);
        return pushState();
      case 'setMaster':
        accounts.setMaster(m.id);
        return pushState();
      case 'signIn':
        return accounts.signIn(m.id);
      case 'addAccount':
        return void addAccount();
      case 'importLogins':
        return void vscode.commands.executeCommand('superAgent.importLogins');
      case 'refreshUsage':
        return void usage.refreshAll();
      case 'openFile':
        // Only files the user attached in this workspace.
        if (typeof m.path === 'string' && /[\\/]\.super-agent[\\/]attachments[\\/]/.test(m.path) && fs.existsSync(m.path))
          void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.path));
        return;
      case 'openLog': {
        const t = eng.get(m.threadId);
        if (t?.lastLog) void vscode.window.showTextDocument(vscode.Uri.file(t.lastLog), { preview: true });
        return;
      }
      case 'toggleSound':
        config.saveSettings({ soundOnDone: !config.settings.soundOnDone });
        return pushState();
    }
  }
}

export function deactivate(): void {
  cancelAll();
  engine?.dispose();
}

/** Marks files changed while agents work (VS Code's own explorer shows them with the agent's name). */
class AgentDecorations implements vscode.FileDecorationProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private marks = new Map<string, string>();
  private watcher = vscode.workspace.createFileSystemWatcher('**/*');
  private who = '';

  constructor() {
    const mark = (uri: vscode.Uri) => {
      if (!this.who || /[\\/](\.git|node_modules|\.super-agent)[\\/]/.test(uri.fsPath)) return;
      this.marks.set(uri.toString(), this.who);
      this.emitter.fire(uri);
    };
    this.watcher.onDidChange(mark);
    this.watcher.onDidCreate(mark);
  }

  update(engine: Engine, label: (id?: string) => string): void {
    const working = engine.threads.filter((t) => t.status === 'working');
    this.who = working.map((t) => label(t.leadId)).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const who = this.marks.get(uri.toString());
    return who ? { badge: '●', tooltip: `Changed by ${who} (Super Agent)`, color: new vscode.ThemeColor('charts.blue') } : undefined;
  }
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const js = webview.asWebviewUri(vscode.Uri.joinPath(root, 'media', 'webview.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(root, 'media', 'webview.css'));
  const nonce = Math.random().toString(36).slice(2);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${css}"></head><body><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
}
