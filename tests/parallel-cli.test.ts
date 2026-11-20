import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';

// The coordinator works on Windows here: every value reaches BB and the folder's machine as data, never through a shell.
const ROOT = 'C:\\Users\\Dev User\\репо';
async function setup() {
  const calls: { method: string; input: any; hostId: string }[] = [];
  const spawns: any[] = [];
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
      threads: { get: async ({ threadId }: any) => threads[threadId], list: async () => [], spawn: async (args: any) => { spawns.push(args); return { ...threads.thr_test, id: 'thr_new' }; } } as any,
      environments: { get: async ({ environmentId }: any) => envs[environmentId] } as any,
    },
    experimental_callHostRpc: async call => {
      calls.push({ method: call.method, input: call.input, hostId: call.hostId });
      if (call.method === 'collect') throw new Error('not needed');
      if (call.method === 'listChanges') return { files: [{ status: ' M', path: 'src/a.ts' }], plugin: [], token: 'a'.repeat(32) };
      if (call.method === 'checkpoint') return { committed: true, sha: 'b'.repeat(40), files: ['src/a.ts'] };
      if (call.method === 'delegation') return { choice: { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast', parallel: 2 }, research: { mode: 'self' }, research2: { mode: 'self' }, research3: { mode: 'self' }, configured: true, foreign: null, error: null } as any;
      if (call.method === 'readBrief') return { text: 'Do task 2.' };
      if (call.method === 'headCommit') return { sha: 'c'.repeat(40) };
      if (call.method === 'bringBack') return { applied: true, files: ['src/b.ts'] };
      throw new Error(`unexpected host rpc ${call.method}`);
    },
  });
  await plugin(h.bb);
  return { h, calls, spawns };
}

test('checkpoint lists first and commits only with the token, with a message built by the plugin', async () => {
  const { h, calls } = await setup();
  try {
    const listed = await h.harness.behavior.runCli(['checkpoint', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo plan.md', '--group', '2', '--json']);
    assert.equal(listed.exitCode, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout!).files, [{ status: ' M', path: 'src/a.ts' }]);
    const done = await h.harness.behavior.runCli(['checkpoint', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo plan.md', '--group', '2', '--token', 'a'.repeat(32)]);
    assert.equal(done.exitCode, 0, done.stderr);
    const commit = calls.find(c => c.method === 'checkpoint')!;
    assert.deepEqual(commit.input, { root: ROOT, token: 'a'.repeat(32), message: 'chore(aif): demo-plan · before group 2' });
    assert.equal(commit.hostId, 'host_win');
    assert.equal((await h.harness.behavior.runCli(['checkpoint', '--thread', 'thr_test', '--target', 'p.md', '--group', 'x'])).exitCode, 1);
  } finally { await h.harness.lifecycle.dispose(); }
});

test('spawn-worker starts the owner model on a fresh copy of the checkpoint commit, as a child of the chat', async () => {
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
    assert.match(args.environment.inputs.name, /^demo-2-[0-9a-f]{8}$/);
    assert.deepEqual(args.environment.machine, { type: 'existing', hostId: 'host_win' });
    assert.deepEqual([args.providerId, args.model, args.reasoningLevel, args.serviceTier], ['codex', 'gpt-6.2-sol', 'high', 'fast']);
    assert.deepEqual([args.parentThreadId, args.lifecycleOwnerThreadId, args.parentNotifications], ['thr_test', 'thr_test', 'off']);
    assert.match(args.prompt, /^Do task 2\.[\s\S]*Do not commit\.$/);
    // A retry gets its own copy name.
    await h.harness.behavior.runCli(['spawn-worker', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--task', '2', '--brief', 'C:\\Temp\\brief 2.md']);
    assert.notEqual(spawns[1].environment.inputs.name, args.environment.inputs.name);
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

test('a coordinator with the old block calling groups gets an error and falls back to one worker', async () => {
  const { h, calls } = await setup();
  try {
    const result = await h.harness.behavior.runCli(['groups', '--thread', 'thr_test', '--target', '.ai-factory/plans/demo.md', '--max', '2', '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(JSON.parse(result.stdout!).error, /groups удалена/);
    assert.equal(calls.length, 0, 'nothing is read or changed on the machine');
  } finally { await h.harness.lifecycle.dispose(); }
});
