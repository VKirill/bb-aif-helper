import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { snapshot } from './fixtures.ts';
import { workflowActions } from '../workflow.ts';
import { lockUnchangedChecks } from '../check-actions.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { loadPluginApp, renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { experimental_makePanelController } = await import('@get-bb/plugin-sdk/testing');
const { fireEvent, waitFor, within } = await import('@testing-library/react');
const app = await loadPluginApp(() => import('../app.tsx'));
const props = { attributes: { phase: 'plan' }, source: '::aif-chat{phase="plan"}', message: { id: 'msg_1', threadId: 'thr_test', turnId: 'turn_1', projectId: 'proj_test' }, openWorkspaceFile: null };
function data() { const s = snapshot(); s.actions = workflowActions(s); return s; }

test('matching updater buttons are inside version details, with extension versions in the short line', async () => {
  const s = snapshot({ skills: ['aif', 'aif-analyze'], extensions: [{ name: 'aifhub-extension', recordedVersion: '1.8.1', installedVersion: '1.8.1', source: 'local', state: 'present', contributions: [] }] });
  s.versions.globalCli = s.versions.installed = s.versions.sourceVersion = s.versions.sourceWorktreeVersion = '2.21.0';
  s.upstream = { ...s.upstream, version: '2.21.0', checkedAt: new Date().toISOString() };
  s.actions = workflowActions(s);
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    const setup = await slot.findByRole('button', { name: 'Запустить aif-analyze' });
    const card = setup.closest('.aif-card')!;
    assert.match(card.querySelector('.aif-versions')!.textContent!, /aifhub-extension.*1.8.1/);
    const update = slot.getByRole('button', { name: 'Обновить AI Factory', hidden: true });
    assert(update.closest('.aif-details')); assert(!setup.closest('.aif-details'));
    assert(slot.getByRole('button', { name: 'Обновить расширения', hidden: true }).closest('.aif-details'));
    const check = slot.getByRole('button', { name: 'Проверить версию в GitHub', hidden: true }) as HTMLButtonElement;
    assert.equal(check.disabled, true); assert.ok(slot.getByText(/Следующая проверка GitHub/, { selector: 'span' }));
  } finally { slot.lifecycle.unmount(); }
});

test('configuration errors do not hide the installation update button', async () => {
  const s = snapshot({ profile: 'invalid', target: null, diagnostics: ['Выбранный план/change не найден в допустимых артефактах.'] }); s.actions = workflowActions(s);
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    assert.equal((await slot.findByRole('button', { name: 'Обновить AI Factory' }) as HTMLButtonElement).disabled, false);
    assert.equal(slot.queryByRole('button', { name: 'Выполнить план' }), null);
    assert.equal(slot.queryByRole('button', { name: 'Запустить aif' }), null);
  } finally { slot.lifecycle.unmount(); }
});

test('without AI Factory the card shows a separate installer and usable bundled flow without automatic dispatch', async () => {
  const s = snapshot({ configured: false, profile: 'none', target: null, candidates: [], skills: [], phase: 'unknown' });
  s.actions = workflowActions(s); let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: (input: any) => {
    assert.equal(input.actionId, 'basic-explore'); runs++; return { sent: true, message: 'Отправлено' };
  } } });
  try {
    const install = await slot.findByRole('button', { name: 'Установить AI Factory' }) as HTMLButtonElement;
    assert.equal(install.disabled, false); assert(install.closest('.aif-maintenance'));
    assert.match(slot.getByLabelText('Базовый workflow').textContent!, /исследование → план → выполнение → проверка → коммит/);
    const explore = slot.getByRole('button', { name: 'Исследовать задачу' }) as HTMLButtonElement;
    assert.equal(explore.disabled, false); assert.equal(runs, 0);
    assert.equal(slot.queryByRole('button', { name: /Запустить aif/ }), null);
    fireEvent.click(explore); await waitFor(() => assert.equal(runs, 1));
  } finally { slot.lifecycle.unmount(); }
});

test('a started plan shows resume while context setup is available only under its spoiler', async () => {
  const s = snapshot({ profile: 'aifhub-openspec', phase: 'unknown', skills: ['aif-analyze', 'aif-implement', 'aif-improve'],
    extensions: [{ name: 'aifhub-extension', recordedVersion: '1.8.1', installedVersion: '1.8.1', source: 'local', state: 'present', contributions: [] }] });
  s.target!.tasks = [{ id: '1', title: 'Done', done: true }, { id: '2', title: 'Remaining', done: false }];
  s.actions = workflowActions(s);
  let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    await slot.findByRole('button', { name: 'Продолжить выполнение' });
    const setup = slot.getByRole('button', { name: 'Запустить aif-analyze', hidden: true });
    const details = setup.closest('details')!;
    assert(details.classList.contains('aif-context-setup')); assert.equal(details.open, false);
    assert(!setup.closest('.aif-maintenance'));
    assert.match(slot.getByText(/Контекст задачи/).textContent!, /агент свободен/);
    assert.equal(runs, 0);
    fireEvent.click(slot.getByText('Настройка контекста проекта'));
    assert.equal(details.open, true);
    assert.equal((slot.getByRole('button', { name: 'Запустить aif-analyze' }) as HTMLButtonElement).disabled, false);
    assert.equal(runs, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('registered extensions have a separate update button even with an invalid selected plan', async () => {
  const s = snapshot({ profile: 'invalid', extensions: [{ name: 'aifhub-extension', recordedVersion: '1.7.1', installedVersion: '1.7.1', source: 'local', state: 'present', contributions: [] }] }); s.actions = workflowActions(s);
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    assert.equal((await slot.findByRole('button', { name: 'Обновить расширения' }) as HTMLButtonElement).disabled, false);
    assert.equal(slot.queryByRole('button', { name: 'Выполнить план' }), null);
  } finally { slot.lifecycle.unmount(); }
});

test('saved-data state is visible and the refresh button explicitly bypasses the cache', async () => {
  const s = data(); s.cache = { source: 'saved', refreshing: true, refreshError: false };
  const requests: any[] = [];
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: (input: any) => { requests.push(input); return s; } } });
  try {
    await slot.findByText(/Сохранённые данные.*обновляются в фоне/);
    fireEvent.click(slot.getByRole('button', { name: 'Обновить статус AI Factory' }));
    await waitFor(() => assert(requests.some(input => input.force === true)));
    assert.notEqual(requests[0].force, true, 'the shared read never forces');
  } finally { slot.lifecycle.unmount(); }
});

test('the card reads status once and re-reads only when its thread tag is invalidated', async () => {
  let reads = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => { reads++; return data(); } } });
  try {
    await slot.findByRole('button', { name: 'Улучшить план' });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(reads, 1, 'no polling');
    await slot.behavior.experimental_invalidateRpc(['thread:other']);
    assert.equal(reads, 1, 'another thread does not refresh this card');
    await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    assert.equal(reads, 2);
  } finally { slot.lifecycle.unmount(); }
});

