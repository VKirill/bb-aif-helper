import test from 'node:test';
import assert from 'node:assert/strict';
import { readinessSteps, readinessComplete, nextReadinessStep, type ReadinessFacts } from '../readiness.ts';

const facts = (patch: Partial<ReadinessFacts> = {}): ReadinessFacts => ({ configured: true, contextSkill: true, files: {}, paths: {}, ...patch });
const byId = (steps: ReturnType<typeof readinessSteps>) => Object.fromEntries(steps.map(s => [s.id, s]));
const contextFiles = {
  '.ai-factory/DESCRIPTION.md': true, '.ai-factory/config.yaml': true,
  '.ai-factory/rules/base.md': true, 'AGENTS.md': true,
};

test('steps follow the required order and an unconfigured project starts at install', () => {
  const steps = readinessSteps(facts({ configured: false, contextSkill: false }));
  assert.deepEqual(steps.map(s => s.id), ['install', 'context', 'architecture', 'roadmap', 'quality', 'ci', 'rules', 'docs', 'build', 'docker']);
  const s = byId(steps);
  assert.equal(s.install.state, 'todo'); assert.equal(s.install.actionId, 'basic-install');
  assert.deepEqual(s.install.missing, ['.ai-factory.json']);
  for (const id of ['context', 'architecture', 'roadmap', 'quality', 'ci']) assert.equal(s[id].state, 'todo', id);
  assert.equal(nextReadinessStep(steps)?.id, 'install');
  assert.equal(readinessComplete(steps), false);
});

test('configured project without context files marks context todo with every missing path', () => {
  const s = byId(readinessSteps(facts({ files: { '.ai-factory/config.yaml': true } })));
  assert.equal(s.install.state, 'done'); assert.equal(s.install.actionId, 'update-factory');
  assert.equal(s.context.state, 'todo');
  assert.deepEqual(s.context.missing, ['.ai-factory/DESCRIPTION.md', '.ai-factory/rules/base.md', 'AGENTS.md']);
  assert.equal(nextReadinessStep(readinessSteps(facts()))?.id, 'context');
});

test('context state is file-based; a missing context skill only affects action availability', () => {
  const withSkill = readinessSteps(facts({ files: contextFiles }));
  const without = readinessSteps(facts({ files: contextFiles, contextSkill: false }));
  assert.deepEqual(without, withSkill);
  assert.equal(byId(withSkill).context.state, 'done');
});

test('config.yaml paths replace the default artifact locations', () => {
  const paths = { description: 'docs/about.md', architecture: 'ARCHITECTURE.md', roadmap: 'ROADMAP.md', rulesBase: 'rules/base.md' };
  const files = { 'docs/about.md': true, 'ARCHITECTURE.md': true, 'ROADMAP.md': true, 'rules/base.md': true, '.ai-factory/config.yaml': true, 'AGENTS.md': true };
  const s = byId(readinessSteps(facts({ files, paths })));
  assert.equal(s.context.state, 'done'); assert.equal(s.architecture.state, 'done'); assert.equal(s.roadmap.state, 'done');
  const missing = byId(readinessSteps(facts({ paths: { description: 'docs/about.md' } })));
  assert(missing.context.missing.includes('docs/about.md'));
  assert(!missing.context.missing.includes('.ai-factory/DESCRIPTION.md'));
});

test('skipped applies only to skippable todo steps and never overrides done', () => {
  const s = byId(readinessSteps(facts({ files: {} }), ['install', 'context', 'architecture', 'roadmap', 'quality', 'ci']));
  assert.equal(s.install.state, 'done');
  assert.equal(s.context.state, 'todo');
  assert.equal(s.architecture.state, 'todo');
  assert.equal(s.roadmap.state, 'skipped');
  assert.equal(s.quality.state, 'skipped');
  assert.equal(s.ci.state, 'skipped');
  const done = byId(readinessSteps(facts({ files: { '.ai-factory/ROADMAP.md': true, 'lefthook.yml': true, '.github/workflows/ci.yml': true } }), ['roadmap', 'quality', 'ci']));
  assert.equal(done.roadmap.state, 'done'); assert.equal(done.quality.state, 'done'); assert.equal(done.ci.state, 'done');
});

test('optional steps never block completion or take the run slot', () => {
  const files = { ...contextFiles, '.ai-factory/ARCHITECTURE.md': true };
  const steps = readinessSteps(facts({ files }), ['roadmap', 'quality', 'ci']);
  const s = byId(steps);
  assert.equal(s.rules.state, 'todo'); assert.equal(s.rules.optional, true);
  assert.equal(s.docs.state, 'todo'); assert.equal(s.docs.optional, true);
  assert.equal(readinessComplete(steps), true);
  assert.equal(nextReadinessStep(steps), undefined);
  const mixed = readinessSteps(facts({ files: {} }));
  assert.equal(nextReadinessStep(mixed)?.id, 'context');
  assert(mixed.filter(x => x.optional).every(x => x.state === 'todo'));
});

test('detected artifacts complete their steps', () => {
  const files = {
    ...contextFiles, '.ai-factory/ARCHITECTURE.md': true, '.ai-factory/ROADMAP.md': true,
    'lefthook.yml': true, '.github/workflows/ci.yml': true, 'docs/index.md': true,
    'Makefile': true, 'Dockerfile': true,
  };
  const s = byId(readinessSteps(facts({ files, ruleAreas: ['testing'] })));
  assert(Object.values(s).every(v => v.state === 'done'));
  assert.equal(readinessComplete(Object.values(s)), true);
});
