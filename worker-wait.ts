/**
 * Waiting for a worker thread without gaps. The coordinator model used to poll with `bb thread wait` and
 * `bb thread output`; between two commands a worker could resume, finish or fail unseen (Antigravity ends a
 * turn while its tests run in the background and resumes by itself). Here every answer carries the event
 * cursor `seq`, and the next call looks at what happened after it, so nothing between calls is lost.
 */
import type { BbPluginApi } from '@get-bb/plugin-sdk';

type Threads = Pick<BbPluginApi['sdk']['threads'], 'get' | 'wait' | 'output' | 'events'>;
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

/** One answer within `budgetMs`, so a CLI call never hits BB's command timeout. */
export async function waitWorker(threads: Threads, threadId: string, after: number, budgetMs = 90_000, now = Date.now): Promise<WorkerWait> {
  const deadline = now() + budgetMs;
  const left = () => Math.max(0, deadline - now());
  const startedAfter = async () => (await threads.events.list({ threadId, afterSeq: String(after), types: ['turn/started'], order: 'asc', limit: '1' }) as Row[]).length > 0;
  const untilIdle = () => threads.wait({ threadId, status: 'idle', timeoutMs: left() }).catch(() => undefined);

  const first = await threads.get({ threadId });
  // An error may be followed by BB's automatic retry: give it the budget before calling it a failure.
  if (busy(first.status) || first.status === 'error') await untilIdle();
  else if (first.status === 'idle' && !(await startedAfter())) {
    // Idle since the last look: give it the budget to resume by itself.
    if (await threads.events.wait({ threadId, afterSeq: String(after), type: 'turn/started', waitMs: String(left()) })) await untilIdle();
  }
  // The cursor is taken before the state is read: anything that happens after it is seen by the next call.
  const [last] = await threads.events.list({ threadId, order: 'desc', limit: '1' }) as Row[];
  const seq = Math.max(after, Number(last?.seq ?? 0));
  const thread = await threads.get({ threadId });
  // The newest lifecycle event decides, read after the status: an old stop does not outweigh a later successful turn,
  // and a turn that started after the cursor means it works even if the status read just before missed it.
  const [latest] = await threads.events.list({ threadId, types: [...LIFECYCLE], order: 'desc', limit: '1' }) as Row[];
  const startedNow = latest?.type === 'turn/started' && Number(latest.seq) > seq;
  const state: WorkerWait['state'] = busy(thread.status) || startedNow ? 'working'
    : thread.status === 'error' ? 'failed'
    : thread.status === 'stopping' || (latest && stop(latest)) ? 'stopped' : 'idle';
  const idleForMs = state === 'idle' && latest?.type === 'turn/completed' ? Math.max(0, now() - Number(latest.createdAt)) : null;
  const output = state === 'working' ? null : (await threads.output({ threadId })).output;
  return { state, seq, resumed: await startedAfter(), idleForMs, output };
}
