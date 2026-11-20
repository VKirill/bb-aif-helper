import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { filesOverlap, parallelGroups, parsePlanTasks } from '../parallel-plan.ts';

const plan = (lines: string[]) => ['# Plan', '## Tasks', ...lines].join('\n');

test('parsePlanTasks reads ids, done flags, files, dependencies, phases and kinds', () => {
  const text = plan([
    '### Фаза 1',
    '- [x] Task 1: Готовая. Files: `a.ts`. Depends on —',
    '- [ ] Task 2: Вторая. Files: `b.ts`, `dir/`. Depends on 1-2',
    '<!-- aif:task-kind:commit -->',
    '- [ ] Task 3: Коммит. Depends on none',
    '### Фаза 2',
    '- [ ] Task 4: Выкатка на прод.',
    '- [ ] Task 5: Пятая. Files: `src/*`.',
  ]);
  const parsed = parsePlanTasks(text);
  assert.equal(parsed.length, 5);
  assert.deepEqual(parsed[0], { id: 1, done: true, title: 'Готовая. Files: `a.ts`. Depends on —', files: ['a.ts'], dependsOn: 'none', phase: 1, order: 0, kind: 'code' });
  assert.equal(parsed[1].dependsOn && JSON.stringify(parsed[1].dependsOn), JSON.stringify([1, 2]));
  assert.deepEqual(parsed[1].files, ['b.ts', 'dir']);
  assert.equal(parsed[2].kind, 'commit');
  assert.equal(parsed[2].dependsOn, 'none');
  assert.equal(parsed[3].kind, 'deploy');
  assert.equal(parsed[3].phase, 2);
  assert.equal(parsed[3].dependsOn, null, 'no Depends on hint stays null for phase-implied deps');
  assert.equal(parsed[4].files, null, 'a glob file set is unclear and becomes null');
});

test('filesOverlap matches identical paths and directory prefixes only', () => {
  assert.equal(filesOverlap(['app.tsx'], ['app.tsx']), true);
  assert.equal(filesOverlap(['src'], ['src/a.ts']), true);
  assert.equal(filesOverlap(['src/a.ts'], ['src']), true);
  assert.equal(filesOverlap(['a.ts'], ['b.ts']), false);
  assert.equal(filesOverlap(['src/a.ts'], ['src/b.ts']), false);
  assert.equal(filesOverlap([], ['a.ts']), false);
});

test('two independent tasks with different files share one group', () => {
  const result = parallelGroups(plan([
    '- [ ] Task 1: Alpha. Files: `a.ts`. Depends on —',
    '- [ ] Task 2: Beta. Files: `b.ts`. Depends on —',
  ]), 3);
  assert.deepEqual(result, { groups: [[1, 2]], coordinatorOnly: [] });
});

test('tasks editing the same file land in separate groups', () => {
  const result = parallelGroups(plan([
    '- [ ] Task 1: Alpha. Files: `app.tsx`. Depends on —',
    '- [ ] Task 2: Beta. Files: `app.tsx`. Depends on —',
    '- [ ] Task 3: Gamma. Files: `app.tsx`. Depends on —',
  ]), 3);
  assert.deepEqual(result, { groups: [[1], [2], [3]], coordinatorOnly: [] });
});

test('a task without a concrete Files set runs alone but does not block others', () => {
  const result = parallelGroups(plan([
    '- [ ] Task 1: Alpha. Files: `a.ts`. Depends on —',
    '- [ ] Task 2: Beta. Depends on —',
    '- [ ] Task 3: Gamma. Files: `b.ts`. Depends on —',
  ]), 3);
  assert.deepEqual(result, { groups: [[1, 3], [2]], coordinatorOnly: [] });
});

test('a task in a later phase without explicit Depends on waits for the whole previous phase', () => {
  const result = parallelGroups(plan([
    '### Фаза 1',
    '- [ ] Task 1: Alpha. Files: `a.ts`.',
    '### Фаза 2',
    '- [ ] Task 2: Beta. Files: `b.ts`.',
  ]), 3);
  assert.deepEqual(result, { groups: [[1], [2]], coordinatorOnly: [] });
});

