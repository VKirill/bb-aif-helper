/**
 * Waiting for a worker thread without gaps. The coordinator model used to poll with `bb thread wait` and
 * `bb thread output`; between two commands a worker could resume, finish or fail unseen (Antigravity ends a
 * turn while its tests run in the background and resumes by itself). Here every answer carries the event
 * cursor `seq`, and the next call looks at what happened after it, so nothing between calls is lost.
 */
import type { BbPluginApi } from '@get-bb/plugin-sdk';

type Threads = Pick<BbPluginApi['sdk']['threads'], 'get' | 'wait' | 'output' | 'events' | 'queuedMessages'>;
type Row = { seq: number | string; type: string; createdAt: number | string; data?: unknown };
export type WorkerWait = {
  /** working: still busy; idle: its last turn ended; stopped: its last turn was stopped; failed: BB reports an error that no retry cleared. */
  state: 'working' | 'idle' | 'stopped' | 'failed';
  /** Pass as `--after` to the next call. */
  seq: number;
  /** A turn started after the previous cursor. */
  resumed: boolean;
  /** Time since its last turn ended, while idle. */
  idleForMs: number | null;
  output: string | null;
};

const busy = (status: string) => ['active', 'starting', 'pending'].includes(status);
const LIFECYCLE = ['turn/started', 'turn/completed', 'system/thread/interrupted'] as const;
const stop = (e: Row) => e.type === 'system/thread/interrupted' || (e.type === 'turn/completed' && (e.data as { status?: string } | undefined)?.status === 'interrupted');

type Options = { budgetMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };

/** One answer within `budgetMs`, so a CLI call never hits BB's command timeout. */
export async function waitWorker(threads: Threads, threadId: string, after: number,
  { budgetMs = 90_000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }: Options = {}): Promise<WorkerWait> {
  const deadline = now() + budgetMs;
  const left = () => Math.max(0, deadline - now());
  const startedAfter = async () => (await threads.events.list({ threadId, afterSeq: String(after), types: ['turn/started'], order: 'asc', limit: '1' }) as Row[]).length > 0;
  const untilIdle = () => threads.wait({ threadId, status: 'idle', timeoutMs: left() }).catch(() => undefined);
  // BB's own retry waits in the thread's queue; an exhausted one never runs again.
  const retrying = async () => (await threads.queuedMessages.list({ threadId })).some(m => m.state !== 'failed_exhausted');

  let first = await threads.get({ threadId });
  // BB may queue its retry a moment after the error shows: look again every second within the budget.
  while (first.status === 'error' && !(await retrying()) && left() > 0) { await sleep(Math.min(1000, left())); first = await threads.get({ threadId }); }
  if (busy(first.status) || first.status === 'error') await untilIdle();
  else if (first.status === 'idle' && !(await startedAfter())) {
    // Idle since the last look: give it the budget to resume by itself.
    if (await threads.events.wait({ threadId, afterSeq: String(after), type: 'turn/started', waitMs: String(left()) })) await untilIdle();
  }
  // The cursor is taken before the state is read: anything that happens after it is seen by the next call.
  const [last] = await threads.events.list({ threadId, order: 'desc', limit: '1' }) as Row[];
  const seq = Math.max(after, Number(last?.seq ?? 0));
  const read = async () => {
    const thread = await threads.get({ threadId });
    const newest = async (type: typeof LIFECYCLE[number]) => (await threads.events.list({ threadId, types: [type], order: 'desc', limit: '1' }) as Row[])[0];
    const [start, end, interrupt] = await Promise.all(LIFECYCLE.map(newest));
    return { thread, start, end, interrupt, queued: await retrying() };
  };
  const n = (row?: Row) => Number(row?.seq ?? 0);
  const judge = ({ thread, start, end, interrupt, queued }: Awaited<ReturnType<typeof read>>): WorkerWait['state'] =>
    // A pending queued message is BB's own retry or the next prompt: the worker will run again.
    busy(thread.status) || queued || (n(start) > seq && n(start) > n(end)) ? 'working'
    : thread.status === 'error' ? 'failed'
    // A stop newer than the last finished turn stays a stop, even if a late start of the cancelled turn arrives.
    : thread.status === 'stopping' || n(interrupt) > n(end) || (end && stop(end)) ? 'stopped' : 'idle';
  const before = await read();
  let state = judge(before);
  let output: string | null = null;
  let latest = before;
  if (state !== 'working') {
    output = (await threads.output({ threadId })).output;
    // The report must belong to the turn judged above: a turn that started meanwhile makes it someone else's.
    latest = await read();
    if (judge(latest) === 'working' || n(latest.start) > n(before.start)) { state = 'working'; output = null; }
  }
  const activity = Math.max(...[before.start, before.end, before.interrupt].map(row => Number(row?.createdAt ?? 0)));
  const idleForMs = state === 'idle' && activity ? Math.max(0, now() - activity) : null;
  // resumed comes from the same last read as the state, so the two never disagree.
  return { state, seq, resumed: n(latest.start) > after, idleForMs, output };
}
