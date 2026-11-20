import test from 'node:test';
import assert from 'node:assert/strict';
import { CHIP_SCORING_TAG, projectTag, relevantChange, threadTag, WATCH_IGNORED } from '../live-updates.ts';
import { rpcContract } from '../contract.ts';

test('tag helpers build the only tag strings', () => {
  assert.equal(threadTag('t1'), 'thread:t1');
  assert.equal(projectTag('p1'), 'project:p1');
  assert.equal(CHIP_SCORING_TAG, 'chip-scoring');
});

test('aifMode tags carry the project tag plus the thread tag when threadId is given', () => {
  const output = { projectId: 'p1', on: true, configured: true };
  assert.deepEqual(rpcContract.aifMode.tags?.({ threadId: 't1' }, output), ['project:p1', 'thread:t1']);
  assert.deepEqual(rpcContract.aifMode.tags?.({}, output), ['project:p1']);
});

test('status tags are per-thread', () => {
  const input = { threadId: 't1', target: '', phase: 'unknown' as const, checkUpdates: false, force: false };
  assert.deepEqual(rpcContract.status.tags?.(input, {} as never), ['thread:t1']);
});

test('relevantChange matches paths the snapshot can read', () => {
  for (const p of ['.ai-factory/plans/x.md', '.ai-factory.json', '.github/workflows/ci.yml', 'docs/a.md', 'README.md', 'openspec/x/y.md',
    '.bb/aif-helper/plans/a.md', '.bb-aif-helper/plans/a.md',
    'Makefile', 'Taskfile.yml', 'docs\\a.md', './docs/b.md'])
    assert.equal(relevantChange(p), true, p);
  for (const p of ['src/x.ts', 'app.tsx', 'node_modules/x/README.md', '.git/HEAD', '.bb/state.json', '.bb/chats/x.md', 'dist/a.json', 'components/ui/b.tsx', 'README'])
    assert.equal(relevantChange(p), false, p);
});

test('WATCH_IGNORED covers the heavy directories', () => {
  assert.deepEqual(WATCH_IGNORED, ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.bb']);
});