test('check buttons belong to their rows and unchanged checks show an accurate disabled reason', async () => {
  const s = data(); s.checks = ['verify', 'security'].map(id => ({ id, label: id === 'verify' ? 'Соответствие плану' : 'Безопасность', state: 'notrun', detail: '', path: null, required: false }));
  s.checks[0].chat = { seq: 1, at: s.collectedAt, target: s.target!.path, freshness: 'unchanged', inputFingerprint: 'a'.repeat(64),
    result: { schema_version: 1, gate: 'verify', status: 'warn', blocking: false, blockers: [], affected_files: [], suggested_next: null } };
  lockUnchangedChecks(s);
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    const verify = await slot.findByRole('button', { name: 'Соответствие плану · без изменений', hidden: true });
    const security = slot.getByRole('button', { name: 'Безопасность', hidden: true });
    assert(verify.closest('li')?.textContent?.includes('Соответствие плану'));
    assert(security.closest('li')?.textContent?.includes('Безопасность'));
    assert.equal((verify as HTMLButtonElement).disabled, true);
    assert.equal((security as HTMLButtonElement).disabled, false);
    assert.match(verify.closest('li')!.textContent!, /не изменились/);
    assert(!verify.textContent?.includes('не установлен'));
    assert.equal(slot.queryAllByRole('button', { name: 'Соответствие плану · без изменений', hidden: true }).length, 1);
  } finally { slot.lifecycle.unmount(); }
});

test('only gate JSON gets a collapsed renderer; original code remains available unchanged', () => {
  const renderer = app.codeFenceRenderers.find(r => r.id === 'gate-data')!;
  assert.deepEqual(renderer.languages, ['aif-gate-result']);
  const code = JSON.stringify({ schema_version: 1, gate: 'verify', status: 'warn', blocking: false, blockers: [], affected_files: [], suggested_next: null }, null, 2);
  const slot = renderSlot(renderer, { code, language: 'aif-gate-result', status: 'closed', index: 0, message: props.message, Original: () => code });
  try {
    const summary = slot.getByText('Данные gate · verify · WARN');
    const details = summary.closest('details')!;
    assert.equal(details.open, false); assert(details.textContent?.includes(code));
    fireEvent.click(summary); assert.equal(details.open, true);
    assert.equal(slot.queryByRole('alert'), null);
  } finally { slot.lifecycle.unmount(); }
});