test('done tasks satisfy dependencies and are not scheduled again', () => {
  const result = parallelGroups(plan([
    '- [x] Task 1: Done. Files: `a.ts`.',
    '- [ ] Task 2: Next. Files: `b.ts`. Depends on 1',
  ]), 3);
  assert.deepEqual(result, { groups: [[2]], coordinatorOnly: [] });
});

test('commit and deploy tasks run alone and are reported as coordinator-only', () => {
  const result = parallelGroups(plan([
    '- [ ] Task 1: Code. Files: `a.ts`. Depends on —',
    '<!-- aif:task-kind:commit -->',
    '- [ ] Task 2: Commit the work.',
    '- [ ] Task 3: Выкатка на прод. Files: `deploy.sh`. Depends on —',
  ]), 3);
  assert.deepEqual(result, { groups: [[1], [2], [3]], coordinatorOnly: [2, 3] });
});

test('a dependency cycle and a broken reference both return an error', () => {
  const cycle = parallelGroups(plan([
    '- [ ] Task 1: Alpha. Files: `a.ts`. Depends on 2',
    '- [ ] Task 2: Beta. Files: `b.ts`. Depends on 1',
  ]), 3);
  assert.ok('error' in cycle && /Цикл/.test(cycle.error), JSON.stringify(cycle));
  const broken = parallelGroups(plan([
    '- [ ] Task 1: Alpha. Files: `a.ts`. Depends on 99',
  ]), 3);
  assert.ok('error' in broken && /несуществующей задачи 99/.test(broken.error), JSON.stringify(broken));
});

test('ultra plans and plans without tasks are unsupported', () => {
  const ultra = parallelGroups(plan(['- [ ] Task 1: A.']) + '\n<!-- aif:plan-mode:ultra -->', 3);
  assert.ok('error' in ultra && /Ultra/.test(ultra.error));
  const empty = parallelGroups('# Plan\n## Tasks\n\nno tasks here\n', 3);
  assert.ok('error' in empty);
});

test('max caps the group size and clamps to 1-4', () => {
  const four = [
    '- [ ] Task 1: A. Files: `a.ts`. Depends on —',
    '- [ ] Task 2: B. Files: `b.ts`. Depends on —',
    '- [ ] Task 3: C. Files: `c.ts`. Depends on —',
    '- [ ] Task 4: D. Files: `d.ts`. Depends on —',
  ];
  assert.deepEqual(parallelGroups(plan(four), 2), { groups: [[1, 2], [3, 4]], coordinatorOnly: [] });
  assert.deepEqual(parallelGroups(plan(four), 1), { groups: [[1], [2], [3], [4]], coordinatorOnly: [] });
  assert.deepEqual(parallelGroups(plan(four), 9), { groups: [[1, 2, 3, 4]], coordinatorOnly: [] });
});

test('the real mobile-panel-smart-chips plan groups as the manual layout did', () => {
  const text = readFileSync(fileURLToPath(new URL('./fixtures/mobile-panel-smart-chips.md', import.meta.url)), 'utf8');
  const result = parallelGroups(text, 3);
  assert.ok('groups' in result, JSON.stringify(result));
  assert.deepEqual(result.groups.slice(0, 4), [[1, 5, 7], [2, 6], [3, 8], [4, 9]]);
  assert.deepEqual(result.groups, [[1, 5, 7], [2, 6], [3, 8], [4, 9], [14], [10], [11], [12], [13]]);
  assert.deepEqual(result.coordinatorOnly, [13]);
});

