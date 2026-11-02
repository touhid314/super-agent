// Domain types shared by the main process (orchestrator) and the renderer (UI).

export type AgentKind = 'codex' | 'claude' | 'antigravity';
export const AGENT_KINDS: AgentKind[] = ['codex', 'claude', 'antigravity'];

export type AccountRole = 'master' | 'worker' | 'off';
export type Autonomy = 'standard' | 'full';

export interface Account {
  id: string;
  kind: AgentKind;
  label: string;
  /** Config home for this account. null = the CLI's default login (~/.codex, ~/.claude, Antigravity's own). */
  home: string | null;
  role: AccountRole;
  model?: string;
  /** Reasoning effort (low · medium · high · xhigh · max); unset: the CLI's default. */
  effort?: string;
  createdAt: number;
}

export type LoginState = 'signed-in' | 'signed-out' | 'unknown';

export interface AccountStatus {
  login: LoginState;
  email?: string;
  busyRuns: number;
  cooldownUntil?: number;
  lastError?: string;
  verifying?: boolean;
}

/** One rate-limit window as reported by the provider (e.g. Codex 5h / weekly, Claude session / weekly). */
export interface UsageWindow {
  label: string;
  percent: number;
  resetsAt?: number;
}

export interface AccountUsage {
  windows: UsageWindow[];
  plan?: string;
  /** When the numbers were measured (Codex: time of its last run; Claude: time of the last query). */
  measuredAt?: number;
  /** Agent runs Super-Agent started on this account today. */
  runsToday: number;
  note?: string;
}

export interface CliInfo {
  kind: AgentKind;
  path: string | null;
  version?: string;
}

export interface Settings {
  workspaceRoot: string;
  autonomy: Autonomy;
  requirePlanApproval: boolean;
  masterReview: boolean;
  workspace: WorkspaceMode;
  /** Chime + desktop notification when agents finish work. */
  soundOnDone: boolean;
  /** Give agents a browser (Playwright MCP): open pages, click, fill forms, take screenshots. */
  browserTools: boolean;
  /** Keep agent CLIs running between messages (no startup lag); false: start a fresh process per turn. */
  hotAgents?: boolean;
  maxFixAttempts: number;
  taskTimeoutMin: number;
  verifyTimeoutMin: number;
  cliPaths: Partial<Record<AgentKind, string>>;
}

// ---------- Plan / tasks ----------

export interface PlannedTask {
  id: string;
  title: string;
  goal: string;
  /** Glob patterns (repo-relative, forward slashes) this task may modify. */
  owns: string[];
  depends_on: string[];
  /** Shell command run in the task's worktree; must exit 0 for the task to be accepted. */
  verify?: string;
  /** Optional preference for which CLI should do the task. */
  agent?: AgentKind | 'any';
}

/**
 * delegate: the work doesn't benefit from splitting, so one worker gets the whole request.
 * parallel: independent parts run side by side according to the task graph.
 */
export type PlanMode = 'delegate' | 'parallel';

export interface Plan {
  summary: string;
  mode: PlanMode;
  /** The master's reason for delegating vs. parallelizing. */
  reason?: string;
  tasks: PlannedTask[];
}

export type TaskStatus =
  | 'pending' // dependencies not merged yet
  | 'ready' // waiting for a free worker
  | 'running' // worker agent is executing
  | 'verifying' // running verify command
  | 'reviewing' // master is reviewing the diff
  | 'queued' // waiting in the merge queue
  | 'merging'
  | 'merged'
  | 'failed'
  | 'blocked' // a dependency failed
  | 'cancelled';

export interface WorkerReport {
  status: 'done' | 'blocked';
  summary: string;
  notes?: string;
  needs?: string[];
}

export interface TaskRun {
  runId: string;
  accountId: string;
  kind: 'work' | 'fix' | 'conflict';
  startedAt: number;
  endedAt?: number;
  outcome?: 'ok' | 'error' | 'rate-limited' | 'signed-out' | 'cancelled' | 'interrupted';
}

export interface TaskState extends PlannedTask {
  status: TaskStatus;
  round: number;
  attempts: number;
  /** Feedback the next attempt must address (verify failure, review notes, conflicts, scope violations). */
  feedback?: string;
  report?: WorkerReport;
  branch?: string;
  worktree?: string;
  changedFiles?: string[];
  mergeCommit?: string;
  error?: string;
  runs: TaskRun[];
  triedAccounts: string[];
  /** Set when the previous agent ran out of usage mid-task; the next agent continues its work. */
  handoffFrom?: string;
  updatedAt: number;
}

export type JobStatus =
  | 'planning'
  | 'awaiting-approval'
  | 'running'
  | 'summarizing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface MasterRun {
  runId: string;
  purpose: 'plan' | 'review' | 'summary' | 'followup';
  accountId: string;
  taskId?: string;
  startedAt: number;
  endedAt?: number;
  outcome?: TaskRun['outcome'];
}

