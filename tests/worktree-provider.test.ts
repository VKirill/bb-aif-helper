import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWorktreeProvider, WORKTREE_PROVIDER_ID } from '../worktree-provider.ts';

const log = { info() {}, warn() {} };
type Host = Parameters<typeof registerWorktreeProvider>[1];
type Provider = { id: string; requires: unknown; inputs: { safeParse(value: unknown): { success: boolean } };
  create(context: unknown): Promise<{ status: string; resource?: { basePath: string; root: string } }>; remove(context: unknown): Promise<unknown> };
const capture = () => { const box: { provider?: Provider } = {}; return { box, register: (d: unknown) => { box.provider = d as Provider; } }; };
const signal = new AbortController().signal;

test('the provider makes the copy on the folder machine and removes it by the recorded resource', async () => {
  const calls: unknown[][] = []; const { box, register } = capture();
  const host = { call: async (method: string, input: unknown, options: { hostId: string }) => {
    calls.push([method, input, options.hostId]);
    return method === 'createWorktree' ? { root: '/h/.bb-aif-helper/worktrees/r/plan-1', path: '/h/.bb-aif-helper/worktrees/r/plan-1/plugins/s', sha: 'a'.repeat(40) } : { removed: true };
  } };
  assert.equal(registerWorktreeProvider({ log, experimental_environments: { register } }, host as unknown as Host), true);
  const provider = box.provider!;
  assert.equal(provider.id, WORKTREE_PROVIDER_ID);
  assert.deepEqual(provider.requires, { projectCheckout: true });
  // The folder's machine may be Windows while BB runs on Linux: its absolute paths pass, relative ones do not.
  for (const basePath of ['/repo', 'C:\\Users\\me\\repo', 'C:/Users/me/repo', 'd:\\repo', '\\\\server\\share\\repo'])
    assert.equal(provider.inputs.safeParse({ basePath, name: 'x' }).success, true, basePath);
  for (const basePath of ['relative', 'C:repo', '\\repo', '\\\\', ''])
    assert.equal(provider.inputs.safeParse({ basePath, name: 'x' }).success, false, basePath);
  assert.equal(provider.inputs.safeParse({ basePath: '/repo', name: 'x', ref: '--output=y' }).success, false);
  const inputs = { basePath: '/repo/plugins/s', name: 'plan-1', ref: 'abc' };
  const made = await provider.create({ inputs, host: { id: 'host_1' }, signal, report: { step() {} } });
  assert.deepEqual(made, { status: 'created', path: '/h/.bb-aif-helper/worktrees/r/plan-1/plugins/s', ownsPath: true,
    resource: { basePath: '/repo/plugins/s', root: '/h/.bb-aif-helper/worktrees/r/plan-1' } });
  assert.deepEqual(calls[0], ['createWorktree', inputs, 'host_1']);
  assert.deepEqual(await provider.remove({ hostId: 'host_1', resource: made.resource, signal }), { status: 'removed' });
  assert.deepEqual(calls[1], ['removeWorktree', made.resource, 'host_1']);
  assert.deepEqual(await provider.remove({ hostId: 'host_1', resource: null, signal }), { status: 'removed' });
  assert.equal(calls.length, 2);
});

test('a failed copy is reported to BB, and a BB without providers registers nothing', async () => {
  const { box, register } = capture();
  const host = { call: async () => { throw new Error('/x не в git-репозитории'); } } as unknown as Host;
  registerWorktreeProvider({ log, experimental_environments: { register } }, host);
  const provider = box.provider!;
  const failed = await provider.create({ inputs: { basePath: '/x', name: 'p' }, host: { id: 'h' }, signal, report: { step() {} } });
  assert.deepEqual(failed, { status: 'failed', message: '/x не в git-репозитории' });
  assert.equal(registerWorktreeProvider({ log }, host), false);
});