test('Depends on ranges expand over the plan tasks only, so a huge range is cheap and still checked', () => {
  const plan = (deps: string) => ['## Tasks', '- [ ] Task 1: A. Files: `a.ts`. Depends on —', '- [ ] Task 2: B. Files: `b.ts`. Depends on —',
    '- [ ] Task 5: C. Files: `c.ts`. Depends on —', `- [ ] Task 7: D. Files: \`d.ts\`. Depends on ${deps}`].join('\n');
  assert.deepEqual(parsePlanTasks(plan('1-2'))[3].dependsOn, [1, 2]);
  assert.deepEqual(parsePlanTasks(plan('2-1'))[3].dependsOn, [1, 2]);
  assert.deepEqual(parallelGroups(plan('1-2'), 4), { groups: [[1, 2, 5], [7]], coordinatorOnly: [] });
  // A gap inside a range is a missing task, as before ranges were bounded.
  assert.deepEqual(parallelGroups(plan('1-5'), 4), { error: 'Задача 7 зависит от несуществующей задачи 3.' });
  const started = Date.now();
  assert.deepEqual(parsePlanTasks(plan('1-999999999999'))[3].dependsOn, [1, 2, 3, 999999999999]);
  assert.deepEqual(parallelGroups(plan('1-999999999999'), 4), { error: 'Задача 7 зависит от несуществующей задачи 3.' });
  assert.ok(Date.now() - started < 1000, 'ranges stop at the first gap instead of counting to the end');
  assert.deepEqual(parallelGroups(plan('9007199254740993-9007199254740993'), 4), { error: 'Слишком большой номер задачи: 9007199254740992.' });
  // A task id above 2^53 inside a range used to spin forever: `id++` no longer changes such a number.
  const unsafe = ['## Tasks', '- [ ] Task 9007199254740992: A. Files: `a.ts`. Depends on 9007199254740992-9007199254740992'].join('\n');
  assert.deepEqual(parallelGroups(unsafe, 4), { error: 'Слишком большой номер задачи: 9007199254740992.' });
});

test('files that differ only in case or slash direction are one file', () => {
  assert.equal(filesOverlap(['src/Foo.ts'], ['SRC/foo.ts']), true);
  assert.deepEqual(parsePlanTasks('- [ ] Task 1: A. Files: `src//a.ts`, `src/x/../b.ts`, `./c.ts`.')[0].files, ['src/a.ts', 'src/b.ts', 'c.ts']);
  assert.equal(parsePlanTasks('- [ ] Task 1: A. Files: `../outside.ts`.')[0].files, null, 'a file outside the project is unclear');
  const dup = ['## Tasks', '- [ ] Task 1: A. Files: `a.ts`. Depends on —', '- [ ] Task 01: B. Files: `b.ts`. Depends on —'].join('\n');
  assert.deepEqual(parallelGroups(dup, 4), { error: 'Номер задачи 1 встречается дважды (например, Task 1 и Task 01).' });
  const many = ['## Tasks', ...Array.from({ length: 16000 }, (_, i) => `- [ ] Task ${i + 1}: T. Files: \`f${i}.ts\`. Depends on ${i === 5 ? '1-999999999' : i < 3 ? '—' : `${i - 2}-${i}`}`)].join('\n');
  const started = Date.now();
  const parsed = parsePlanTasks(many);
  assert.deepEqual(parsed[9].dependsOn, [7, 8, 9], 'a range in every line is resolved');
  assert.ok((parsed[5].dependsOn as number[]).length <= 16002, 'a huge range stops at the first missing id');
  assert.ok(Date.now() - started < 2000, 'parsing stays linear in the number of tasks');
  const text = ['## Tasks', '- [ ] Task 1: A. Files: `src/Foo.ts`. Depends on —', '- [ ] Task 2: B. Files: `SRC\\foo.ts`. Depends on —'].join('\n');
  assert.deepEqual(parsePlanTasks(text)[1].files, ['SRC/foo.ts']);
  assert.deepEqual(parallelGroups(text, 4), { groups: [[1], [2]], coordinatorOnly: [] });
});

