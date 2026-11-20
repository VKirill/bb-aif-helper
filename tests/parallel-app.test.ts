import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { loadPluginApp, renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { fireEvent, waitFor, within } = await import('@testing-library/react');
const app = await loadPluginApp(() => import('../app.tsx'));

function data() { const s = snapshot(); s.actions = workflowActions(s); return s; }

const BB = { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol' };
const SELF = { mode: 'self' as const };
const child = (id: string, title: string, worktree: boolean) => ({
  id, title, status: 'active', providerId: 'codex', updatedAt: '2026-11-19T00:00:00Z', worktree,
  execution: null, fallback: null, mismatch: null,
});
function delegationView(choice: unknown, children: unknown[] = [], research: unknown = SELF) {
  return { choice, research, research2: research, research3: research, configured: true, foreign: null, error: null,
    providers: [{ id: 'codex', name: 'Codex' }], children, defaults: null, appliedDefaults: null };
}
const tab = () => app.tabs.find(t => t.id === 'workflow')!;
const panelProps = (threadId: string) => ({ threadId, environment: { id: 'env_panel' } });

test('the «Параллельно» row shows only for the «Код» role on «Другая модель» and saves through setDelegation', async () => {
  const saved: any[] = [];
  let current = delegationView(BB, [], BB);
  const slot = renderSlot(tab() as any, panelProps('thr_par'), { rpc: {
    status: () => data(),
    delegation: () => current,
    setDelegation: (input: any) => { saved.push(input); current = delegationView(input.choice, [], BB); return current; },
  } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    await slot.findByText('Параллельно');
    assert.equal(slot.queryAllByText('Параллельно').length, 1, 'research roles never get the row');
    const group = slot.getByRole('group', { name: 'Параллельность' });
    const buttons = within(group);
    assert.equal((buttons.getByRole('button', { name: 'Выкл' }) as HTMLButtonElement).getAttribute('aria-pressed'), 'true');
    fireEvent.click(buttons.getByRole('button', { name: '3' }));
    await waitFor(() => assert.equal(saved.length, 1));
    assert.deepEqual(saved[0], { threadId: 'thr_par', role: 'implement', choice: { ...BB, parallel: 3 } });
    await waitFor(() => {
      const pressed = slot.getByRole('group', { name: 'Параллельность' }).querySelector('button[aria-pressed="true"]');
      assert.equal(pressed?.textContent, '3');
    });
    fireEvent.click(within(slot.getByRole('group', { name: 'Параллельность' })).getByRole('button', { name: 'Выкл' }));
    await waitFor(() => assert.equal(saved.length, 2));
    assert.deepEqual(saved[1].choice, BB, '«Выкл» sends the choice without parallel');
    assert.ok(!('parallel' in saved[1].choice));
  } finally { slot.lifecycle.unmount(); }
});

test('«Параллельно» is hidden while «Код» runs on «Этот агент», even if research uses another model', async () => {
  const slot = renderSlot(tab() as any, panelProps('thr_par_self'), { rpc: {
    status: () => data(),
    delegation: () => delegationView(SELF, [], BB),
  } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    await slot.findByText('Код');
    assert.ok(slot.queryByText('Параллельно') === null, 'element should be absent');
    assert.ok(slot.queryByRole('group', { name: 'Параллельность' }) === null, 'element should be absent');
  } finally { slot.lifecycle.unmount(); }
});

test('a child thread in its own copy shows the «отдельная копия» badge', async () => {
  const slot = renderSlot(tab() as any, panelProps('thr_par_wt'), { rpc: {
    status: () => data(),
    delegation: () => delegationView(BB, [child('thr_w1', 'AIF · plan · 1', true), child('thr_w2', 'AIF · plan · 2', false)]),
  } });
  try {
    await slot.findByText('В работе');
    const copy = await slot.findAllByText('отдельная копия');
    assert.equal(copy.length, 1);
    const row = slot.getByText('AIF · plan · 1').closest('li')!;
    assert.match(row.textContent!, /отдельная копия/);
    const shared = slot.getByText('AIF · plan · 2').closest('li')!;
    assert.doesNotMatch(shared.textContent!, /отдельная копия/);
  } finally { slot.lifecycle.unmount(); }
});
