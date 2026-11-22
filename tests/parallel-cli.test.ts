import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';

// The coordinator works on Windows here: every value reaches BB and the folder's machine as data, never through a shell.
const ROOT = 'C:\\Users\\Dev User\\репо';
async function setup() {
  const calls: { method: string; input: any; hostId: string }[] = [];  // guardian: allow — loose mock of the BB SDK and host RPC in this test
  const spawns: any[] = [];  // guardian: allow — loose mock of the BB SDK and host RPC in this test
  const threads: Record<string, any> = {
    thr_test: makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } }),
    thr_worker: { ...makeThreadResponse({ id: 'thr_worker', projectId: 'proj_test', environmentId: 'env_worker', status: 'idle', runtime: { displayStatus: 'idle' } }), parentThreadId: 'thr_test' },
    thr_other: { ...makeThreadResponse({ id: 'thr_other', projectId: 'proj_test', environmentId: 'env_worker', status: 'idle', runtime: { displayStatus: 'idle' } }), parentThreadId: 'thr_x' },
  };
  const envs: Record<string, any> = {
    env_test: { id: 'env_test', projectId: 'proj_test', path: ROOT, hostId: 'host_win', status: 'ready', lifecycle: { phase: 'active' } },
    env_worker: { id: 'env_worker', projectId: 'proj_test', path: 'C:\\Users\\Dev User\\.bb-aif-helper\\worktrees\\r-1\\demo-2-x', hostId: 'host_win', environmentProviderId: 'aif-chat-worktree', status: 'ready', lifecycle: { phase: 'active' } },
  };
  const h = createFakePluginHost({ pluginId: 'aif-chat', agentSkillIds: ['aif-chat'], experimental_hostEntry: true,
    sdk: {
      threads: { get: async ({ threadId }: any) => threads[threadId], list: async () => [], spawn: async (args: any) => { spawns.push(args); return { ...threads.thr_test, id: 'thr_new' }; },
        // thr_worker finished one turn: started at seq 1, completed at seq 2.
        events: { list: async ({ afterSeq = '0', types, order, limit }: any) => { let rows = [{ seq: 1, type: 'turn/started', createdAt: 0 }, { seq: 2, type: 'turn/completed', createdAt: 0, data: { status: 'completed' } }].filter(e => e.seq > Number(afterSeq) && (!types || types.includes(e.type))); if (order === 'desc') rows = rows.reverse(); return limit ? rows.slice(0, Number(limit)) : rows; },
          wait: async () => null },
        wait: async () => ({}), output: async () => ({ output: 'Done: src/b.ts' }), queuedMessages: { list: async () => [] } } as any,  // guardian: allow — loose mock of the BB SDK and host RPC in this test
      environments: { get: async ({ environmentId }: any) => envs[environmentId] } as any,  // guardian: allow — loose mock of the BB SDK and host RPC in this test
    },
    experimental_callHostRpc: async call => {
      calls.push({ method: call.method, input: call.input, hostId: call.hostId });
      if (call.method === 'collect') throw new Error('not needed');
      if (call.method === 'delegation') return { choice: { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast', parallel: 2 }, research: { mode: 'self' }, research2: { mode: 'self' }, research3: { mode: 'self' }, configured: true, foreign: null, error: null } as any;  // guardian: allow — loose mock of the BB SDK and host RPC in this test
      if (call.method === 'readBrief') return { text: 'Do task 2.' };
      if (call.method === 'headCommit') return { sha: 'c'.repeat(40) };
      if (call.method === 'bringBack') return { applied: true, files: ['src/b.ts'] };
      throw new Error(`unexpected host rpc ${call.method}`);
    },
  });
  await plugin(h.bb);
  return { h, calls, spawns };
}

test('spawn-worker starts the owner model on a fresh copy seeded with the coordinator\'s work, as a child of the chat', async () => {
  const { h, spawns } = await setup();
  try {
    const result = await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--task', '2', '--brief', 'C:\\Temp\\brief 2.md', '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout!).id, 'thr_new');
    const [args] = spawns;
    assert.equal(args.environment.type, 'provider');
    assert.equal(args.environment.environmentProviderId, 'aif-chat-worktree');
    assert.equal(args.environment.inputs.basePath, ROOT, 'a Windows path with a space and Cyrillic arrives as is');
    assert.equal(args.environment.inputs.ref, 'c'.repeat(40));
    assert.equal(args.environment.inputs.seed, true, 'the copy gets the uncommitted work of earlier tasks');
    assert.match(args.prompt, /Change files only: do not run git commands that change the index/);
    assert.match(args.environment.inputs.name, /^demo-2-[0-9a-f]{8}$/);
    assert.deepEqual(args.environment.machine, { type: 'existing', hostId: 'host_win' });
    assert.deepEqual([args.providerId, args.model, args.reasoningLevel, args.serviceTier], ['codex', 'gpt-6.2-sol', 'high', 'fast']);
    assert.deepEqual([args.parentThreadId, args.lifecycleOwnerThreadId, args.parentNotifications], ['thr_test', 'thr_test', 'off']);
    assert.match(args.prompt, /^Do task 2\.[\s\S]*Do not commit\.$/);
    // A retry gets its own copy name.
    await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--task', '2', '--brief', 'C:\\Temp\\brief 2.md']);
    assert.notEqual(spawns[1].environment.inputs.name, args.environment.inputs.name);
    // A nested task id, as the plan card reads `Task 1.2`, is accepted; anything else is refused before a spawn.
    const nested = await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--task', '1.2', '--brief', 'C:\\Temp\\brief 2.md']);
    assert.equal(nested.exitCode, 0, nested.stderr);
    assert.match(spawns[2].environment.inputs.name, /^demo-1\.2-[0-9a-f]{8}$/);
    assert.equal(spawns[2].title, 'AIF · demo · 1.2');
    // Models write the id as `task-3`, `Task 3` or `#3`: the number is what counts.
    for (const [i, loose] of ['task-3', 'Task 3', '#3', ' TASK_3 '].entries()) {
      const ok = await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--task', loose, '--brief', 'C:\\Temp\\brief 2.md']);
      assert.equal(ok.exitCode, 0, loose);
      assert.equal(spawns[3 + i].title, 'AIF · demo · 3', loose);
    }
    for (const bad of ['1.', '.2', '1..2', '1 2', 'a', 'task', 'task-', 'task-a', '-3', '_3', '--3', 'task--3', 'task -3', '#-3']) {
      const refused = await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--task', bad, '--brief', 'C:\\Temp\\brief 2.md']);
      assert.notEqual(refused.exitCode, 0, bad);
    }
    assert.equal(spawns.length, 7);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('bring-back takes only a worker of this chat, in an AI Factory copy on the same machine', async () => {
  const { h, calls } = await setup();
  try {
    const ok = await h.harness.behavior.runCli(['bring-back', '--thread', 'thr_test', '--worker', 'thr_worker', '--json']);
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.deepEqual(calls.find(c => c.method === 'bringBack')!.input, { root: ROOT, copy: 'C:\\Users\\Dev User\\.bb-aif-helper\\worktrees\\r-1\\demo-2-x' });
    const foreign = await h.harness.behavior.runCli(['bring-back', '--thread', 'thr_test', '--worker', 'thr_other']);
    assert.equal(foreign.exitCode, 1);
    assert.match(foreign.stderr ?? '', /не исполнитель этого чата/);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('a coordinator with the old block calling groups or checkpoint gets an error and falls back to one worker', async () => {
  const { h, calls } = await setup();
  try {
    const result = await h.harness.behavior.runCli(['groups', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--max', '2', '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(JSON.parse(result.stdout!).error, /groups удалена/);
    const old = await h.harness.behavior.runCli(['checkpoint', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--group', '1', '--json']);
    assert.match(JSON.parse(old.stdout!).error, /checkpoint удалена/);
    assert.equal(calls.length, 0, 'nothing is read or changed on the machine');
  } finally { await h.harness.lifecycle.dispose(); }
});

test('wait-worker answers for a child of this chat only, with the cursor for the next call', async () => {
  const { h } = await setup();
  try {
    const result = await h.harness.behavior.runCli(['wait-worker', '--thread', 'thr_test', '--worker', 'thr_worker', '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    const answer = JSON.parse(result.stdout!);
    assert.deepEqual([answer.state, answer.seq, answer.resumed, answer.output], ['idle', 2, true, 'Done: src/b.ts']);
    const foreign = await h.harness.behavior.runCli(['wait-worker', '--thread', 'thr_test', '--worker', 'thr_other', '--json']);
    assert.match(`${foreign.stdout ?? ''}${foreign.stderr ?? ''}`, /не исполнитель этого чата/);
    for (const bad of ['-1', '1.5', 'x']) {
      const refused = await h.harness.behavior.runCli(['wait-worker', '--thread', 'thr_test', '--worker', 'thr_worker', '--after', bad, '--json']);
      assert.match(`${refused.stdout ?? ''}${refused.stderr ?? ''}`, /--after/, bad);
    }
  } finally { await h.harness.lifecycle.dispose(); }
});
