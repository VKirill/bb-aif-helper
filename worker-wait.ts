/**
 * Waiting for a worker thread without gaps. The coordinator model used to poll with `bb thread wait` and
 * `bb thread output`; between two commands a worker could resume, finish or fail unseen (Antigravity ends a
 * turn while its tests run in the background and resumes by itself). Here every answer carries the event
 * cursor `seq`, and the next call looks at what happened after it, so nothing between calls is lost.
 */
import type { BbPluginApi } from '@get-bb/plugin-sdk';

type Threads = Pick<BbPluginApi['sdk']['threads'], 'get' | 'wait' | 'output' | 'events' | 'queuedMessages'>;
type Row = { seq: number | string; type: string; createdAt: number | string; data?: unknown };
type Queued = { state: string; waitingOn?: { kind: string } | null };
export type WorkerWait = {
  /** working: it runs or BB will run it again by itself; idle: its last turn ended; stopped: someone stopped it or BB holds
   * it for an answer; failed: BB reports an error and no retry is left. */
  state: 'working' | 'idle' | 'stopped' | 'failed';
  /** Pass as `--after` to the next call. */
  seq: number;
  /** A turn started after the previous cursor. */
  resumed: boolean;
  /** Time since its last turn activity, while idle. */
  idleForMs: number | null;
  output: string | null;
};

const LIFECYCLE = ['turn/started', 'turn/completed', 'system/thread/interrupted'] as const;
const stop = (e: Row) => e.type === 'system/thread/interrupted' || (e.type === 'turn/completed' && (e.data as { status?: string } | undefined)?.status === 'interrupted');
// What BB itself will dispatch later; a message held for an answer, a plugin or a stop does not run by itself, and a superseded one never does.
const RUNS_LATER = new Set(['time', 'thread-busy', 'turn-starting', 'provisioning', 'host-offline', 'app-update']);
const HELD = new Set(['interaction', 'plugin', 'stopping']);
const pending = (q: Queued[]) => q.some(m => ['queued', 'scheduled', 'claimed', 'failed_retrying'].includes(m.state) || (m.state === 'waiting' && RUNS_LATER.has(m.waitingOn?.kind ?? '')));
const held = (q: Queued[]) => q.some(m => m.state === 'waiting' && HELD.has(m.waitingOn?.kind ?? ''));
const exhausted = (q: Queued[]) => q.some(m => m.state === 'failed_exhausted');
// pending and starting are a turn on its way, not a finished one.
const busy = (status: string) => ['active', 'pending', 'starting'].includes(status);

type Options = { budgetMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };

/** One answer within `budgetMs`, so a CLI call never hits BB's command timeout. */
export async function waitWorker(threads: Threads, threadId: string, after: number,
  { budgetMs = 90_000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }: Options = {}): Promise<WorkerWait> {
  const deadline = now() + budgetMs;
  const left = () => Math.max(0, deadline - now());
  const queue = async () => await threads.queuedMessages.list({ threadId }) as Queued[];
  const startedAfter = async () => (await threads.events.list({ threadId, afterSeq: String(after), types: ['turn/started'], order: 'asc', limit: '1' }) as Row[]).length > 0;

  // Wait until the state settles or the budget runs out.
  for (let first = true; left() > 0; first = false) {
    const [thread, q] = await Promise.all([threads.get({ threadId }), queue()]);
    if (busy(thread.status) || pending(q)) {
      await threads.wait({ threadId, status: 'idle', timeoutMs: left() }).catch(() => undefined);
      // An idle that follows still needs a look: BB may queue its retry a moment after a turn fails.
      if (left() > 0) await sleep(Math.min(1000, left()));
    } else if (thread.status === 'error' && !exhausted(q) && !held(q)) await sleep(Math.min(1000, left()));
    else if (first && thread.status === 'idle' && !held(q) && !exhausted(q) && !(await startedAfter())) {
      // Idle since the last look: give it the budget to resume by itself.
      if (!await threads.events.wait({ threadId, afterSeq: String(after), type: 'turn/started', waitMs: String(left()) })) break;
    } else break;
  }

  // The cursor is taken before the state is read: anything that happens after it is seen by the next call.
  const [last] = await threads.events.list({ threadId, order: 'desc', limit: '1' }) as Row[];
  const seq = Math.max(after, Number(last?.seq ?? 0));
  const read = async () => {
    const [thread, q] = await Promise.all([threads.get({ threadId }), queue()]);
    const newest = async (type: typeof LIFECYCLE[number]) => (await threads.events.list({ threadId, types: [type], order: 'desc', limit: '1' }) as Row[])[0];
    const [start, end, interrupt] = await Promise.all(LIFECYCLE.map(newest));
    return { thread, q, start, end, interrupt };
  };
  const n = (row?: Row) => Number(row?.seq ?? 0);
  const judge = ({ thread, q, start, end, interrupt }: Awaited<ReturnType<typeof read>>): WorkerWait['state'] =>
    busy(thread.status) || pending(q) || (n(start) > seq && n(start) > n(end)) ? 'working'
    // A stop newer than the last finished turn stays a stop, even if a late start of the cancelled turn arrives.
    : thread.status === 'stopping' || held(q) || n(interrupt) > n(end) || (end && stop(end)) ? 'stopped'
    : thread.status === 'error' || exhausted(q) ? 'failed' : 'idle';
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
