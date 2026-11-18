import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot } from './fixtures.ts';
import { basicActions, basicPrompt, usesBasicWorkflow, BASIC_PLAN_ROOT, isBasicPlanPath, nativePlanInput, isCompletedPlan } from '../basic-workflow.ts';
import { workflowActions, actionPrompt } from '../workflow.ts';

const bare = () => snapshot({ configured: false, profile: 'none', skills: [], candidates: [], target: null, phase: 'unknown' });
const plan = () => ({ path: BASIC_PLAN_ROOT + '/demo.md', title: 'Demo', id: 'demo', kind: 'basic' as const,
  tasks: [{ id: '1', title: 'One', done: false }, { id: '2', title: 'Two', done: false }] });

test('completed basic and explicitly closed classic plans are hidden without claiming verification', () => {
  const candidate = { path: '.bb/aif-helper/plans/demo.md', title: 'Demo', kind: 'basic', progress: { completed: 5, total: 5, verified: false } };
  assert(isCompletedPlan(candidate));
  assert(!isCompletedPlan({ ...candidate, progress: { ...candidate.progress, completed: 4 } }));
  assert(!isCompletedPlan({ ...candidate, progress: { completed: 0, total: 0, verified: false } }));
  assert(!isCompletedPlan({ ...candidate, progress: undefined }));
  assert(!isCompletedPlan({ ...candidate, kind: 'openspec' }));
  assert(!isCompletedPlan({ ...candidate, kind: 'full' }));
  assert(!isCompletedPlan({ ...candidate, kind: 'classic' }));
  assert(isCompletedPlan({ ...candidate, kind: 'classic', closed: true, progress: undefined }));
  assert(!isCompletedPlan({ ...candidate, kind: 'classic', closed: false }));
  assert(!isCompletedPlan({ ...candidate, kind: 'openspec', closed: true }));
});

test('basic file plans use .bb with legacy path recognition for setup transitions', () => {
  assert.equal(BASIC_PLAN_ROOT, '.bb/aif-helper/plans');
  assert(isBasicPlanPath(BASIC_PLAN_ROOT + '/demo.md'));
  assert(isBasicPlanPath('.bb-aif-helper/plans/demo.md'));
  assert(!isBasicPlanPath('.bb/aif-helper/plans-other/demo.md'));
  assert(!isBasicPlanPath('.bb-aif-helper/plans-other/demo.md'));
});

test('basic flow works without CLI or skills, and installation stays separate from next steps', () => {
  const s = bare(); s.versions.globalCli = null;
  assert(usesBasicWorkflow(s));
  const actions = workflowActions(s);
  assert.deepEqual(actions.filter(a => a.group === 'next').map(a => a.id), ['basic-explore', 'basic-plan']);
  assert(actions.every(a => a.available));
  assert.equal(actions.find(a => a.id === 'basic-install')?.group, 'maintenance');
  assert(actions.every(a => !/^[/$]aif/.test(a.command)));
  const prompt = actionPrompt(s, actions[0]);
  assert.match(prompt, /Исследуй текущую задачу/); assert.match(prompt, /не меняй код/);
  assert(!prompt.includes('npm install')); assert(!prompt.includes('https://'));
  s.phase = 'explore'; assert.equal(workflowActions(s)[0].id, 'basic-plan');
});

test('basic plans drive implementation, resume, verification and a separate commit without claiming PASS', () => {
  const s = bare(); s.target = plan(); s.candidates = [{ ...s.target }];
  assert.equal(workflowActions(s)[0].id, 'basic-implement');
  s.target.tasks[0].done = true;
  assert.equal(workflowActions(s)[0].label, 'Продолжить выполнение');
  s.target.tasks[1].done = true;
  assert.equal(workflowActions(s)[0].id, 'basic-verify');
  s.worktree.hasUncommitted = true;
  assert.equal(workflowActions(s)[0].id, 'basic-commit');
  assert.match(actionPrompt(s, workflowActions(s)[0]), /сохрани несвязанные изменения/);
  s.phase = 'verify'; assert(workflowActions(s).some(a => a.id === 'basic-fix'));
  assert.equal(s.checks.length, 0);
  for (const action of basicActions(s)) {
    if (action.id !== 'basic-install') assert.match(actionPrompt(s, action), /Не начинай следующий шаг автоматически/);
  }
});

test('a completed basic plan offers a new scoped exploration without treating completion as verification', () => {
  const s = bare(); s.target = plan(); s.worktree.hasUncommitted = true;
  assert(!basicActions(s).some(a => a.id === 'basic-explore'));
  s.target.tasks.forEach(task => { task.done = true; });
  const actions = basicActions(s);
  const explore = actions.find(a => a.id === 'basic-explore')!;
  assert.equal(explore.label, 'Исследовать новую задачу');
  assert(actions.some(a => a.id === 'basic-commit')); assert(actions.some(a => a.id === 'basic-verify'));
  const prompt = basicPrompt(s, explore)!;
  assert(prompt.includes('"target":null')); assert(!prompt.includes(s.target.path));
  assert.match(prompt, /не возобновляй и не изменяй его/); assert.match(prompt, /без target/);
  assert.equal(s.checks.length, 0);
});

test('basic planning uses the native BB Plan command and does not force a workspace Markdown artifact', () => {
  const s = bare();
  const action = basicActions(s).find(a => a.id === 'basic-plan')!;
  const prompt = basicPrompt(s, action)!;
  assert.equal(action.command, '/plan');
  assert.match(prompt, /штатном режиме Plan/); assert(prompt.includes(BASIC_PLAN_ROOT));
  assert.match(prompt, /aif-plan.*четырьмя/); assert.match(prompt, /После завершения генерации плагин сохранит/);
  assert.match(prompt, /без реализации/); assert.match(prompt, /Не создавай отдельный Markdown-план/);
  const native = nativePlanInput(action.label);
  assert.equal(native.text.slice(native.mentions[0].start, native.mentions[0].end), '/plan');
  assert.equal(native.mentions[0].resource.origin, 'builtin'); assert.equal(native.mentions[0].resource.source, 'command');
  s.candidates = [{ path: BASIC_PLAN_ROOT + '/one.md', title: 'one', kind: 'basic' }, { path: BASIC_PLAN_ROOT + '/two.md', title: 'two', kind: 'basic' }];
  assert(!workflowActions(s).some(a => a.id === 'basic-implement'));
  assert(!workflowActions({ ...s, profile: 'invalid' }).some(a => a.id.startsWith('basic-')));
  assert(!workflowActions(snapshot()).some(a => a.id.startsWith('basic-')));
});

test('installation is explicit and binds init to a supported runtime without adding extensions or overriding a linked CLI', () => {
  const s = bare();
  const install = basicActions(s).find(a => a.id === 'basic-install')!;
  const prompt = basicPrompt(s, install)!;
  assert.match(prompt, /npm install -g ai-factory/);
  assert.match(prompt, /ai-factory init --agents codex-app --skills all/);
  assert.match(prompt, /существующий CLI/); assert.match(prompt, /Не заменяй linked/);
  assert.match(prompt, /не добавляй MCP\/расширения/);
  s.runtime = 'unknown-runtime';
  assert(!basicPrompt(s, install)!.includes('init --agents unknown-runtime'));
  assert.match(basicPrompt(s, install)!, /уточни его у пользователя/);
});