test('supplementary rows are optional without downgrading known required gates or launching checks', async () => {
  const s = snapshot({ profile: 'aifhub-openspec' }); s.target!.kind = 'openspec';
  s.checks = ['rules', 'security', 'review', 'qa-plan', 'qa', 'quality', 'ci', 'mode'].map(id => ({
    id, label: id, state: 'notrun', detail: '', path: null, required: id === 'rules',
  }));
  s.actions = workflowActions(s); let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    await slot.findByText(/Дополнительные проверки — по выбору/);
    const required = slot.getByText('rules').closest('li')!;
    assert.match(required.textContent!, /нужно для завершения/);
    assert(!required.textContent!.includes('по выбору'));
    for (const label of ['security', 'review', 'qa-plan', 'qa', 'quality', 'ci', 'mode']) {
      assert.match(slot.getByText(label).closest('li')!.textContent!, /по выбору/);
    }
    const doctor = slot.getByRole('button', { name: 'Проверить конфигурацию', hidden: true });
    assert.equal(doctor.closest('li'), slot.getByText('mode').closest('li'));
    fireEvent.click(slot.getByText(/Что проверить/)); assert.equal(runs, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('malformed and interrupted gate failures remain visible outside collapsed JSON', () => {
  const renderer = app.codeFenceRenderers.find(r => r.id === 'gate-data')!;
  for (const [code, status, expected] of [['{bad', 'closed', /некорректный JSON/], ['{', 'unclosed', /не закрыт/]] as const) {
    const slot = renderSlot(renderer, { code, status, language: 'aif-gate-result', index: 0, message: props.message, Original: () => code });
    try {
      const alert = slot.getByRole('alert'); assert.match(alert.textContent!, expected); assert(!alert.closest('details'));
      assert.equal(slot.getByText('Данные gate · проверить JSON').closest('details')!.open, false);
    } finally { slot.lifecycle.unmount(); }
  }
});

test('streaming partial gate stays collapsed without a premature JSON error', () => {
  const slot = renderSlot(app.codeFenceRenderers[0], { code: '{', status: 'streaming', language: 'aif-gate-result', index: 0, message: props.message, Original: () => '{' });
  try {
    assert.equal(slot.getByText('Данные gate · формируются…').closest('details')!.open, false);
    assert.equal(slot.queryByRole('alert'), null);
  } finally { slot.lifecycle.unmount(); }
});

test('checks distinguish completed chat WARN from missing file evidence', async () => {
  const s = data(); s.checks = [{ id: 'verify', label: 'Соответствие плану', state: 'notrun', detail: 'Unknown launch', path: null, required: false,
    chat: { seq: 12, at: '2026-11-02T12:00:00Z', target: s.target!.path, freshness: 'unknown',
      result: { schema_version: 1, gate: 'verify', status: 'warn', blocking: false, blockers: [], affected_files: [], suggested_next: null } } }];
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    await slot.findByText('WARN · из чата');
    await slot.findByText(/Актуальность для текущих файлов не подтверждена/);
    await slot.findByText('Файловый отчёт: не найден.');
    assert(!slot.queryByText('Unknown launch'));
  } finally { slot.lifecycle.unmount(); }
});

test('registers chat renderer and thread context card without replacing composer or sidebar', () => {
  assert.equal(app.messageDirectives[0].id, 'aif-chat'); assert.equal(app.threadContextCardSections.length, 1);
  assert.equal(app.navPanels.length, 0);
});
test('persistent header control opens the registered workflow tab without dispatching a command', async () => {
  const header = app.threadActions.find(a => a.id === 'open-workflow')!;
  assert.equal(header.placement, 'header');
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  assert.equal(tab.availability, 'fixed'); assert.deepEqual(tab.context, { kind: 'thread' });
  const opened: unknown[] = [];
  const action = header.item({ experimental_panel: experimental_makePanelController({ openTab: options => { opened.push(options); return true; } }) } as any)!;
  assert.equal(action.label, 'AI Factory'); assert.equal(action.disabled, undefined);
  assert.equal(opened.length, 0);
  await action.run({ requestRename() {} });
  assert.deepEqual(opened, [{ tab: { id: 'workflow', context: { kind: 'thread' }, availability: 'fixed' } }]);
});
test('workflow panel reads its owning thread and exposes maintenance without a transcript card', async () => {
  const readThreads: string[] = []; let runs = 0;
  const s = data();
  s.readiness = [
    { id: 'install', label: 'Установить AI Factory', actionId: 'update-factory', state: 'done', skippable: false, anyOf: false, missing: [] },
    { id: 'context', label: 'Описать проект (/aif или aif-analyze)', actionId: 'setup-context', state: 'todo', skippable: false, anyOf: false, missing: [] },
  ];
  const tab = app.tabs.find((t): t is Extract<(typeof app.tabs)[number], { availability: 'fixed'; context: { kind: 'thread' } }> => t.id === 'workflow' && t.availability === 'fixed' && t.context.kind === 'thread')!;
  const slot = renderSlot(tab, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, {
    rpc: { status: (input: any) => { readThreads.push(input.threadId); return s; }, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } },
  });
  try {
    await slot.findByRole('button', { name: 'Обновить AI Factory' });
    await slot.findByText('Проект не подготовлен к AI Factory');
    await slot.findByText('Основных шагов осталось: 1 из 2');
    assert.equal(slot.queryByRole('button', { name: 'Запустить: Описать проект (/aif или aif-analyze)' }), null, 'navigation shows a prompt, not the step list');
    fireEvent.click(slot.getByRole('button', { name: 'Подготовить' }));
    assert.equal(slot.getByRole('tab', { name: /Настройки/ }).getAttribute('aria-selected'), 'true');
    await slot.findByRole('button', { name: 'Запустить: Описать проект (/aif или aif-analyze)' });
    assert.deepEqual(readThreads, ['thr_panel']); assert.equal(runs, 0);
  } finally { slot.lifecycle.unmount(); window.sessionStorage.clear(); }
});
test('panel uses the BB provider/model picker and saves exactly its selection', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const saved: unknown[] = [];
  const view = (choice: unknown, research: unknown = { mode: 'self' }) => ({ choice, research, research2: { mode: 'self' }, research3: { mode: 'self' }, configured: true, foreign: null, error: null, providers: [{ id: 'codex', name: 'Codex' }],
    defaults: null, appliedDefaults: null,
    children: [{ id: 'thr_child', title: 'Задача 1', status: 'active', providerId: 'codex', updatedAt: '2026-11-17T00:00:00Z', execution: null, fallback: null, mismatch: null }] });
  const slot = renderSlot(tab as any, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, { rpc: {
    status: () => data(),
    delegation: () => view({ mode: 'self' }),
    setDelegation: (input: any) => { saved.push(input); return input.role === 'research' ? view({ mode: 'self' }, input.choice) : view(input.choice); },
  } });
  try {
    await slot.findByText('Задача 1');
    assert.ok(slot.getByText(/Codex · работает/));
    assert.equal(slot.queryByRole('button', { name: 'Сохранить' }), null);
    fireEvent.click(slot.getByRole('tab', { name: /Настройки/ }));
    await slot.findByRole('button', { name: 'Изменить: Код' });
    for (const title of ['Код', 'Разведчик 1', 'Разведчик 2', 'Разведчик 3'])
      assert.ok(slot.getByRole('button', { name: `Изменить: ${title}` }), `edit button for ${title}`);
    assert.equal(slot.queryAllByRole('radiogroup').length, 0, 'role editors open only on «Изменить»');
    const openEditor = async (title: string) => {
      fireEvent.click(slot.getByRole('button', { name: `Изменить: ${title}` }));
      return slot.findByRole('radiogroup');
    };
    const closeEditor = (group: HTMLElement) => fireEvent.click(within(group.parentElement!).getByRole('button', { name: 'Отменить' }));
    let group = await openEditor('Разведчик 2');
    assert.equal(group.getAttribute('aria-label'), 'Кто ищет шаблоны');
    assert.ok(within(group).getByRole('radio', { name: 'Как разведчик 1' }), 'worker 2 has its own choice');
    closeEditor(group);
    group = await openEditor('Разведчик 3');
    assert.equal(group.getAttribute('aria-label'), 'Кто ищет связи');
    assert.ok(within(group).getByRole('radio', { name: 'Как разведчик 1' }));
    closeEditor(group);
    group = await openEditor('Код');
    assert.equal(group.getAttribute('aria-label'), 'Кто пишет код');
    fireEvent.click(within(group).getByRole('radio', { name: 'Другая модель' }));
    const picker = await slot.findByTestId('bb-provider-model-picker');
    assert.equal(picker.dataset.routingKind, 'environment'); assert.equal(picker.dataset.routingId, 'env_panel');
    fireEvent.change(slot.getByLabelText('Provider ID'), { target: { value: 'codex' } });
    fireEvent.change(slot.getByLabelText('Model'), { target: { value: 'gpt-6.2-sol' } });
    fireEvent.change(slot.getByLabelText('Reasoning level'), { target: { value: 'high' } });
    fireEvent.change(slot.getByLabelText('Service tier'), { target: { value: 'fast' } });
    fireEvent.click(slot.getByRole('button', { name: 'Apply execution selection' }));
    fireEvent.click(await slot.findByRole('button', { name: 'Сохранить' }));
    await waitFor(() => assert.equal(saved.length, 1));
    assert.deepEqual(saved, [{ threadId: 'thr_panel', role: 'implement', choice: { mode: 'bb', providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high', tier: 'fast' } }]);
    await slot.findByText('Codex · gpt-6.2-sol · high');
    group = await openEditor('Разведчик 1');
    assert.equal(group.getAttribute('aria-label'), 'Кто исследует код');
    fireEvent.click(within(group).getByRole('radio', { name: 'Другая модель' }));
    await waitFor(() => assert.equal(slot.getAllByTestId('bb-provider-model-picker').length, 1));
    const research = within(slot.getAllByTestId('bb-provider-model-picker')[0]);
    fireEvent.change(research.getByLabelText('Provider ID'), { target: { value: 'codex' } });
    fireEvent.change(research.getByLabelText('Model'), { target: { value: 'gpt-6.2-luna' } });
    fireEvent.click(research.getByRole('button', { name: 'Apply execution selection' }));
    fireEvent.click(await slot.findByRole('button', { name: 'Сохранить' }));
    await waitFor(() => assert.equal(saved.length, 2));
    assert.equal((saved[1] as any).role, 'research'); assert.equal((saved[1] as any).choice.model, 'gpt-6.2-luna');
    await slot.findByText(/Codex · gpt-6\.2-luna/);
  } finally { slot.lifecycle.unmount(); }
});
test('card renders real buttons, read-only progress and sends selected action once', async () => {
  let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => data(), run: () => { runs++; return { sent: true, message: 'Команда отправлена' }; } } });
  try {
    const button = await slot.findByRole('button', { name: 'Улучшить план' });
    await slot.findByText('0/1 задач');
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => assert.equal(runs, 1));
    assert.equal(slot.queryAllByRole('checkbox').length, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('dirty files show commit without an active plan and busy state disables it without sending', async () => {
  for (const busy of [false, true]) {
    const s = snapshot({ profile: 'aifhub-openspec', phase: 'done', target: null, candidates: [],
      worktree: { hasUncommitted: true }, threadState: busy ? 'active' : 'idle' });
    s.actions = workflowActions(s); let runs = 0;
    const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } } });
    try {
      const commit = await slot.findByRole('button', { name: 'Подготовить коммит' }) as HTMLButtonElement;
      assert.equal(commit.disabled, busy); assert.equal(runs, 0);
      assert.equal(slot.queryAllByRole('button', { name: 'Подготовить коммит' }).length, 1);
    } finally { slot.lifecycle.unmount(); }
  }
});
test('busy thread shows waiting state and disables action buttons', async () => {
  const s = data(); s.threadState = 'awaiting_input'; s.pendingQuestions = 2;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    await slot.findByText(/ожидаю ответы: 2/);
    assert.equal((slot.getByRole('button', { name: 'Улучшить план' }) as HTMLButtonElement).disabled, true);
  } finally { slot.lifecycle.unmount(); }
});
test('metadata failure removes stale actions instead of keeping executable old snapshot', async () => {
  let fails = false;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => { if (fails) throw new Error('metadata unavailable'); return data(); } } });
  try {
    await slot.findByRole('button', { name: 'Улучшить план' }); fails = true;
    fireEvent.click(slot.getByRole('button', { name: 'Обновить статус AI Factory' }));
    await slot.findByText('metadata unavailable');
    assert.equal(slot.queryByRole('button', { name: 'Улучшить план' }), null);
  } finally { slot.lifecycle.unmount(); }
});
test('maintenance buttons are visible before plan selection and update dispatch is click-only', async () => {
  const s = snapshot({ target: null, candidates: [] }); s.actions = workflowActions(s);
  let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: (v: any) => { assert.equal(v.actionId, 'update-factory'); runs++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    const update = await slot.findByRole('button', { name: 'Обновить AI Factory' });
    await slot.findByRole('button', { name: 'Запустить aif' }); assert.equal(runs, 0);
    fireEvent.click(update); await waitFor(() => assert.equal(runs, 1));
  } finally { slot.lifecycle.unmount(); }
});
test('AIFHub context button is analyze and obeys busy-state disabling', async () => {
  const s = snapshot({ skills: ['aif-analyze'], threadState: 'active', extensions: [{ name: 'aifhub-extension', recordedVersion: '1.8.1', installedVersion: '1.8.1', state: 'present', source: 'local', contributions: [] }] }); s.actions = workflowActions(s);
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try { assert.equal((await slot.findByRole('button', { name: 'Запустить aif-analyze' }) as HTMLButtonElement).disabled, true); }
  finally { slot.lifecycle.unmount(); }
});

