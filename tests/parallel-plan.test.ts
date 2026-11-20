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
});

test('files that differ only in case or slash direction are one file', () => {
  assert.equal(filesOverlap(['src/Foo.ts'], ['SRC/foo.ts']), true);
  const text = ['## Tasks', '- [ ] Task 1: A. Files: `src/Foo.ts`. Depends on —', '- [ ] Task 2: B. Files: `SRC\\foo.ts`. Depends on —'].join('\n');
  assert.deepEqual(parsePlanTasks(text)[1].files, ['SRC/foo.ts']);
  assert.deepEqual(parallelGroups(text, 4), { groups: [[1], [2]], coordinatorOnly: [] });
});
