import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { supportsAif222, planSettings } from '../aif222.ts';
import { collectSnapshot, taskList } from '../reader.ts';
import { workflowActions, actionPrompt } from '../workflow.ts';
import { fixture, snapshot } from './fixtures.ts';
import { extractAifInvocations } from '../suggestions.ts';
import { lockUnchangedChecks } from '../check-actions.ts';

test('2.22 capabilities require a known compatible stable CLI, not an assumed project version', () => {
  for (const version of [null, '', '2.21.0', '2.22.0-rc.1', '3.0.0']) assert.equal(supportsAif222(version), false);
  for (const version of ['2.22.0', '2.22.1', '2.23.0']) assert.equal(supportsAif222(version), true);
});

test('explicit coupling suggestions retain the modifier and the other discovered arguments', () => {
  assert.deepEqual(extractAifInvocations('$aif-review +coupling --unsafe; /aif-plan full +coupling #211'), [
    { id: 'aif-review', command: 'aif-review +coupling --unsafe' }, { id: 'aif-plan', command: 'aif-plan full +coupling #211' },
  ]);
  assert.equal(extractAifInvocations('$aif-verify +coupling')[0].command, 'aif-verify +coupling');
  assert.equal(extractAifInvocations('$aif-review +coupling-bad')[0].command, 'aif-review +coupling-bad');
});

test('canonical plan controls are read only from Settings, with ambiguous and example values left unknown', () => {
  const s = planSettings('# Plan\n```md\n## Settings\n- Commit strategy: single-commit\n```\n## Settings\n- Commit strategy: incremental-at-end\n- Development methodology: tdd\n- TDD granularity: feature-based\n## Tasks\n- Commit strategy: single-commit');
  assert.deepEqual(s, { commitStrategy: 'incremental-at-end', methodology: 'tdd', tddGranularity: 'feature-based' });
  assert.equal(planSettings('## Settings\n- Commit strategy: incremental\n- Commit strategy: single-commit').commitStrategy, null);
  assert.equal(planSettings('## Settings\n- Development methodology: implementation-first\n- TDD granularity: task-based').tddGranularity, null);
  assert.equal(planSettings('## Настройки\n- Commit strategy: single-commit').commitStrategy, null);
});

test('2.22 commit and skipped-outcome markers preserve actual checkbox progress and do not count receipts/examples', () => {
  const tasks = taskList('# Plan\n## Tasks\n- [x] Task 1: Work\n- [x] Task 2: Docs <!-- aif:task-outcome:skipped reason="documentation-unchanged" -->\n<!-- aif:task-kind:commit -->\n- [x] Task 3: Docs commit <!-- aif:commit-outcome:skipped-no-op reason="documentation-unchanged" -->\n<!-- aif:task-kind:commit -->\n- [ ] Task 4: Implementation commit\n````md\n```\n- [x] Fake\n```\n````\n<!-- aif:commit-receipt:start -->\n{"state":"verified"}\n<!-- aif:commit-receipt:end -->');
  assert.equal(tasks.length, 4); assert.equal(tasks[1].outcome, 'skipped'); assert.equal(tasks[2].kind, 'commit');
  assert.equal(tasks[2].outcome, 'skipped'); assert.equal(tasks[3].done, false); assert(!tasks[1].title.includes('<!--'));
  assert.equal(taskList('## Tasks\n- [ ] Task 1: Pending <!-- aif:task-outcome:skipped -->')[0].outcome, undefined);
});

test('marked commit boundaries and deferred strategies do not offer a premature generic commit', () => {
  const s = snapshot({ worktree: { hasUncommitted: true }, phase: 'implement' });
  s.target!.settings = { commitStrategy: 'single-commit', methodology: 'tdd', tddGranularity: 'task-based' };
  assert(!workflowActions(s).some(a => a.id === 'commit'));
  s.target!.tasks = [{ id: '1', title: 'Work', done: true }, { id: '2', title: 'Commit', done: false, kind: 'commit' }];
  assert(!workflowActions(s).some(a => a.id === 'commit')); assert(workflowActions(s).some(a => a.id === 'implement'));
  s.target!.tasks[1].done = true;
  assert(workflowActions(s).some(a => a.id === 'commit'));
});

test('worktree diagnostics are click-only optional actions gated by the actual CLI and fix respects project defaults', () => {
  const s = snapshot({ target: null, candidates: [] }); s.versions.installed = '2.22.0'; s.versions.globalCli = '2.21.0';
  const unavailable = workflowActions(s).find(a => a.id === 'check-worktree')!;
  assert.equal(unavailable.available, false); assert.equal(unavailable.disabledReason, 'requires-cli222');
  s.versions.globalCli = '2.22.0';
  const available = workflowActions(s).find(a => a.id === 'check-worktree')!;
  assert.equal(available.command, 'ai-factory worktree-check --json'); assert.equal(available.available, true);
  assert.match(actionPrompt(s, available), /не доказывает|не подтверждает/);
  s.phase = 'explore'; const fix = workflowActions(s).find(a => a.id === 'fix-new')!;
  assert.match(actionPrompt(s, fix), /workflow.fix_mode/); assert.equal(fix.command, '$aif-fix');
});