function suggestedData() { return { sourceKey: 'c'.repeat(64), fingerprint: 'a'.repeat(64), threadState: 'idle', items: ['aif-architecture', 'aif-roadmap'].map(id => ({ id, command: `$${id}`, available: true, reason: 'Из последнего ответа' })) }; }
const banner = app.composerCustomizations.find(c => c.id === 'suggested-commands')!.banners![0];

test('PASS with a null command renders without an error and labels its reason as explanation', async () => {
  const gate = { schema_version: 1, gate: 'rules', status: 'pass', blocking: false, blockers: [], affected_files: [],
    suggested_next: { command: null, reason: 'No explicit rule violations or rule updates required.' } };
  const fence = renderSlot(app.codeFenceRenderers[0], { code: JSON.stringify(gate), language: 'aif-gate-result', status: 'closed', index: 0, message: props.message, Original: () => JSON.stringify(gate) });
  try { fence.getByText('Данные gate · rules · PASS'); assert.equal(fence.queryByRole('alert'), null); }
  finally { fence.lifecycle.unmount(); }
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } },
    rpc: { suggestions: () => ({ ...suggestedData(), items: [], gateError: null, gate }) } });
  try {
    await slot.findByText('rules · PASS в ответе'); slot.getByText('Пояснение:');
    assert.equal(slot.queryByText('Следующий шаг:'), null); assert.equal(slot.queryByRole('alert'), null);
    assert.equal(slot.queryByText('Из ответа агента'), null);
  } finally { slot.lifecycle.unmount(); }
});
test('composer suggestions have a separate dismiss control and never dispatch during discovery or removal', async () => {
  assert.deepEqual(app.composerCustomizations.find(c => c.id === 'suggested-commands')!.scopes, ['thread']);
  let current = suggestedData(); let sends = 0;
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' }, text: 'Мой черновик' }, rpc: {
    suggestions: () => current,
    dismissSuggestion: (input: any) => { current = { ...current, items: current.items.filter(i => i.id !== input.commandId) }; return { dismissed: true }; },
    runSuggestion: () => { sends++; return { sent: false, stale: true, message: 'Не должно вызываться' }; },
  } });
  try {
    await slot.findByRole('button', { name: '$aif-architecture + ваш текст из поля' });
    await slot.findByRole('button', { name: '$aif-roadmap + ваш текст из поля' });
    fireEvent.click(slot.getByRole('button', { name: 'Удалить предложение $aif-architecture' }));
    await waitFor(() => assert(!slot.queryByRole('button', { name: '$aif-architecture + ваш текст из поля' })));
    assert(slot.getByRole('button', { name: '$aif-roadmap + ваш текст из поля' })); assert.equal(sends, 0);
    await slot.behavior.experimental_invalidateRpc(['thread:thr_test']);
    assert.equal(slot.queryByRole('button', { name: '$aif-architecture + ваш текст из поля' }), null);
    assert.equal(slot.inspection.composer.text, 'Мой черновик');
  } finally { slot.lifecycle.unmount(); }
});
test('suggested command submits the composer draft once and a double click cannot send twice', async () => {
  let calls = 0; let dismissals = 0;
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' }, text: 'Keep draft' }, rpc: {
    suggestions: () => suggestedData(),
    runSuggestion: (input: any) => { assert.equal(input.commandId, 'aif-roadmap'); assert.equal(input.threadId, 'thr_test'); calls++;
      return { sent: false, message: 'Команда подставлена в поле ввода.', command: '$aif-roadmap',
        data: { source: 'aif-chat', sourceKey: 'c'.repeat(64), commandId: 'aif-roadmap', fingerprint: 'a'.repeat(64), gate: null } }; },
    dismissSuggestion: () => { dismissals++; return { dismissed: true }; },
  } });
  try {
    const button = await slot.findByRole('button', { name: '$aif-roadmap + ваш текст из поля' }); assert.equal(calls, 0);
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => assert.equal(calls, 1));
    await waitFor(() => assert.equal(slot.inspection.composer.submits.length, 1));
    const submit = slot.inspection.composer.submits[0];
    assert.equal(submit.experimental_mode, 'queue-if-active');
    assert.equal((submit.experimental_data as any).source, 'aif-chat');
    assert.equal((submit.experimental_data as any).commandId, 'aif-roadmap');
    await waitFor(() => assert.equal(dismissals, 1));
    assert.equal(slot.inspection.composer.text, '');
  } finally { slot.lifecycle.unmount(); }
});
test('empty composer plus a topic chip fills the draft and focuses without submitting', async () => {
  let dismissals = 0;
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: {
    suggestions: () => ({ ...suggestedData(), items: [{ id: 'aif-plan', command: '/aif-plan', available: true, reason: 'Из последнего ответа' }] }),
    runSuggestion: () => ({ sent: false, message: 'Команда подставлена в поле ввода.', command: '/aif-plan',
      data: { source: 'aif-chat', sourceKey: 'c'.repeat(64), commandId: 'aif-plan', fingerprint: 'a'.repeat(64), gate: null } }),
    dismissSuggestion: () => { dismissals++; return { dismissed: true }; },
  } });
  try {
    const button = await slot.findByRole('button', { name: '/aif-plan' });
    const focusBefore = slot.inspection.composer.focusCount;
    fireEvent.click(button);
    await waitFor(() => assert.equal(slot.inspection.composer.text, '/aif-plan '));
    await waitFor(() => assert.equal(dismissals, 1));
    assert.equal(slot.inspection.composer.focusCount, focusBefore + 1);
    assert.equal(slot.inspection.composer.submits.length, 0);
    await slot.findByText('Команда подставлена в поле ввода.');
  } finally { slot.lifecycle.unmount(); }
});
test('composer with text plus a chip submits the command with the draft as the topic', async () => {
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' }, text: 'добавь логин' }, rpc: {
    suggestions: () => ({ ...suggestedData(), items: [{ id: 'aif-verify', command: '/aif-verify', available: true, reason: 'Из последнего ответа' }] }),
    runSuggestion: () => ({ sent: false, message: 'Отправлено', command: '/aif-verify',
      data: { source: 'aif-chat', sourceKey: 'c'.repeat(64), commandId: 'aif-verify', fingerprint: 'a'.repeat(64), gate: null } }),
    dismissSuggestion: () => ({ dismissed: true }),
  } });
  try {
    const button = await slot.findByRole('button', { name: '/aif-verify + ваш текст из поля' });
    fireEvent.click(button);
    await waitFor(() => assert.equal(slot.inspection.composer.submits.length, 1));
    const submit = slot.inspection.composer.submits[0];
    assert.equal(submit.experimental_mode, 'queue-if-active');
    assert.equal((submit.experimental_data as any).source, 'aif-chat');
    assert.equal((submit.experimental_data as any).commandId, 'aif-verify');
    assert.equal(slot.inspection.composer.text, '');
  } finally { slot.lifecycle.unmount(); }
});
test('stale chip result shows a notice without touching the composer or dismissing', async () => {
  let dismissals = 0;
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' }, text: 'Keep draft' }, rpc: {
    suggestions: () => suggestedData(),
    runSuggestion: () => ({ sent: false, stale: true, message: 'Карточка обновилась. Проверьте задачу и нажмите ещё раз.' }),
    dismissSuggestion: () => { dismissals++; return { dismissed: true }; },
  } });
  try {
    const button = await slot.findByRole('button', { name: '$aif-roadmap + ваш текст из поля' });
    fireEvent.click(button);
    await slot.findByText('Карточка обновилась. Проверьте задачу и нажмите ещё раз.');
    assert.equal(slot.inspection.composer.text, 'Keep draft');
    assert.equal(slot.inspection.composer.submits.length, 0);
    assert.equal(slot.inspection.composer.focusCount, 0);
    assert.equal(dismissals, 0);
  } finally { slot.lifecycle.unmount(); }
});
test('busy composer disables command launch but allows removing a suggestion', async () => {
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' }, isRunning: true }, rpc: { suggestions: () => suggestedData() } });
  try {
    assert.equal((await slot.findByRole('button', { name: '$aif-roadmap' }) as HTMLButtonElement).disabled, true);
    assert.equal((slot.getByRole('button', { name: 'Удалить предложение $aif-roadmap' }) as HTMLButtonElement).disabled, false);
  } finally { slot.lifecycle.unmount(); }
});
test('suggestion banner follows composer scope and rejects an old thread response arriving late', async () => {
  let finishOld!: (value: ReturnType<typeof suggestedData>) => void;
  const old = new Promise<ReturnType<typeof suggestedData>>(resolve => { finishOld = resolve; });
  const fresh = { ...suggestedData(), items: [{ id: 'aif-plan', command: '$aif-plan', available: true, reason: 'New thread' }] };
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_old' } }, rpc: { suggestions: (input: any) => input.threadId === 'thr_old' ? old : fresh } });
  try {
    await slot.behavior.setComposerScope({ kind: 'thread', threadId: 'thr_new' });
    await slot.findByRole('button', { name: '$aif-plan' });
    finishOld(suggestedData());
    await waitFor(() => assert(!slot.queryByRole('button', { name: '$aif-roadmap' })));
    await slot.behavior.setComposerScope({ kind: 'new-thread', projectId: 'proj_test' });
    assert.equal(slot.queryByRole('button', { name: '$aif-plan' }), null);
  } finally { slot.lifecycle.unmount(); }
});

