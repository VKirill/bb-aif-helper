import test from 'node:test';
import assert from 'node:assert/strict';
import { waitWorker } from '../worker-wait.ts';

// A fake worker thread: an event log, a status and a clock. `script` runs while waitWorker waits, like the real worker.
function worker(status: string, events: { type: string; data?: unknown }[], output: string | null) {
  let clock = 1_000_000;
  const log = events.map((e, i) => ({ seq: i + 1, createdAt: clock, ...e }));
  const state = { status, output, script: [] as (() => void)[], afterGet: [] as (() => void)[] };
  const add = (type: string, data?: unknown) => log.push({ seq: log.length + 1, createdAt: clock, type, data });
  const step = () => { const next = state.script.shift(); next?.(); };
  const threads = {
    get: async () => { const status = state.status; state.afterGet.shift()?.(); return { status }; },
    output: async () => ({ output: state.output }),
    wait: async ({ timeoutMs }: { timeoutMs: number }) => {
      while (state.status !== 'idle' && state.script.length) step();
      if (state.status !== 'idle') { clock += timeoutMs; throw new Error('timeout'); }
      return {};
    },
    events: {
      list: async ({ afterSeq = '0', types, order, limit }: { afterSeq?: string; types?: string[]; order?: string; limit?: string }) => {
        let rows = log.filter(e => e.seq > Number(afterSeq) && (!types || types.includes(e.type)));
        if (order === 'desc') rows = rows.reverse();
        return rows.slice(0, Number(limit ?? 100));  // BB returns at most 100 rows by default
      },
      wait: async ({ afterSeq, type, waitMs }: { afterSeq: string; type: string; waitMs: string }) => {
        const found = () => log.find(e => e.seq > Number(afterSeq) && e.type === type);
        while (!found() && state.script.length) step();
        if (!found()) clock += Number(waitMs);
        return found() ?? null;
      },
    },
  };
  return { threads: threads as any, state, add, now: () => clock, tickIdle: (ms: number) => { clock += ms; } };  // guardian: allow — loose fake of the BB SDK threads area in this test
}

const done = [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'completed' } }];

test('a busy worker is waited for until idle, and its report comes with the cursor', async () => {
  const w = worker('active', [{ type: 'turn/started' }], null);
  w.state.script.push(() => { w.add('turn/completed', { status: 'completed' }); w.state.status = 'idle'; w.state.output = 'Done: src/a.ts'; });
  const r = await waitWorker(w.threads, 'thr_w', 0);
  assert.deepEqual([r.state, r.seq, r.resumed, r.output], ['idle', 2, true, 'Done: src/a.ts']);
});

test('an idle worker that resumes by itself after the cursor is followed to its next idle (Antigravity pauses)', async () => {
  const w = worker('idle', done, 'waiting for tsc');
  w.state.script.push(() => { w.add('turn/started'); w.state.status = 'active'; },
    () => { w.add('turn/completed', { status: 'completed' }); w.state.status = 'idle'; w.state.output = 'Done, tsc passes'; });
  const r = await waitWorker(w.threads, 'thr_w', 2);
  assert.deepEqual([r.state, r.seq, r.resumed, r.output], ['idle', 4, true, 'Done, tsc passes']);
});

test('a resume that started and finished between two calls is not missed', async () => {
  const w = worker('idle', [...done, { type: 'turn/started' }, { type: 'turn/completed', data: { status: 'completed' } }], 'Done');
  const r = await waitWorker(w.threads, 'thr_w', 2, 90_000);
  assert.deepEqual([r.state, r.seq, r.resumed, r.output], ['idle', 4, true, 'Done']);
});

test('an idle worker that does not resume returns after the budget with how long it has been idle', async () => {
  const w = worker('idle', done, 'waiting for tsc');
  const r = await waitWorker(w.threads, 'thr_w', 2, 90_000, w.now);
  assert.deepEqual([r.state, r.seq, r.resumed, r.output], ['idle', 2, false, 'waiting for tsc']);
  assert.equal(r.idleForMs, 90_000);
});

test('an error and a stop are reported as such, not as a slow worker', async () => {
  const failed = worker('error', done, null);
  assert.equal((await waitWorker(failed.threads, 'thr_w', 0)).state, 'failed');
  const stopped = worker('idle', [...done, { type: 'system/thread/interrupted', data: { reason: 'manual-stop' } }], null);
  assert.equal((await waitWorker(stopped.threads, 'thr_w', 2)).state, 'stopped');
  const interrupted = worker('idle', [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'interrupted' } }], null);
  assert.equal((await waitWorker(interrupted.threads, 'thr_w', 0)).state, 'stopped');
});

test('a worker still busy when the budget runs out is reported working, without a report', async () => {
  const w = worker('active', [{ type: 'turn/started' }], 'partial');
  const r = await waitWorker(w.threads, 'thr_w', 0, 90_000);
  assert.deepEqual([r.state, r.output], ['working', null]);
});

test('an error is not final while BB retries by itself; one that stays is reported failed', async () => {
  const retried = worker('error', [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'failed' } }], null);
  retried.state.script.push(() => { retried.add('turn/started'); retried.state.status = 'active'; },
    () => { retried.add('turn/completed', { status: 'completed' }); retried.state.status = 'idle'; retried.state.output = 'Done'; });
  const r = await waitWorker(retried.threads, 'thr_w', 2, 90_000, retried.now);
  assert.deepEqual([r.state, r.resumed, r.output], ['idle', true, 'Done']);
  const failed = worker('error', [{ type: 'turn/started' }, { type: 'turn/completed', data: { status: 'failed' } }], null);
  assert.equal((await waitWorker(failed.threads, 'thr_w', 2, 90_000, failed.now)).state, 'failed');
});

test('an old stop does not outweigh a later successful turn', async () => {
  const w = worker('idle', [...done, { type: 'system/thread/interrupted', data: { reason: 'manual-stop' } }, { type: 'turn/started' }, { type: 'turn/completed', data: { status: 'completed' } }], 'Done');
  const r = await waitWorker(w.threads, 'thr_w', 2, 90_000, w.now);
  assert.deepEqual([r.state, r.output], ['idle', 'Done']);
});

test('a stop after a hundred lifecycle events is still seen', async () => {
  const turns = Array.from({ length: 50 }, () => done).flat();
  const w = worker('idle', [...turns, { type: 'turn/started' }, { type: 'system/thread/interrupted', data: { reason: 'manual-stop' } }], null);
  assert.equal((await waitWorker(w.threads, 'thr_w', 0, 90_000, w.now)).state, 'stopped');
  const again = await waitWorker(w.threads, 'thr_w', 102, 90_000, w.now);
  assert.equal(again.state, 'stopped');
});

test('a worker that resumes right after its status was read is reported working, not idle for a long time', async () => {
  const w = worker('idle', done, 'waiting for tsc');
  w.tickIdle(600_000);
  // The first read waits out the budget; the resume lands between the second status read and the event read.
  w.state.afterGet.push(() => undefined, () => { w.add('turn/started'); w.state.status = 'active'; });
  const r = await waitWorker(w.threads, 'thr_w', 2, 90_000, w.now);
  assert.deepEqual([r.state, r.idleForMs, r.output], ['working', null, null]);
});
