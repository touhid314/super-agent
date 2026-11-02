import type { AgentKind } from '../core/types';

export interface ThreadMsg {
  at: number;
  role: 'user' | 'agent' | 'system';
  text: string;
  accountId?: string;
  /** Files the user attached (absolute paths, copied into the workspace's .super-agent/attachments). */
  attachments?: string[];
  /** On the message that ended a turn: everything the agents did and said on the way (Codex-style "Worked for"). */
  activity?: string[];
  workedMs?: number;
  /** On the message that ended a turn: the files the turn changed (Codex-style "+12 -3"), undoable. */
  changes?: RunChanges;
}

/** What one turn changed in the workspace: snapshots before and after (tree ids in the hidden store) and per file. */
export interface RunChanges {
  before: string;
  after: string;
  files: { path: string; add: number; del: number; binary?: boolean }[];
  undone?: boolean;
}

/** The CLI conversation a thread lives in, so the next turn (or the next agent) keeps its full context. */
export interface ThreadSession {
  accountId: string;
  kind: AgentKind;
  id: string;
}

/**
 * A thread is one line of work led by one agent at a time. There is no master/worker split:
 * whoever leads a thread does the work, and can spin off helper threads for parallel pieces.
 */
export interface Thread {
  id: string;
  title: string;
  cwd: string;
  /** Agent currently leading (or last led) this thread. */
  leadId?: string;
  /** Agent the user picked explicitly; used whenever it has usage left. */
  pinnedLeadId?: string;
  session?: ThreadSession;
  /** working: an agent is on it; waiting: needs a free agent; idle: done, ready for the next message. */
  status: 'idle' | 'working' | 'waiting';
  /** Prompt to run as soon as an agent is free (waiting) */
  pending?: string;
  /** Everyone was out of usage: when the work resumes by itself (the soonest an agent gets usage back). */
  resumeAt?: number;
  /** Messages that arrived while busy and no other agent was free. */
  queue: string[];
  messages: ThreadMsg[];
  /** Thread this one was delegated from or helps. */
  parentId?: string;
  /**
   * The turn in progress: when it started and what was done/said so far (across restarts and report turns).
   * `before`: the files snapshot taken when it started (so an interrupted turn can still show its changes).
   */
  work?: { startedAt: number; items: string[]; before?: string };
  /** The run was stopped to take a new user message: it resumes at once instead of reporting "Stopped". */
  restarting?: boolean;
  /** The lead's turn ended while helpers still work: the final answer waits for them (status is 'waiting'). */
  awaitingHelpers?: boolean;
  /** Reports from finished helpers, folded into the next turn. */
  reports?: { by: string; title: string; text: string; file?: string }[];
  /** Set after a run ended with no answer and was handed to another agent; cleared by the next answer. */
  retried?: boolean;
  /** Set after this thread's CLI was updated for an "out of date" error (once per answer, so no update loops). */
  cliUpdated?: boolean;
  /** For helper threads: the hand-off request file the lead wrote. */
  helperFile?: string;
  runId?: string;
  runStartedAt?: number;
  lastLog?: string;
  createdAt: number;
  /** Last used: the last message from the user or an agent (status notes don't count). */
  updatedAt: number;
}

export interface EngineState {
  threads: Thread[];
  working: number;
}