test('gate problems remain visible even with no suggested command', async () => {
  const data = { ...suggestedData(), items: [], gateError: null, gate: { schema_version: 1, gate: 'verify', status: 'fail', blocking: true, blockers: [{ id: 'verify-1', severity: 'error', file: 'src/demo.ts', summary: 'Required behavior is missing.' }], affected_files: ['src/demo.ts'], suggested_next: null } };
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: { suggestions: () => data } });
  try {
    await slot.findByText('verify · FAIL в ответе');
    await slot.findByText('Required behavior is missing.');
    assert(slot.getByText('Блокирует следующий этап')); assert(slot.getByText('Блокирующие проблемы · 1'));
    assert.equal(slot.queryByText('Из ответа агента'), null);
  } finally { slot.lifecycle.unmount(); }
});
test('non-blocking gate reason and command render independently; dismiss does not hide the report', async () => {
  let data = { ...suggestedData(), items: [{ id: 'aif-commit', command: '$aif-commit', available: true, reason: 'Only non-blocking warnings remain.' }], gateError: null, gate: { schema_version: 1, gate: 'verify', status: 'warn', blocking: false, blockers: [], affected_files: ['src/demo.ts'], suggested_next: { command: '/aif-commit', reason: 'Only non-blocking warnings remain.' } } };
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: {
    suggestions: () => data, dismissSuggestion: () => { data = { ...data, items: [] }; return { dismissed: true }; },
  } });
  try {
    await slot.findByText('verify · WARN в ответе');
    assert(slot.getByText(/Only non-blocking warnings remain/));
    fireEvent.click(slot.getByRole('button', { name: 'Удалить предложение $aif-commit' }));
    await waitFor(() => assert(!slot.queryByRole('button', { name: '$aif-commit' })));
    assert(slot.getByText('verify · WARN в ответе')); assert(slot.getByText('Блокирующих проблем нет.'));
  } finally { slot.lifecycle.unmount(); }
});

