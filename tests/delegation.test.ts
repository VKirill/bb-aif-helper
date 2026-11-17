import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_PATH, mergeContextBlock, parseSpec, readDelegation, writeDelegation } from '../delegation.ts';

const LEGACY_RUNNER = '.ai-factory/bin/bb-aif-run.mjs';

async function project(config: object | null = { version: '2.23.0', agents: [{ id: 'claude' }] }) {
  const root = await mkdtemp(join(tmpdir(), 'aif-delegation-'));
  if (config) await writeFile(join(root, '.ai-factory.json'), JSON.stringify(config));
  return root;
}
const json = async (root: string) => JSON.parse(await readFile(join(root, '.ai-factory.json'), 'utf8'));
const exists = (path: string) => access(path).then(() => true, () => false);
const managedBlock = async (root: string) => {
  const content = await readFile(join(root, CONTEXT_PATH), 'utf8');
  const start = content.indexOf('delegation:start');
  const end = content.indexOf('delegation:end');
  return content.slice(start, end);
};

test('parseSpec round-trips provider/model?reasoning&tier, including slashes and colons in the model', () => {
  assert.deepEqual(parseSpec('codex/gpt-6.2-sol?reasoning=high&tier=fast'), { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' });
  assert.deepEqual(parseSpec('claude-code/sonnet'), { mode: 'bb', providerId: 'claude-code', model: 'sonnet' });
  assert.deepEqual(parseSpec('opencode2/openrouter/qwen:7b?reasoning=low'), { mode: 'bb', providerId: 'opencode2', model: 'openrouter/qwen:7b', reasoning: 'low' });
  for (const bad of ['sonnet', 'a/b c', '', 42, 'a/b?reasoning=x y', 'a/b?tier=$(x)']) assert.equal(parseSpec(bad), null);
});

test('bb choice writes AI Factory dispatch config and skill-context; self removes only what it added', async () => {
  const root = await project({ version: '2.23.0', agents: [{ id: 'claude' }], phases: { review: { agent: 'gemini-cli' } }, dispatchAgents: { other: { command: 'x {prompt}' } } });
  await mkdir(join(root, '.ai-factory/skill-context/aif-implement'), { recursive: true });
  await writeFile(join(root, CONTEXT_PATH), 'Owner rule: keep commits small.\n');

  const state = await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' });
  assert.deepEqual(state.choice, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' });
  const config = await json(root);
  assert.equal(config.dispatch, undefined);
  assert.deepEqual(config.phases.implement, { agent: 'bb', model: 'codex/gpt-6.2-sol?reasoning=high&tier=fast', timeoutMs: 14400000 });
  assert.deepEqual(config.phases.review, { agent: 'gemini-cli' });
  assert.equal(config.dispatchAgents.bb, undefined);
  assert.ok(config.dispatchAgents.other);
  assert.deepEqual(config.agents, [{ id: 'claude' }]);
  const context = await readFile(join(root, CONTEXT_PATH), 'utf8');
  assert.match(context, /^Owner rule: keep commits small\.\n\n<!-- bb-aif-helper:delegation:start -->/);
  assert.match(context, /codex\/gpt-6\.2-sol\?reasoning=high&tier=fast/);
  assert.match(context, /bb thread spawn/);
  assert.equal(await exists(join(root, LEGACY_RUNNER)), false);

  // Switching model replaces the block instead of stacking a second one.
  await writeDelegation(root, { mode: 'bb', providerId: 'claude-code', model: 'sonnet' });
  const again = await readFile(join(root, CONTEXT_PATH), 'utf8');
  assert.equal(again.match(/delegation:start/g)?.length, 1);
  assert.match(again, /claude-code\/sonnet/);

  const back = await writeDelegation(root, { mode: 'self' });
  assert.deepEqual(back.choice, { mode: 'self' });
  const restored = await json(root);
  assert.equal(restored.phases.implement, undefined);
  assert.deepEqual(restored.phases.review, { agent: 'gemini-cli' });
  assert.equal(restored.dispatchAgents.bb, undefined);
  assert.equal(await readFile(join(root, CONTEXT_PATH), 'utf8'), 'Owner rule: keep commits small.\n');
  assert.equal(await exists(join(root, LEGACY_RUNNER)), false);
});

test('context block spawns workers with native bb thread commands and quoted flags', async () => {
  const root = await project();
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' });
  const text = await managedBlock(root);
  for (const flag of ['bb thread spawn', '--parent-self', '--lifecycle-owner-thread "$BB_THREAD_ID"', '--parent-notifications off',
    "--provider 'codex'", "--model 'gpt-6.2-sol'", "--reasoning-level 'high'", "--service-tier 'fast'"])
    assert.ok(text.includes(flag), flag);
  assert.match(text, /bb thread list --parent-thread/);
  assert.match(text, /AIF · /);
  assert.ok(!text.includes('node ')); assert.ok(!text.includes('aif_delegate_task'));

  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'm', tier: 'default' });
  assert.ok(!(await managedBlock(root)).includes('--service-tier'));
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'm' });
  assert.ok(!(await managedBlock(root)).includes('--service-tier'));
});