test('the AI Factory plan format: (depends on …) in the task line, Files: on an indented line below, plain or quoted', () => {
  const plan = [
    '## Tasks',
    '### Phase 1',
    '- [ ] Task 1: Storage',
    '  - Change the store.',
    '  - Files: src/store.ts, src/index.ts',
    '- [ ] Task 2: Pipeline',
    '    Files: `src/pipeline.ts` (new)',
    '- [ ] Task 3: Wire it (depends on 1, 2)',
    '  - Files: `src/server.ts`, `workflows/x.json` (delete)',
    '- [ ] Task 4: Notes',
    '  - Files: перечисленные',
    '- [ ] Task 5: Outside the project',
    '  - Files: `/home/me/other/file.ts`',
    '- [ ] Task 6: Hand-written',
    '  - Files: `src/six.ts`',
    '  - Depends on: Task 3',
    '- [ ] Task 7: Выкатить релиз в origin (depends on 6)',
    'Not indented: closes the task. Files: `src/not-a-task-file.ts`',
  ].join('\n');
  const t = parsePlanTasks(plan);
  assert.deepEqual(t.map(x => x.files), [
    ['src/store.ts', 'src/index.ts'], ['src/pipeline.ts'], ['src/server.ts', 'workflows/x.json'], null, null, ['src/six.ts'], null,
  ]);
  assert.deepEqual(t.map(x => x.dependsOn), [null, null, [1, 2], null, null, [3], [6]]);
  assert.equal(t[6].kind, 'deploy');
  const groups = parallelGroups(plan, 4);
  assert.ok(!('error' in groups));
  assert.deepEqual(groups.groups[0], [1, 2], 'tasks 1 and 2 run together');
});

test('prose under a task never changes its files or dependencies; headings and mixed lists are safe', () => {
  const groups = (plan: string) => { const g = parallelGroups(plan, 4); assert.ok(!('error' in g), JSON.stringify(g)); return g.groups; };
  // "depends on" in a verification sentence does not erase the declared dependency.
  assert.deepEqual(groups(['## Tasks', '- [ ] Task 1: Model. Files: `a.ts`.', '- [ ] Task 2: Service. Files: `b.ts`. Depends on 1.',
    '  - Verify that the service depends on the new model.'].join('\n')), [[1], [2]]);
  // `Files:` inside a sentence is not the list: both tasks still share src/list.ts.
  assert.deepEqual(groups(['## Tasks', '- [ ] Task 1: List', '  - Files: `src/list.ts`',
    '  - Verify the output starts with "Files:" in `tests/list.test.ts`', '- [ ] Task 2: Other', '  - Files: `src/list.ts`'].join('\n')), [[1], [2]]);
  // Words after the dependency are not task ids.
  assert.deepEqual(groups(['## Tasks', '- [ ] Task 1: Base. Files: `a.ts`.', '- [ ] Task 2: Add the adapter (depends on 1) for Node 22. Files: `b.ts`.'].join('\n')), [[1], [2]]);
  // An ordinary task that sends an e-mail is code, not a deployment.
  const mail = parallelGroups(['## Tasks', '- [ ] Task 1: Отправить письмо после регистрации. Files: `mail.ts`.', '- [ ] Task 2: Форма. Files: `form.ts`.'].join('\n'), 4);
  assert.ok(!('error' in mail)); assert.deepEqual(mail.coordinatorOnly, []); assert.deepEqual(mail.groups, [[1, 2]]);
  // A rollout named later in the title is still the coordinator's.
  assert.equal(parsePlanTasks('## Tasks\n- [ ] Task 1: Отправить ветку в `origin` и безопасно выкатить')[0].kind, 'deploy');
  // Plain paths next to backticked ones: the list is unknown, so the task runs alone.
  assert.deepEqual(groups(['## Tasks', '- [ ] Task 1: Mixed', '  - Files: src/shared.ts, `src/backend.ts`', '- [ ] Task 2: Shared', '  - Files: `src/shared.ts`'].join('\n')), [[1], [2]]);
  // An indented phase heading still starts a phase: Task 2 waits for Task 1.
  assert.deepEqual(groups(['## Tasks', '### Phase 1', '- [ ] Task 1: One', '  - Files: `a.ts`', ' ### Phase 2', '- [ ] Task 2: Two', '  - Files: `b.ts`'].join('\n')), [[1], [2]]);
  // Parentheses inside a backticked path are part of the path.
  assert.deepEqual(parsePlanTasks(['## Tasks', '- [ ] Task 1: Page', '  - Files: `app/(account)/settings/page.tsx`'].join('\n'))[0].files, ['app/(account)/settings/page.tsx']);
  // A lowercase "depends on: —" after a plain list ends the list.
  assert.deepEqual(groups(['## Tasks', '- [ ] Task 1: A. Files: src/a.ts. depends on: —', '- [ ] Task 2: B. Files: src/b.ts. depends on: —'].join('\n')), [[1, 2]]);
});