test('readiness block in the tab: one run button on the first todo step, skip RPC, collapsed when ready, absent from chat cards', async () => {
  const { applyRan, readinessSteps } = await import('../readiness.ts');
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data(); s.readiness = readinessSteps({ configured: true, contextSkill: true, files: {}, paths: {} });
  let runs: string[] = []; const skips: unknown[] = [];
  const rpc = { status: () => s, run: (input: any) => { runs.push(input.actionId); return { sent: true, message: 'Отправлено' }; },
    setReadinessSkip: (input: any) => { skips.push(input); return { ok: true }; } };
  let slot = renderSlot(tab as any, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, { rpc });
  try {
    await slot.findByText('Подготовка проекта', { selector: '*' });
    await slot.findByText('Выполнено · 1', { exact: false });
    const run = await slot.findByRole('button', { name: /^Запустить: Описать проект/ });
    assert.equal(slot.getAllByRole('button', { name: /^Запустить: / }).length, s.readiness.filter(step => step.state === 'todo').length, 'every unfinished step can be run');
    await slot.findByRole('button', { name: 'Запустить: Настроить CI' });
    assert.equal(slot.queryByText('Настройка контекста проекта'), null);
    assert.equal(slot.queryByText('Дополнительно'), null);
    assert.equal(slot.queryByText(/^Не найдено:/), null, 'missing files stay behind «?» to keep rows one line high');
    fireEvent.click(await slot.findByRole('button', { name: 'Что делает шаг «Описать проект (/aif или aif-analyze)»' }));
    await slot.findByText('Не найдено: .ai-factory/DESCRIPTION.md, .ai-factory/config.yaml, .ai-factory/rules/base.md, AGENTS.md');
    assert.equal(slot.queryByText(/^любой из:/), null, "any-of file lists live behind «?» to keep phone rows short");
    fireEvent.click(run);
    await waitFor(() => assert.deepEqual(runs, ['setup-context']));
    fireEvent.click(slot.getByRole('button', { name: 'Пропустить: Настроить CI' }));
    await waitFor(() => assert.deepEqual(skips, [{ threadId: 'thr_panel', stepId: 'ci', skipped: true }]));
  } finally { slot.lifecycle.unmount(); }
  const files = Object.fromEntries(['.ai-factory/DESCRIPTION.md', '.ai-factory/config.yaml', '.ai-factory/rules/base.md', 'AGENTS.md', '.ai-factory/ARCHITECTURE.md', 'lefthook.yml', 'Jenkinsfile', 'docs/index.md', '.ai-factory/RULES.md', 'Makefile', 'Dockerfile'].map(f => [f, true]));
  s.readiness = applyRan(readinessSteps({ configured: true, contextSkill: true, files, paths: {} }), ['docs']);
  slot = renderSlot(tab as any, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, { rpc });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    await slot.findByText('Проект готов к работе через AI Factory');
    assert.equal(slot.queryByText('Выполните шаги по порядку, чтобы AI Factory работал полностью'), null);
  } finally { slot.lifecycle.unmount(); }
  const card = renderSlot(app.messageDirectives[0] as any, props as any, { rpc });
  try {
    await card.findByRole('button', { name: 'Улучшить план' });
    assert.equal(card.queryByText('Подготовка проекта'), null);
    assert.equal(card.queryByText('Проект готов к работе через AI Factory'), null);
  } finally { card.lifecycle.unmount(); }
});