test('a model with shell metacharacters reaches the block only single-quoted', async () => {
  const root = await project();
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: "a'b;rm" });
  const text = await managedBlock(root);
  assert.ok(text.includes("--model 'a'\\''b;rm'"));
  assert.ok(!text.includes("--model a'b;rm"));
  assert.ok(!text.includes("--model 'a'b;rm'"));
});

test('saving over the legacy runner install removes its script, dispatchAgents.bb and dispatch', async () => {
  const root = await project({ version: '2.23.0', agents: [], dispatch: 'auto',
    dispatchAgents: { bb: { command: 'node .ai-factory/bin/bb-aif-run.mjs run {model} {prompt}' }, other: { command: 'x {prompt}' } },
    phases: { implement: { agent: 'bb', model: 'codex/gpt-6.2-sol', timeoutMs: 14400000 } } });
  await mkdir(join(root, '.ai-factory/bin'), { recursive: true });
  await writeFile(join(root, LEGACY_RUNNER), '#!/usr/bin/env node\n');
  const state = await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol' });
  assert.equal(state.removedLegacy, true);
  assert.equal(await exists(join(root, LEGACY_RUNNER)), false);
  const config = await json(root);
  assert.equal(config.dispatch, undefined);
  assert.equal(config.dispatchAgents.bb, undefined);
  assert.ok(config.dispatchAgents.other);
});

test('self on a project with nothing else removes dispatch keys and the empty context file', async () => {
  const root = await project();
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol' });
  await writeDelegation(root, { mode: 'self' });
  const config = await json(root);
  for (const key of ['phases', 'dispatch', 'dispatchAgents']) assert.equal(key in config, false, key);
  assert.equal(await exists(join(root, CONTEXT_PATH)), false);
});

test('a phases.implement owned by another agent is reported and never overwritten', async () => {
  const root = await project({ version: '2.23.0', agents: [], dispatch: 'auto', phases: { implement: { agent: 'gemini-cli', model: 'gemini-2.5-pro' } } });
  const state = await readDelegation(root);
  assert.equal(state.foreign, 'gemini-cli');
  await assert.rejects(writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'x' }), /gemini-cli/);
  assert.equal((await json(root)).phases.implement.agent, 'gemini-cli');
});

test('missing or broken .ai-factory.json', async () => {
  const empty = await project(null);
  assert.equal((await readDelegation(empty)).configured, false);
  await assert.rejects(writeDelegation(empty, { mode: 'self' }), /AI Factory/);
  const broken = await project(null);
  await writeFile(join(broken, '.ai-factory.json'), '{ nope');
  assert.match((await readDelegation(broken)).error ?? '', /\.ai-factory\.json/);
});

test('mergeContextBlock keeps owner text around the managed block', () => {
  const withBlock = mergeContextBlock('A\n', 'B');
  assert.equal(withBlock, 'A\n\n<!-- bb-aif-helper:delegation:start -->\nB\n<!-- bb-aif-helper:delegation:end -->\n');
  assert.equal(mergeContextBlock(withBlock + '\nC\n', null), 'A\n\nC\n');
  assert.equal(mergeContextBlock('', null), '');
});

test('choosing self removes the managed block and leaves only owner text', async () => {
  const root = await project();
  await mkdir(join(root, '.ai-factory/skill-context/aif-implement'), { recursive: true });
  await writeFile(join(root, CONTEXT_PATH), 'Owner notes.\n');
  await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol' });
  assert.match(await managedBlock(root), /bb thread spawn/);
  await writeDelegation(root, { mode: 'self' });
  const content = await readFile(join(root, CONTEXT_PATH), 'utf8');
  assert.ok(!content.includes('delegation:start'));
  assert.ok(!content.includes('delegation:end'));
  assert.equal(content, 'Owner notes.\n');
});
