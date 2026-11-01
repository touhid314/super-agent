import type { AgentKind } from '../../../super-agent/src/shared/types';

export interface ThreadMsg {
  at: number;
  role: 'user' | 'agent' | 'system';
  text: string;
  accountId?: string;
  /** Files the user attached (absolute paths, copied into the workspace's .super-agent/attachments). */
  attachments?: string[];
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
  /** Messages that arrived while busy and no other agent was free. */
  queue: string[];
  messages: ThreadMsg[];
  /** Thread this one was delegated from or helps. */
  parentId?: string;
  /** For helper threads: the hand-off request file the lead wrote. */
  helperFile?: string;
  runId?: string;
  runStartedAt?: number;
  lastLog?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EngineState {
  threads: Thread[];
  working: number;
}