test('each check row has a «?» button that toggles a plain explanation without launching the check', async () => {
  const { checkHelp } = await import('../check-actions.ts');
  const s = data();
  s.checks = [{ id: 'verify', label: 'Соответствие плану', state: 'notrun', detail: 'Отчёт проверки не найден', path: null, required: false }];
  s.actions = workflowActions(s); let runs = 0;
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    const button = await slot.findByRole('button', { name: 'Что проверяет «Соответствие плану»', hidden: true });
    assert.equal(slot.queryByText(checkHelp.verify), null);
    fireEvent.click(button);
    await slot.findByText(checkHelp.verify);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    fireEvent.click(button);
    await waitFor(() => assert.equal(slot.queryByText(checkHelp.verify), null));
    assert.equal(runs, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('each readiness step has a «?» button that explains the step without running it', async () => {
  const { readinessSteps, readinessHelp } = await import('../readiness.ts');
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data(); s.readiness = readinessSteps({ configured: true, contextSkill: true, files: {}, paths: {} });
  let runs = 0;
  const slot = renderSlot(tab as any, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, { rpc: { status: () => s, run: () => { runs++; return { sent: true, message: 'Отправлено' }; } } });
  try {
    for (const step of s.readiness) assert.ok(readinessHelp[step.id], `help for ${step.id}`);
    const button = await slot.findByRole('button', { name: 'Что делает шаг «Настроить CI»' });
    assert.equal(slot.queryByText(readinessHelp.ci), null);
    fireEvent.click(button);
    await slot.findByText(readinessHelp.ci);
    fireEvent.click(button);
    await waitFor(() => assert.equal(slot.queryByText(readinessHelp.ci), null));
    assert.equal(runs, 0);
  } finally { slot.lifecycle.unmount(); }
});

test('«Другие команды» in the tab offers roadmap and archive with a «?» each', async () => {
  const { toolHelp } = await import('../check-actions.ts');
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data(); s.skills = [...s.skills, 'aif-docs', 'aif-roadmap', 'aif-rules', 'aif-build-automation', 'aif-dockerize', 'aif-archive'];
  s.actions = workflowActions(s);
  const tools = s.actions.filter(a => toolHelp[a.id]);
  assert.deepEqual(tools.map(a => a.id), Object.keys(toolHelp));
  assert.ok(tools.every(a => a.available && a.group === 'setup'));
  assert.match(tools.find(a => a.id === 'roadmap-setup')!.command, /^[/$]aif-roadmap$/);
  const runs: string[] = [];
  const slot = renderSlot(tab as any, { threadId: 'thr_panel', environment: { id: 'env_panel' } }, { rpc: { status: () => s, run: (input: any) => { runs.push(input.actionId); return { sent: true, message: 'Отправлено' }; } } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    fireEvent.click(await slot.findByText('Другие команды', { selector: '*' }));
    const help = await slot.findByRole('button', { name: 'Что делает «Roadmap»' });
    fireEvent.click(help);
    await slot.findByText(toolHelp['roadmap-setup']);
    assert.deepEqual(runs, []);
    fireEvent.click(await slot.findByRole('button', { name: 'Roadmap' }));
    await waitFor(() => assert.deepEqual(runs, ['roadmap-setup']));
  } finally { slot.lifecycle.unmount(); }
});

function delegView(patch: { children?: any[]; defaults?: any; appliedDefaults?: string | null } = {}) {
  return { choice: { mode: 'self' }, research: { mode: 'self' }, research2: { mode: 'self' }, research3: { mode: 'self' },
    configured: true, foreign: null, error: null, providers: [{ id: 'codex', name: 'Codex' }],
    children: [], defaults: null, appliedDefaults: null, ...patch };
}

test('the panel tab splits navigation and settings between current work and one-time configuration', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const slot = renderSlot(tab as any, { threadId: 'thr_split', environment: { id: 'env_split' } }, { rpc: { status: () => s, delegation: () => delegView() } });
  try {
    slot.getByRole('tablist', { name: 'Раздел панели' });
    await slot.findByText('Сейчас');
    assert.equal(slot.queryByText('Исполнители'), null);
    fireEvent.click(slot.getByRole('tab', { name: /Настройки/ }));
    await slot.findByRole('button', { name: 'Изменить: Код' });
    await slot.findByText('Модели по умолчанию для новых проектов');
    slot.getByText(/Версии и расширения/);
    assert.equal(slot.queryByText('Сейчас'), null);
  } finally { slot.lifecycle.unmount(); }
});

test('a message card has no navigation/settings switcher', async () => {
  const s = data();
  const slot = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    await slot.findByText('Сейчас');
    assert.equal(slot.queryByRole('tablist'), null);
    assert.equal(slot.queryByRole('tab'), null);
  } finally { slot.lifecycle.unmount(); }
});

test('«В работе» lists child threads on navigation and hides when there are none', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const child = { id: 'thr_child', title: 'Задача 1', status: 'active', providerId: 'codex', updatedAt: '2026-11-17T00:00:00Z', execution: null, fallback: null, mismatch: null };
  const busy = renderSlot(tab as any, { threadId: 'thr_working', environment: { id: 'env_working' } }, { rpc: { status: () => s, delegation: () => delegView({ children: [child] }) } });
  try {
    await busy.findByText('Задача 1');
    busy.getByText('В работе');
  } finally { busy.lifecycle.unmount(); }
  const idle = renderSlot(tab as any, { threadId: 'thr_idle', environment: { id: 'env_idle' } }, { rpc: { status: () => s, delegation: () => delegView({ children: [] }) } });
  try {
    await idle.findByRole('tab', { name: /Навигация/ });
    await waitFor(() => assert(idle.inspection.rpcCalls.some(c => c.method === 'delegation')));
    assert.equal(idle.queryByText('В работе'), null);
    assert.equal(idle.queryByText('Задача 1'), null);
  } finally { idle.lifecycle.unmount(); }
});

test('defaults block disables apply without defaults and takes roles from this project', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const calls: any[] = [];
  const slot = renderSlot(tab as any, { threadId: 'thr_defaults', environment: { id: 'env_defaults' } }, { rpc: {
    status: () => s, delegation: () => delegView(),
    setDelegationDefaults: (input: any) => { calls.push(input); return delegView(); },
  } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    await slot.findByRole('button', { name: 'Изменить: Код' });
    fireEvent.click(await slot.findByText('Модели по умолчанию для новых проектов'));
    assert.equal((await slot.findByRole('button', { name: 'Применить к этому проекту' }) as HTMLButtonElement).disabled, true);
    fireEvent.click(slot.getByRole('button', { name: 'Взять из этого проекта' }));
    await waitFor(() => assert.deepEqual(calls, [{ threadId: 'thr_defaults', action: 'from-project' }]));
  } finally { slot.lifecycle.unmount(); }
});

test('auto-applied defaults appear as a status callout inside settings', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const applied = 'Применены модели по умолчанию: Код — devin/swe-2-flash';
  const slot = renderSlot(tab as any, { threadId: 'thr_applied', environment: { id: 'env_applied' } }, { rpc: {
    status: () => s, delegation: () => delegView({ appliedDefaults: applied }),
  } });
  try {
    await slot.findByText('Сейчас');
    assert.equal(slot.queryByText(/Применены модели по умолчанию/), null);
    fireEvent.click(slot.getByRole('tab', { name: /Настройки/ }));
    const found = await slot.findAllByText(applied);
    assert(found.some(el => el.closest('[role="status"]')));
  } finally { slot.lifecycle.unmount(); }
});

function scoringView(patch: Record<string, unknown> = {}) {
  return { enabled: false, source: 'catalog', catalogName: null, catalogAvailable: true,
    catalogNames: ['GEMINI_API_KEY_AISTUDIO'], manualKeySet: false, lastError: null, lastScoredAt: null, ...patch };
}

test('readiness rows show «Пропустить» and «Запустить» as buttons right in the row', async () => {
  const { readinessSteps } = await import('../readiness.ts');
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data(); s.readiness = readinessSteps({ configured: true, contextSkill: true, files: {}, paths: {} });
  const runs: string[] = []; const skips: unknown[] = [];
  const slot = renderSlot(tab as any, { threadId: 'thr_expand', environment: { id: 'env_expand' } }, { rpc: {
    status: () => s, run: (input: any) => { runs.push(input.actionId); return { sent: true, message: 'Отправлено' }; },
    setReadinessSkip: (input: any) => { skips.push(input); return { ok: true }; },
  } });
  try {
    fireEvent.click(await slot.findByRole('button', { name: 'Подготовить' }));
    await slot.findByText('Подготовка проекта', { selector: 'h3' });
    const skip = await slot.findByRole('button', { name: 'Пропустить: Настроить CI' });
    assert.equal(skip.textContent, 'Пропустить');
    assert.equal(slot.queryByRole('button', { name: /^Пропустить: Описать проект/ }), null, 'core steps cannot be skipped');
    fireEvent.click(skip);
    await waitFor(() => assert.deepEqual(skips, [{ threadId: 'thr_expand', stepId: 'ci', skipped: true }]));
    assert.equal(runs.length, 0);
    const run = slot.getByRole('button', { name: 'Запустить: Настроить CI' });
    assert.equal(run.textContent, 'Запустить');
    fireEvent.click(run);
    await waitFor(() => assert.deepEqual(runs, ['ci-setup']));
  } finally { slot.lifecycle.unmount(); }
});

test('an executor row is a single button that toggles aria-expanded and reveals the model picker', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const view = { ...delegView(), choice: { mode: 'bb' as const, providerId: 'codex', model: 'gpt-6.2-sol', reasoning: 'high' } };
  const slot = renderSlot(tab as any, { threadId: 'thr_roles', environment: { id: 'env_roles' } }, { rpc: { status: () => s, delegation: () => view } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    const row = await slot.findByRole('button', { name: 'Изменить: Код' });
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    assert.match(row.parentElement!.textContent!, /Код/);
    assert.match(row.parentElement!.textContent!, /Codex · gpt-6\.2-sol · high/);
    fireEvent.click(row);
    assert.equal(row.getAttribute('aria-expanded'), 'true');
    await slot.findByRole('radiogroup', { name: 'Кто пишет код' });
    await slot.findByTestId('bb-provider-model-picker');
    fireEvent.click(row);
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    await waitFor(() => assert.equal(slot.queryByRole('radiogroup'), null));
  } finally { slot.lifecycle.unmount(); }
});