export interface JobState {
  id: string;
  title: string;
  request: string;
  repo: string;
  baseBranch: string;
  /** HEAD of the base branch when the job started; the explorer diffs against it. */
  baseCommit: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  plan?: Plan;
  planFeedback?: string;
  round: number;
  tasks: TaskState[];
  masterRuns: MasterRun[];
  summary?: string;
  error?: string;
  timeline: TimelineEntry[];
  options: JobOptions;
  /** Messages the user sent to the team after the initial request. */
  messages: UserMessage[];
  /** Direct answers from the master (chat, questions) that needed no plan or workers. */
  replies: MasterReply[];
  /** Round at which the latest user message started a new cycle (limits automatic follow-ups). */
  roundBase: number;
}

export interface UserMessage {
  at: number;
  text: string;
}

export interface MasterReply {
  at: number;
  text: string;
  accountId?: string;
}

/**
 * shared: every agent works directly in the project folder at the same time (non-overlapping files),
 *         and each finished task is committed on its own. Live and fast.
 * isolated: each task runs in its own git worktree and is merged through a serial queue.
 */
export type WorkspaceMode = 'shared' | 'isolated';

export interface JobOptions {
  requirePlanApproval: boolean;
  masterReview: boolean;
  /** Missing on jobs created before shared mode existed; those used isolated worktrees. */
  workspace?: WorkspaceMode;
}

export interface TimelineEntry {
  at: number;
  level: 'info' | 'success' | 'warn' | 'error';
  text: string;
  taskId?: string;
  /** The agent this entry is about (shown as the speaker in the team chat). */
  accountId?: string;
}

// ---------- IPC ----------

export interface AppSnapshot {
  accounts: Account[];
  status: Record<string, AccountStatus>;
  usage: Record<string, AccountUsage>;
  clis: CliInfo[];
  jobs: JobState[];
  settings: Settings;
  dataDir: string;
}

export interface NewJobInput {
  request: string;
  title?: string;
  /** Existing folder; if omitted, a new folder named `newName` is created under the workspace root. */
  projectPath?: string;
  newName?: string;
  options: JobOptions;
}

export interface LogChunk {
  runId: string;
  text: string;
}

// ---------- File explorer ----------

export interface DirEntry {
  name: string;
  /** Repo-relative path with forward slashes. */
  path: string;
  dir: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  text: string;
}

export type ChangeKind = 'A' | 'M' | 'D' | 'R' | 'U';

export interface FileChange {
  path: string;
  kind: ChangeKind;
}

/** A browsable root: the job's main repo, or one agent's worktree. */
export interface ExplorerRoot {
  id: string;
  label: string;
  path: string;
  /** Commit to diff against (job start for main repo, branch point for a worktree). */
  base: string;
  taskId?: string;
  accountId?: string;
}

export interface LiveEdit {
  path: string;
  taskId: string;
  accountId?: string;
}

export interface SuperAgentApi {
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(cb: (s: AppSnapshot) => void): () => void;
  onLog(cb: (c: LogChunk) => void): () => void;
  getLog(runId: string): Promise<string>;

  addAccount(kind: AgentKind, label: string): Promise<Account>;
  signIn(accountId: string): Promise<void>;
  verifyAccount(accountId: string): Promise<void>;
  removeAccount(accountId: string): Promise<void>;
  updateAccount(accountId: string, patch: Partial<Pick<Account, 'label' | 'role' | 'model'>>): Promise<void>;
  /** One click: make this account the master (the previous master stays on the team as a worker). */
  setMaster(accountId: string): Promise<void>;
  /** One click: add the account to the team (worker) or take it off the team. */
  toggleTeam(accountId: string): Promise<void>;
  sendMessage(jobId: string, text: string): Promise<void>;
  refreshUsage(): Promise<void>;
  importDefaults(): Promise<number>;
  installCli(kind: AgentKind): Promise<void>;
  refreshClis(): Promise<void>;

  createJob(input: NewJobInput): Promise<string>;
  approvePlan(jobId: string): Promise<void>;
  revisePlan(jobId: string, feedback: string): Promise<void>;
  cancelJob(jobId: string): Promise<void>;
  deleteJob(jobId: string): Promise<void>;
  retryTask(jobId: string, taskId: string): Promise<void>;

  explorerRoots(jobId: string): Promise<ExplorerRoot[]>;
  listDir(rootPath: string, rel: string): Promise<DirEntry[]>;
  readFile(rootPath: string, rel: string): Promise<FileContent>;
  fileChanges(rootPath: string, base: string): Promise<FileChange[]>;
  liveEdits(jobId: string): Promise<LiveEdit[]>;
  diffFile(rootPath: string, rel: string, base: string): Promise<string>;
  watchRoot(rootPath: string): Promise<void>;
  onFsChange(cb: (rootPath: string) => void): () => void;

  updateSettings(patch: Partial<Settings>): Promise<void>;
  pickFolder(): Promise<string | null>;
  openPath(p: string): Promise<void>;
}
