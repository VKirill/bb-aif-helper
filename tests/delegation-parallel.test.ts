import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';
import {
  CONTEXT_PATH, PLAN_CONTEXT_PATH, RESEARCH_PATH, contextBlock, modelSpec, parseResearch, parseSpec,
  readDelegation, writeDelegation,
} from '../delegation.ts';
import type { DelegationChoice, DelegationRole, DelegationState } from '../delegation.ts';

async function project(config: object | null = { version: '2.23.0', agents: [{ id: 'claude' }] }) {
  const root = await mkdtemp(join(tmpdir(), 'aif-parallel-'));
  if (config) await writeFile(join(root, '.ai-factory.json'), JSON.stringify(config));
  return root;
}
const json = async (root: string) => JSON.parse(await readFile(join(root, '.ai-factory.json'), 'utf8'));
const exists = (path: string) => access(path).then(() => true, () => false);

test('parallel rides the model spec codec: round-trip and rejection of invalid values', () => {
  const choice: Extract<DelegationChoice, { mode: 'bb' }> = { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', parallel: 3 };
  assert.equal(modelSpec(choice), 'codex/gpt-6.2-sol?reasoning=high&parallel=3');
  assert.deepEqual(parseSpec('codex/gpt-6.2-sol?reasoning=high&parallel=3'), choice);
  assert.deepEqual(parseSpec('codex/m?parallel=4'), { mode: 'bb', providerId: 'codex', model: 'm', parallel: 4 });
  for (const bad of ['codex/m?parallel=5', 'codex/m?parallel=1', 'codex/m?parallel=0', 'codex/m?parallel=x', 'codex/m?parallel=2.5'])
    assert.equal(parseSpec(bad), null, bad);
});

test('contextBlock without parallel keeps the one-worker text and no parallel section', () => {
  const text = contextBlock({ mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high' });
  assert.ok(text.includes('One worker at a time: workers share this workspace.'));
  assert.ok(!text.includes('Parallel mode'));
  assert.ok(!text.includes('parallel='));
});

test('contextBlock with parallel spawns workers on BB-made copies and keeps provider flags', () => {
  const text = contextBlock({ mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast', parallel: 3 });
  // The copy comes from the plugin's environment provider, so a section inside a larger repository works too.
  for (const absent of ['git worktree add', 'git worktree remove', '--environment <copy>']) assert.ok(!text.includes(absent), absent);
  for (const part of [
    'Parallel mode', '--max 3', '--environment-provider aif-chat-worktree', '"basePath":"<base>"', '"ref":"<sha>"', 'git rev-parse HEAD',
    'environment.path', 'git rev-parse --show-toplevel', 'BB removes its copy',
    'git status --porcelain', 'git -C "<top>" apply --check "<patch>"', '--output="<patch>"', '--no-relative', '--src-prefix=a/ --dst-prefix=b/', '--literal-pathspecs', '--prompt-file "<brief>"', 'C:/Users/me/repo',
    "git --literal-pathspecs commit -m 'chore(aif): <plan> · before group N' -- <files>", 'there is nothing to undo',
    "--provider 'codex'", "--model 'gpt-6.2-sol'", "--reasoning-level 'high'", "--service-tier 'fast'",
    'bb plugin run aif-chat groups', 'Do not commit',
    'stop and ask the owner; never commit them',
    'the files named in the error',
  ]) assert.ok(text.includes(part), part);
  // A three-way apply leaves unmerged files that `git checkout` cannot undo; it must never be suggested.
  for (const absent of ['--3way <', 'git checkout --', ' > <tmp>', 'commit -am']) assert.ok(!text.includes(absent), absent);
});

test('writeDelegation stores parallel in phases.implement.model and manages the aif-plan block', async () => {
  const root = await project();
  const withParallel = { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', parallel: 3 };
  const state = await writeDelegation(root, withParallel);
  assert.equal(state.choice.mode === 'bb' && state.choice.parallel, 3);
  assert.equal((await json(root)).phases.implement.model, 'codex/gpt-6.2-sol?reasoning=high&parallel=3');
  const planContext = await readFile(join(root, PLAN_CONTEXT_PATH), 'utf8');
  assert.ok(planContext.includes('bb-aif-helper:plan'));
  assert.ok(planContext.includes('Files:'));
  const implementContext = await readFile(join(root, CONTEXT_PATH), 'utf8');
  assert.ok(implementContext.includes('Parallel mode'));

  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high' });
  assert.equal((await json(root)).phases.implement.model, 'codex/gpt-6.2-sol?reasoning=high');
  assert.ok(!(await exists(join(root, PLAN_CONTEXT_PATH))), 'the plan block file is removed once empty');
  assert.ok(!(await readFile(join(root, CONTEXT_PATH), 'utf8')).includes('Parallel mode'));
});

test('parallel is implement-only: research choices and the research block never keep it', async () => {
  const root = await project();
  const research: Extract<DelegationChoice, { mode: 'bb' }> = { mode: 'bb', providerId: 'codex', model: 'm', parallel: 3 };
  const state = await writeDelegation(root, research, 'research');
  assert.equal(state.research.mode === 'bb' && 'parallel' in state.research, false);
  const text = await readFile(join(root, RESEARCH_PATH), 'utf8');
  assert.ok(!text.includes('parallel='));
  const parsed = parseResearch(`x\n<!-- bb-aif-helper:research:start -->\n<!-- research-model: codex/m?parallel=3&reasoning=high -->\n<!-- bb-aif-helper:research:end -->`);
  assert.deepEqual(parsed.research, { mode: 'bb', providerId: 'codex', model: 'm', reasoning: 'high' });
});

async function setup() {
  const state: DelegationState = { choice: { mode: 'self' }, research: { mode: 'self' }, research2: { mode: 'self' }, research3: { mode: 'self' }, configured: true, foreign: null, error: null };
  const hostCalls: { method: string; input: any }[] = [];
  const value = snapshot(); value.actions = workflowActions(value);
  const thread = makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } });
  const h = createFakePluginHost({ pluginId: 'aif-chat', agentSkillIds: ['aif-chat'], experimental_hostEntry: true,
    sdk: {
      threads: { get: async () => thread, list: async () => [] },
      environments: { get: async () => ({ id: 'env_test', projectId: 'proj_test', path: '/project', hostId: 'host_test', status: 'ready', lifecycle: { phase: 'active' } }) as any },
      providers: { list: async () => [] },
    },
    experimental_callHostRpc: async call => {
      hostCalls.push({ method: call.method, input: structuredClone(call.input) });
      if (call.method === 'collect') return structuredClone(value);
      if (call.method === 'delegation') return structuredClone(state);
      if (call.method === 'setDelegation') {
        const input = call.input as { choice: DelegationChoice; role?: DelegationRole };
        const role = input.role ?? 'implement';
        if (role === 'implement') state.choice = input.choice; else state[role] = input.choice;
        return structuredClone(state);
      }
      throw new Error(`unexpected host rpc ${call.method}`);
    },
  });
  await plugin(h.bb);
  return { ...h, state, hostCalls };
}

test('delegation defaults keep parallel together with the model', async () => {
  const h = await setup();
  try {
    h.state.choice = { mode: 'bb', providerId: 'devin', model: 'swe-2-flash', parallel: 3 };
    await h.harness.behavior.callRpc('setDelegationDefaults', { threadId: 'thr_test', action: 'from-project' });
    const stored = await h.bb.storage.kv.get<any>('delegation-defaults');
    assert.equal(stored.implement.parallel, 3);
    h.state.choice = { mode: 'self' };
    await h.harness.behavior.callRpc('setDelegationDefaults', { threadId: 'thr_test', action: 'apply' });
    const writes = h.hostCalls.filter(c => c.method === 'setDelegation').map(c => c.input as { role?: string; choice: DelegationChoice });
    const implement = writes.filter(c => (c.role ?? 'implement') === 'implement').at(-1)!;
    assert.deepEqual(implement.choice, { mode: 'bb', providerId: 'devin', model: 'swe-2-flash', parallel: 3 });
  } finally { await h.harness.lifecycle.dispose(); }
});

test('a block saved by an older version is rewritten on read; the owner text and an unchanged block stay as they are', async () => {
  const root = await project();
  const choice = { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', parallel: 2 };
  await writeDelegation(root, choice);
  const file = join(root, CONTEXT_PATH);
  const current = await readFile(file, 'utf8');
  // What a project saved before the update holds: the three-way apply that can leave an unmerged index.
  const stale = '\uFEFF    indented owner code\n# Owner notes\n\n' + current.replace('git -C "<top>" apply --check "<patch>"', 'git apply --3way <tmp>/task-<taskId>.patch');
  await writeFile(file, stale);
  await readDelegation(root);
  const refreshed = await readFile(file, 'utf8');
  assert.ok(!refreshed.includes('--3way <tmp>'), 'the old command is gone');
  assert.ok(refreshed.includes('git -C "<top>" apply --check "<patch>"'));
  assert.ok(refreshed.startsWith('\uFEFF    indented owner code\n# Owner notes\n'), 'text outside the markers is kept byte for byte');
  const again = await readFile(file, 'utf8');
  await readDelegation(root);
  assert.equal(await readFile(file, 'utf8'), again, 'a current block is not rewritten');
});
