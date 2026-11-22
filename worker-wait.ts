/**
 * Waiting for a worker thread without gaps. The coordinator model used to poll with `bb thread wait` and
 * `bb thread output`; between two commands a worker could resume, finish or fail unseen (Antigravity ends a
 * turn while its tests run in the background and resumes by itself). Here every answer carries the event
 * cursor `seq`, and the next call looks at everything after it, so nothing between calls is lost.
 */
import type { BbPluginApi } from '@get-bb/plugin-sdk';

type Threads = Pick<BbPluginApi['sdk']['threads'], 'get' | 'wait' | 'output' | 'events'>;
type EventType = 'turn/started' | 'turn/completed' | 'system/thread/interrupted';
type Row = { seq: number | string; type: string; createdAt: number | string; data?: unknown };
export type WorkerWait = {
  /** working: still busy when the budget ran out; idle: its turn ended; stopped: someone stopped it; failed: BB reports an error. */
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

/** One answer within `budgetMs`, so a CLI call never hits BB's command timeout. */
export async function waitWorker(threads: Threads, threadId: string, after: number, budgetMs = 90_000, now = Date.now): Promise<WorkerWait> {
  const deadline = now() + budgetMs;
  const left = () => Math.max(0, deadline - now());
  const since = async (types: [EventType, ...EventType[]]) =>
    await threads.events.list({ threadId, afterSeq: String(after), types, order: 'asc' }) as Row[];
  const untilIdle = () => threads.wait({ threadId, status: 'idle', timeoutMs: left() }).catch(() => undefined);

  const first = await threads.get({ threadId });
  if (busy(first.status)) await untilIdle();
  else if (first.status === 'idle' && !(await since(['turn/started'])).length) {
    // Idle since the last look: give it the budget to resume by itself.
    if (await threads.events.wait({ threadId, afterSeq: String(after), type: 'turn/started', waitMs: String(left()) })) await untilIdle();
  }
  // The cursor is taken before the state is read: anything that happens after it is seen by the next call.
  const [last] = await threads.events.list({ threadId, order: 'desc', limit: '1' }) as Row[];
  const seq = Math.max(after, Number(last?.seq ?? 0));
  const thread = await threads.get({ threadId });
  const events = await since(['turn/started', 'turn/completed', 'system/thread/interrupted']);
  const resumed = events.some(e => e.type === 'turn/started');
  const interrupted = events.some(e => e.type === 'system/thread/interrupted'
    || (e.type === 'turn/completed' && (e.data as { status?: string } | undefined)?.status === 'interrupted'));
  const state: WorkerWait['state'] = thread.status === 'error' ? 'failed'
    : interrupted || thread.status === 'stopping' ? 'stopped'
    : busy(thread.status) ? 'working' : 'idle';
  let idleForMs: number | null = null;
  if (state === 'idle') {
    const [ended] = await threads.events.list({ threadId, types: ['turn/completed'], order: 'desc', limit: '1' }) as Row[];
    idleForMs = ended ? Math.max(0, now() - Number(ended.createdAt)) : null;
  }
  const output = state === 'working' ? null : (await threads.output({ threadId })).output;
  return { state, seq, resumed, idleForMs, output };
}
