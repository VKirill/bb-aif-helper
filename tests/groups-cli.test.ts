import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';

const PLAN = [
  '# Plan',
  '## Tasks',
  '- [ ] Task 1: Alpha. Files: `a.ts`. Depends on —',
  '- [ ] Task 2: Beta. Files: `b.ts`. Depends on —',
  '<!-- aif:task-kind:commit -->',
  '- [ ] Task 3: Commit the work.',
].join('\n');
const CYCLE = [
  '# Plan',
  '## Tasks',
  '- [ ] Task 1: Alpha. Files: `a.ts`. Depends on 2',
  '- [ ] Task 2: Beta. Files: `b.ts`. Depends on 1',
].join('\n');

async function setup(planText = PLAN) {
  let value = snapshot(); value.actions = workflowActions(value);
  const thread = makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } });
  const h = createFakePluginHost({ pluginId: 'aif-chat', agentSkillIds: ['aif-chat'], experimental_hostEntry: true,
    sdk: {
      threads: { get: async () => thread, list: async () => [] },
      environments: { get: async () => ({ id: 'env_test', projectId: 'proj_test', path: '/project', hostId: 'host_test', status: 'ready', lifecycle: { phase: 'active' } }) as any },
    },
    experimental_callHostRpc: async call => {
      if (call.method === 'collect') return structuredClone(value);
      if (call.method === 'planText') return { path: (call.input as any).target, text: planText };
      throw new Error(`unexpected host rpc ${call.method}`);
    },
  });
  await plugin(h.bb);
  return h;
}

test('groups prints human-readable groups and the coordinator-only tail', async () => {
  const h = await setup();
  try {
    const result = await h.harness.behavior.runCli(['groups', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md']);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'Группа 1: задачи 1, 2\nГруппа 2: задачи 3\nТолько координатор: задачи 3');
  } finally { await h.harness.lifecycle.dispose(); }
});

test('groups --json emits groups, coordinatorOnly, target and max; --max caps the size', async () => {
  const h = await setup();
  try {
    const result = await h.harness.behavior.runCli(['groups', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--json']);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout!), { target: '.ai-factory/plans/demo.md', max: 3, groups: [[1, 2], [3]], coordinatorOnly: [3] });
    const capped = await h.harness.behavior.runCli(['groups', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--max', '1', '--json']);
    assert.deepEqual(JSON.parse(capped.stdout!).groups, [[1], [2], [3]]);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('groups reports a dependency cycle as { error } in json and a failing text run', async () => {
  const h = await setup(CYCLE);
  try {
    const jsonResult = await h.harness.behavior.runCli(['groups', '--thread', 'thr_test', '--target', '.ai-factory/plans/cycle.md', '--json']);
    assert.equal(jsonResult.exitCode, 0);
    const parsed = JSON.parse(jsonResult.stdout!);
    assert.equal(parsed.target, '.ai-factory/plans/cycle.md');
    assert.match(parsed.error, /Цикл/);
    const textResult = await h.harness.behavior.runCli(['groups', '--thread', 'thr_test', '--target', '.ai-factory/plans/cycle.md']);
    assert.equal(textResult.exitCode, 1);
    assert.match(textResult.stderr ?? '', /Цикл/);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('groups requires --target and rejects unknown options', async () => {
  const h = await setup();
  try {
    const missing = await h.harness.behavior.runCli(['groups', '--thread', 'thr_test']);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr ?? '', /--target/);
    assert.equal((await h.harness.behavior.runCli(['groups', '--thread', 'thr_test', '--target', 'x.md', '--bogus'])).exitCode, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});
