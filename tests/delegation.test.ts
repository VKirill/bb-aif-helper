import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONTEXT_PATH, RUNNER_PATH, RUNNER_SOURCE, mergeContextBlock, parseSpec, readDelegation, writeDelegation } from '../delegation.ts';

async function project(config: object | null = { version: '2.23.0', agents: [{ id: 'claude' }] }) {
  const root = await mkdtemp(join(tmpdir(), 'aif-delegation-'));
  if (config) await writeFile(join(root, '.ai-factory.json'), JSON.stringify(config));
  return root;
}
const json = async (root: string) => JSON.parse(await readFile(join(root, '.ai-factory.json'), 'utf8'));
const exists = (path: string) => access(path).then(() => true, () => false);

test('parseSpec round-trips provider/model?reasoning&tier, including slashes and colons in the model', () => {
  assert.deepEqual(parseSpec('codex/gpt-6.2-sol?reasoning=high&tier=fast'), { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' });
  assert.deepEqual(parseSpec('claude-code/sonnet'), { mode: 'bb', providerId: 'claude-code', model: 'sonnet' });
  assert.deepEqual(parseSpec('opencode2/openrouter/qwen:7b?reasoning=low'), { mode: 'bb', providerId: 'opencode2', model: 'openrouter/qwen:7b', reasoning: 'low' });
  for (const bad of ['sonnet', 'a/b c', '', 42, 'a/b?reasoning=x y', 'a/b?tier=$(x)']) assert.equal(parseSpec(bad), null);
});

test('bb choice writes AI Factory dispatch config, runner and skill-context; self removes only what it added', async () => {
  const root = await project({ version: '2.23.0', agents: [{ id: 'claude' }], phases: { review: { agent: 'gemini-cli' } }, dispatchAgents: { other: { command: 'x {prompt}' } } });
  await mkdir(join(root, '.ai-factory/skill-context/aif-implement'), { recursive: true });
  await writeFile(join(root, CONTEXT_PATH), 'Owner rule: keep commits small.\n');

  const state = await writeDelegation(root, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' });
  assert.deepEqual(state.choice, { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' });
  const config = await json(root);
  assert.equal(config.dispatch, 'auto');
  assert.deepEqual(config.phases.implement, { agent: 'bb', model: 'codex/gpt-6.2-sol?reasoning=high&tier=fast', timeoutMs: 14400000 });
  assert.deepEqual(config.phases.review, { agent: 'gemini-cli' });
  assert.equal(config.dispatchAgents.bb.command, `node ${RUNNER_PATH} run {model} {prompt}`);
  assert.ok(config.dispatchAgents.other);
  assert.deepEqual(config.agents, [{ id: 'claude' }]);
  const context = await readFile(join(root, CONTEXT_PATH), 'utf8');
  assert.match(context, /^Owner rule: keep commits small\.\n\n<!-- bb-aif-helper:delegation:start -->/);
  assert.match(context, /codex\/gpt-6\.2-sol\?reasoning=high&tier=fast/);
  assert.ok(await exists(join(root, RUNNER_PATH)));

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
  assert.equal(await exists(join(root, RUNNER_PATH)), false);
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

test('runner is valid JavaScript and explains usage without BB', async () => {
  const root = await project();
  const file = join(root, 'runner.mjs');
  await writeFile(file, RUNNER_SOURCE);
  execFileSync(process.execPath, ['--check', file]);
  const env = { ...process.env, BB_THREAD_ID: '', BB_ENVIRONMENT_ID: '', BB_PROJECT_ID: '' };
  const stderr = (args: string[]) => { try { execFileSync(process.execPath, [file, ...args], { encoding: 'utf8', stdio: 'pipe', env, cwd: root }); return ''; } catch (e) { return String((e as { stderr?: unknown }).stderr); } };
  const usage = stderr([]);
  assert.match(usage, /usage: bb-aif-run/);
  const outside = stderr(['run', 'codex/gpt', 'hi']);
  assert.match(outside, /run inside a BB thread/);
});
