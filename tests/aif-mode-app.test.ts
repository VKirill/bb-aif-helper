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
const { act, fireEvent, waitFor, within } = await import('@testing-library/react');
const app = await loadPluginApp(() => import('../app.tsx'));

const modeAction = app.composerCustomizations.find(c => c.id === 'aif-mode')!.actions![0];
const modeView = (on: boolean, configured: boolean | null = true) => ({ projectId: 'proj_test', on, configured });
const pillMentions = (draft: { mentions: readonly any[] }) =>
  draft.mentions.filter(m => m.kind === 'plugin' && m.provider === 'aif-mode' && m.id === 'aif-mode');

test('new-thread composer without a project keeps the mode button disabled', async () => {
  const slot = renderSlot(modeAction, {}, { composer: { scope: { kind: 'new-thread', projectId: null } },
    rpc: { aifMode: () => { throw new Error('aifMode must not be called without a project'); } } });
  try {
    const button = await slot.findByRole('button', { name: 'Режим AI Factory' }) as HTMLButtonElement;
    assert.equal(button.disabled, true);
    assert.equal(button.title, 'Сначала выберите проект');
    assert.equal(slot.inspection.rpcCalls.filter(c => c.method === 'aifMode').length, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('thread without AI Factory opens the workflow tab instead of toggling the mode', async () => {
  const opened: unknown[] = [];
  const slot = renderSlot(modeAction, {}, {
    composer: { scope: { kind: 'thread', threadId: 'thr_test' } },
    rpc: { aifMode: () => modeView(false, false), setAifMode: () => { throw new Error('setAifMode must not be called'); } },
    experimental_panel: { openTab: (options: any) => { opened.push(options); return true; } },
  });
  try {
    const button = await slot.findByRole('button', { name: 'Режим AI Factory' }) as HTMLButtonElement;
    await waitFor(() => assert.equal(button.disabled, false));
    fireEvent.click(button);
    await waitFor(() => assert.equal(opened.length, 1));
    assert.deepEqual(opened[0], { tab: { id: 'workflow', context: { kind: 'thread' }, availability: 'fixed' } });
    assert.equal(slot.inspection.rpcCalls.filter(c => c.method === 'setAifMode').length, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('thread toggle calls setAifMode and reflects the pressed state', async () => {
  const calls: unknown[] = [];
  const slot = renderSlot(modeAction, {}, {
    composer: { scope: { kind: 'thread', threadId: 'thr_test' } },
    rpc: { aifMode: () => modeView(false),
      setAifMode: (input: any) => { calls.push(input); return modeView(input.on); } },
  });
  try {
    const button = await slot.findByRole('button', { name: 'Режим AI Factory' }) as HTMLButtonElement;
    await waitFor(() => assert.equal(button.disabled, false));
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    fireEvent.click(button);
    await waitFor(() => assert.deepEqual(calls, [{ threadId: 'thr_test', on: true }]));
    await waitFor(() => assert.equal(button.getAttribute('aria-pressed'), 'true'));
  } finally { slot.lifecycle.unmount(); }
});

test('the app never inserts the AI Factory tag into the composer by itself', () => {
  assert.deepEqual(app.composerCustomizations.map(c => c.id).sort(), ['aif-mode', 'suggested-commands']);
});

test('turning the mode off removes the pill from the draft', async () => {
  const pillMention = { from: 0, to: 11, label: 'AI Factory', kind: 'plugin' as const, pluginId: 'test-plugin', provider: 'aif-mode', id: 'aif-mode', icon: null };
  const calls: unknown[] = [];
  const slot = renderSlot(modeAction, {}, {
    composer: { scope: { kind: 'thread', threadId: 'thr_test' }, text: '@AI Factory', mentions: [pillMention] },
    rpc: { aifMode: () => modeView(true),
      setAifMode: (input: any) => { calls.push(input); return modeView(input.on); } },
  });
  try {
    const button = await slot.findByRole('button', { name: 'Режим AI Factory' }) as HTMLButtonElement;
    await waitFor(() => assert.equal(button.disabled, false));
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    fireEvent.click(button);
    await waitFor(() => assert.deepEqual(calls, [{ threadId: 'thr_test', on: false }]));
    await waitFor(() => assert.equal(slot.inspection.composer.text, ''));
    assert.equal(pillMentions(slot.inspection.composer.draft).length, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('«В работе» shows the requested model and warns on fallback and mismatch', async () => {
  const s = snapshot(); s.actions = workflowActions(s);
  const child = (patch: Record<string, unknown>) => ({ id: 'thr_x', title: 'Тред', status: 'idle', providerId: 'codex',
    updatedAt: '2026-11-17T00:00:00Z', execution: null, fallback: null, mismatch: null, ...patch });
  const delegation = () => ({ choice: { mode: 'self' }, research: { mode: 'self' }, research2: { mode: 'self' }, research3: { mode: 'self' },
    configured: true, foreign: null, error: null, providers: [{ id: 'codex', name: 'Codex' }], defaults: null, appliedDefaults: null,
    children: [
      child({ id: 'thr_aif', title: 'AIF · demo · 1', status: 'active',
        execution: { model: 'gpt-6.2-sol', reasoning: 'high' },
        fallback: { from: 'gpt-6.2-sol', to: 'gpt-6.2-mini', reason: 'refusal' },
        mismatch: 'Ожидалась модель codex · gpt-6.2-luna' }),
      child({ id: 'thr_plain', title: 'Прочее', providerId: null }),
    ] });
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const slot = renderSlot(tab as any, { threadId: 'thr_working', environment: { id: 'env_working' } }, { rpc: { status: () => s, delegation } });
  try {
    const aifRow = (await slot.findByText('AIF · demo · 1')).closest('li')!;
    within(aifRow).getByText(/gpt-6\.2-sol · high/);
    within(aifRow).getByText(/Подмена: gpt-6\.2-sol → gpt-6\.2-mini \(отказ модели\)/);
    within(aifRow).getByText(/Ожидалась модель codex · gpt-6\.2-luna/);
    const plainRow = (await slot.findByText('Прочее')).closest('li')!;
    within(plainRow).getByText('готово');
    assert.ok(within(plainRow).queryByText(/⚠/) === null, 'element should be absent');
    assert.equal([...slot.container.querySelectorAll('span')].filter(el => el.textContent?.trim().startsWith('⚠')).length, 2);
  } finally { slot.lifecycle.unmount(); }
});

test('the enabled mode button uses its own orange fill with a white factory icon', async () => {
  const slot = renderSlot(modeAction, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: { aifMode: () => modeView(true, true) } });
  try {
    const button = await slot.findByRole('button', { name: 'Режим AI Factory' }) as HTMLButtonElement;
    await waitFor(() => assert.equal(button.getAttribute('aria-pressed'), 'true'));
    assert.equal(button.style.color, 'rgb(255, 255, 255)');
    assert.equal(button.style.background.includes('rgb(234, 88, 12)'), true);
    assert.ok(button.querySelector('svg path'), 'factory icon is drawn inline');
  } finally { slot.lifecycle.unmount(); }
});
