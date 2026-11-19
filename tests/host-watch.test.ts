import test from 'node:test';
import assert from 'node:assert/strict';
import { experimental_createHostEntryHarness } from '@get-bb/plugin-sdk/testing/host';
import type { ExperimentalHostWatchListener, ExperimentalHostWatchOptions } from '@get-bb/plugin-sdk';
import hostEntry from '../host.ts';
import { WATCH_IGNORED } from '../live-updates.ts';

type WatchCall = {
  options: ExperimentalHostWatchOptions;
  listener: ExperimentalHostWatchListener;
  disposed: number;
};

function setup() {
  const calls: WatchCall[] = [];
  const harness = experimental_createHostEntryHarness(hostEntry, {
    experimental_watch: (options, listener) => {
      const call: WatchCall = { options, listener, disposed: 0 };
      calls.push(call);
      return { dispose: async () => { call.disposed += 1; } };
    },
  });
  return { harness, calls };
}

test('watch subscribes with the filtered options and emits filesChanged for a relevant change', async t => {
  const { harness, calls } = setup();
  t.after(() => harness.experimental_dispose());
  await harness.experimental_call('watch', { root: '/repo' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.options, {
    rootPath: '/repo',
    ignoredPaths: WATCH_IGNORED,
    debounceMs: 300,
    maxWaitMs: 1000,
  });
  await calls[0]!.listener({ kind: 'changed', changes: [
    { path: 'src/x.ts', type: 'update' },
    { path: 'docs/a.md', type: 'update' },
  ] });
  assert.deepEqual(harness.experimental_getSignals(), [
    { signal: 'filesChanged', payload: { root: '/repo' } },
  ]);
});

test('irrelevant changes emit no signal', async t => {
  const { harness, calls } = setup();
  t.after(() => harness.experimental_dispose());
  await harness.experimental_call('watch', { root: '/repo-src' });
  await calls[0]!.listener({ kind: 'changed', changes: [
    { path: 'src/x.ts', type: 'update' },
    { path: 'app.tsx', type: 'create' },
  ] });
  assert.equal(harness.experimental_getSignals().length, 0);
});

test('absolute change paths are matched against the watch root', async t => {
  const { harness, calls } = setup();
  t.after(() => harness.experimental_dispose());
  await harness.experimental_call('watch', { root: '/repo-abs' });
  await calls[0]!.listener({ kind: 'changed', changes: [
    { path: '/repo-abs/src/x.ts', type: 'update' },
    { path: '/repo-abs/docs/a.md', type: 'update' },
    { path: '/elsewhere/docs/b.md', type: 'update' },
  ] });
  assert.deepEqual(harness.experimental_getSignals(), [
    { signal: 'filesChanged', payload: { root: '/repo-abs' } },
  ]);
});

test('rescan-required emits filesChanged', async t => {
  const { harness, calls } = setup();
  t.after(() => harness.experimental_dispose());
  await harness.experimental_call('watch', { root: '/repo-rescan' });
  await calls[0]!.listener({ kind: 'rescan-required' });
  assert.deepEqual(harness.experimental_getSignals(), [
    { signal: 'filesChanged', payload: { root: '/repo-rescan' } },
  ]);
});

test('watch-error emits watchLost and disposes the subscription', async t => {
  const { harness, calls } = setup();
  t.after(() => harness.experimental_dispose());
  await harness.experimental_call('watch', { root: '/repo-lost' });
  await calls[0]!.listener({ kind: 'watch-error', message: 'fs gone' });
  assert.deepEqual(harness.experimental_getSignals(), [
    { signal: 'watchLost', payload: { root: '/repo-lost', reason: 'fs gone' } },
  ]);
  assert.equal(calls[0]!.disposed, 1);
  await harness.experimental_call('watch', { root: '/repo-lost' });
  assert.equal(calls.length, 2);
});

test('a second watch of the same root does not resubscribe and unwatch disposes', async t => {
  const { harness, calls } = setup();
  t.after(() => harness.experimental_dispose());
  await harness.experimental_call('watch', { root: '/repo-dedupe' });
  await harness.experimental_call('watch', { root: '/repo-dedupe' });
  assert.equal(calls.length, 1);
  await harness.experimental_call('unwatch', { root: '/repo-dedupe' });
  assert.equal(calls[0]!.disposed, 1);
  await harness.experimental_call('unwatch', { root: '/repo-dedupe' });
  assert.equal(calls[0]!.disposed, 1);
});

test('entry dispose closes all watches', async t => {
  const { harness, calls } = setup();
  t.after(() => harness.experimental_dispose());
  await harness.experimental_call('watch', { root: '/repo-dispose' });
  await harness.experimental_dispose();
  assert.equal(calls[0]!.disposed, 1);
});