test('an unchanged plain review cannot disable a coupling analysis that has no matching evidence', () => {
  const s = snapshot(); s.versions.installed = '2.22.0';
  s.checks = [{ id: 'review', label: 'Review', state: 'unknown', path: null, detail: '', required: false,
    chat: { seq: 1, at: s.collectedAt, target: s.target!.path, freshness: 'unchanged', result: {
      schema_version: 1, gate: 'review', status: 'pass', blocking: false, blockers: [], affected_files: [], suggested_next: null,
    } } }];
  s.actions = workflowActions(s); lockUnchangedChecks(s);
  assert.equal(s.actions.find(a => a.id === 'check-review')?.available, false);
  assert.equal(s.actions.find(a => a.id === 'check-coupling')?.available, true);
});

test('registered 2.22 shared skill links work while escaping and retargeted links stay rejected', async () => {
  const f = await fixture(); const other = await fixture();
  try {
    await fs.mkdir(path.join(f.root, '.claude/skills'), { recursive: true });
    const link = path.join(f.root, '.claude/skills/aif-plan');
    const metadata = { version: '2.22.0', agents: [{ id: 'claude', skillsDir: '.claude/skills', installedSkills: ['aif-plan'] }],
      useSymlinks: true, skillSymlinks: { links: { '.claude/skills/aif-plan': '.agents/skills/aif-plan' }, shared: { '.agents/skills/aif-plan': 'a'.repeat(64) } } };
    await f.write('.ai-factory.json', metadata);
    await fs.symlink(path.join(f.root, '.agents/skills/aif-plan'), link, process.platform === 'win32' ? 'junction' : 'dir');
    const input = { root: f.root, runtime: 'claude', target: '', phase: 'unknown' as const, sourceRepo: '', checkUpdates: false, upstreamRepo: 'lee-to/ai-factory', upstreamRef: '' };
    const good = await collectSnapshot(input); assert(good.skills.includes('aif-plan'));
    await fs.unlink(link);
    await fs.symlink(path.join(other.root, '.agents/skills/aif-plan'), link, process.platform === 'win32' ? 'junction' : 'dir');
    assert(!(await collectSnapshot(input)).skills.includes('aif-plan'));
    await fs.unlink(link);
    await fs.symlink(path.join(f.root, '.agents/skills/aif-plan'), link, process.platform === 'win32' ? 'junction' : 'dir');
    await f.write('.ai-factory.json', { ...metadata, useSymlinks: false });
    assert(!(await collectSnapshot(input)).skills.includes('aif-plan'));
  } finally { await f.cleanup(); await other.cleanup(); }
});

test('2.22 metadata records fix defaults, plan controls and hook declarations without manufacturing execution evidence', async () => {
  const f = await fixture(); try {
    const meta = JSON.parse(await fs.readFile(path.join(f.root, '.ai-factory.json'), 'utf8')); meta.version = '2.22.0';
    await f.write('.ai-factory.json', meta);
    await f.write('.ai-factory/config.yaml', 'workflow:\n  fix_mode: plan\n  fix_patch: false\n');
    await f.write('.ai-factory/plans/0001_demo.md', '# Demo\n## Settings\n- Commit strategy: single-commit\n- Development methodology: tdd\n- TDD granularity: task-based\n## Tasks\n- [ ] Task 1: Work');
    const input = { root: f.root, runtime: 'codex-app', target: '', phase: 'unknown' as const, sourceRepo: '', checkUpdates: false, upstreamRepo: 'lee-to/ai-factory', upstreamRef: '' };
    const s = await collectSnapshot(input);
    assert.deepEqual(s.fixDefaults, { mode: 'plan', patch: false }); assert.equal(s.target!.settings?.commitStrategy, 'single-commit');
    assert.equal(s.checks.find(c => c.id === 'worktree')?.state, 'unknown');
    assert.equal(s.checks.find(c => c.id === 'completion-hook')?.state, 'notrun');
    await f.write('.ai-factory/completion-hook/approval.json', { id: 'declared', spec: { role: 'required' } });
    const declared = await collectSnapshot(input);
    assert.equal(declared.checks.find(c => c.id === 'completion-hook')?.state, 'unknown');
    assert(!declared.actions.some(a => /completion-hook (enable|run|status)/.test(a.command)));
    await f.write('.ai-factory/config.yaml', 'workflow:\n  fix_mode: invalid\n  fix_patch: "false"\n');
    assert.deepEqual((await collectSnapshot(input)).fixDefaults, { mode: 'ask', patch: true });
  } finally { await f.cleanup(); }
});

test('upstream directory defaults with trailing slashes remain valid and still reject traversal', async () => {
  const f = await fixture(); try {
    await f.write('.ai-factory/config.yaml', 'paths:\n  plans: .ai-factory/plans/\n  qa: .ai-factory/qa/\n');
    await f.write('.ai-factory/plans/demo.md', '# Demo\n## Tasks\n- [ ] Task 1: Work');
    const input = { root: f.root, runtime: 'codex-app', target: '', phase: 'unknown' as const, sourceRepo: '', checkUpdates: false, upstreamRepo: 'lee-to/ai-factory', upstreamRef: '' };
    const s = await collectSnapshot(input);
    assert.equal(s.profile, 'upstream'); assert.equal(s.target?.path, '.ai-factory/plans/demo.md');
    await f.write('.ai-factory/config.yaml', 'paths:\n  plans: ../outside/\n');
    assert.equal((await collectSnapshot(input)).profile, 'invalid');
  } finally { await f.cleanup(); }
});