test('scored chips sort by probability with percent badges; the top chip is highlighted and unscored ones have no badge', async () => {
  const items = [
    { id: 'aif-commit', command: '/aif-commit', available: true, reason: 'Ответ', probability: null },
    { id: 'aif-plan', command: '/aif-plan full #1', available: true, reason: 'Ответ', probability: 0.03 },
    { id: 'aif-verify', command: '/aif-verify @plan.md', available: true, reason: 'Ответ', probability: 0.96 },
    { id: 'aif-fix', command: '/aif-fix refresh x so y', available: true, reason: 'Ответ', probability: 0.004 },
  ];
  const slot = renderSlot(banner, {}, { composer: { scope: { kind: 'thread', threadId: 'thr_test' } }, rpc: { suggestions: () => ({ ...suggestedData(), items }) } });
  try {
    await slot.findByRole('button', { name: '96% /aif-verify @plan.md' });
    const chips = [...slot.container.querySelectorAll('.aif-suggestion')];
    assert.equal(chips.length, 4);
    assert(chips[0].classList.contains('aif-suggestion-top'));
    assert(!chips[1].classList.contains('aif-suggestion-top'));
    assert(!chips[2].classList.contains('aif-suggestion-top'));
    assert(!chips[3].classList.contains('aif-suggestion-top'));
    assert.deepEqual([...slot.container.querySelectorAll('.aif-suggestion-score')].map(el => el.textContent), ['96%', '3%', '<1%']);
    assert.match(chips[0].textContent!, /\/aif-verify/);
    assert.match(chips[1].textContent!, /\/aif-plan/);
    assert.match(chips[2].textContent!, /\/aif-fix/);
    assert.match(chips[3].textContent!, /\/aif-commit/);
    assert.equal(chips[3].querySelector('.aif-suggestion-score'), null);
    assert.ok(slot.getByRole('button', { name: '/aif-commit' }));
  } finally { slot.lifecycle.unmount(); }
});

test('«Оценка кнопок» toggles scoring, hides the catalog without env-catalog and clears the manual key input', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const saved: any[] = [];
  let view = scoringView({ catalogAvailable: false, source: 'manual', catalogNames: [] });
  const slot = renderSlot(tab as any, { threadId: 'thr_score1', environment: { id: 'env_score1' } }, { rpc: {
    status: () => s, delegation: () => delegView(),
    chipScoring: () => view,
    setChipScoring: (input: any) => {
      saved.push(input);
      view = { ...view, ...input,
        manualKeySet: input.manualKey === null ? false : input.manualKey ? true : view.manualKeySet,
        lastError: input.manualKey ? 'Gemini ответил HTTP 403' : view.lastError };
      return view;
    },
  } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    await slot.findByRole('heading', { name: 'Оценка кнопок' });
    fireEvent.click(await slot.findByRole('button', { name: 'Выкл' }));
    await waitFor(() => assert.deepEqual(saved, [{ enabled: true }]));
    const toggle = await slot.findByRole('button', { name: 'Вкл' });
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    await slot.findByLabelText('Ключ Gemini API');
    assert.equal(slot.queryByRole('radiogroup', { name: 'Источник ключа' }), null);
    fireEvent.change(slot.getByLabelText('Ключ Gemini API'), { target: { value: 'decisions-test-key' } });
    fireEvent.click(slot.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => assert.deepEqual(saved[1], { manualKey: 'decisions-test-key' }));
    await waitFor(() => assert.equal((slot.getByLabelText('Ключ Gemini API') as HTMLInputElement).value, ''));
    await slot.findByText('Ключ задан');
    await slot.findByText('Gemini ответил HTTP 403');
    fireEvent.click(slot.getByRole('button', { name: 'Удалить ключ' }));
    await waitFor(() => assert.deepEqual(saved[2], { manualKey: null }));
  } finally { slot.lifecycle.unmount(); }
});

test('«Оценка кнопок» with env-catalog offers the key source radio and the name select', async () => {
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const s = data();
  const saved: any[] = [];
  let view = scoringView({ enabled: true, source: 'catalog', catalogName: 'GEMINI_API_KEY_AISTUDIO', catalogNames: ['GEMINI_API_KEY_AISTUDIO', 'OTHER_KEY'] });
  const slot = renderSlot(tab as any, { threadId: 'thr_score2', environment: { id: 'env_score2' } }, { rpc: {
    status: () => s, delegation: () => delegView(),
    chipScoring: () => view,
    setChipScoring: (input: any) => { saved.push(input); view = { ...view, ...input }; return view; },
  } });
  try {
    fireEvent.click(await slot.findByRole('tab', { name: /Настройки/ }));
    const group = await slot.findByRole('radiogroup', { name: 'Источник ключа' });
    assert.equal(within(group).getByRole('radio', { name: 'Из Env Catalog' }).getAttribute('aria-checked'), 'true');
    assert.equal((slot.getByLabelText('Ключ из Env Catalog') as HTMLSelectElement).value, 'GEMINI_API_KEY_AISTUDIO');
    fireEvent.change(slot.getByLabelText('Ключ из Env Catalog'), { target: { value: 'OTHER_KEY' } });
    await waitFor(() => assert.deepEqual(saved.at(-1), { catalogName: 'OTHER_KEY' }));
    fireEvent.click(within(group).getByRole('radio', { name: 'Ввести вручную' }));
    await waitFor(() => assert.deepEqual(saved.at(-1), { source: 'manual' }));
    await slot.findByLabelText('Ключ Gemini API');
  } finally { slot.lifecycle.unmount(); }
});

test('the message card keeps bordered sections while the panel groups sections without borders', async () => {
  const s = data();
  const card = renderSlot(app.messageDirectives[0], props, { rpc: { status: () => s } });
  try {
    await card.findByText('Сейчас');
    const cardSection = card.container.querySelector('section[aria-label="Текущий этап"]') as HTMLElement;
    assert(cardSection?.classList.contains('border'));
    assert(cardSection.classList.contains('rounded-lg'));
  } finally { card.lifecycle.unmount(); }
  const tab = app.tabs.find(t => t.id === 'workflow')!;
  const panel = renderSlot(tab as any, { threadId: 'thr_surface', environment: { id: 'env_surface' } }, { rpc: { status: () => s, delegation: () => delegView() } });
  try {
    await panel.findByText('Сейчас');
    const panelSection = panel.container.querySelector('section[aria-label="Текущий этап"]') as HTMLElement;
    assert(panelSection && !panelSection.classList.contains('border'));
    const panelBlock = [...panelSection.children].find(el => el.classList.contains('rounded-xl')) as HTMLElement;
    assert(panelBlock?.classList.contains('bg-card'));
    assert(!panelBlock.classList.contains('border'));
  } finally { panel.lifecycle.unmount(); }
});
