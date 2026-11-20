import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRan, readinessSteps, readinessComplete, readinessCoreComplete, nextReadinessStep, type ReadinessFacts } from '../readiness.ts';

const facts = (patch: Partial<ReadinessFacts> = {}): ReadinessFacts => ({ configured: true, contextSkill: true, files: {}, paths: {}, ...patch });
const byId = (steps: ReturnType<typeof readinessSteps>) => Object.fromEntries(steps.map(s => [s.id, s]));
const contextFiles = {
  '.ai-factory/DESCRIPTION.md': true, '.ai-factory/config.yaml': true,
  '.ai-factory/rules/base.md': true, 'AGENTS.md': true,
};

test('steps follow the required order and an unconfigured project starts at install', () => {
  const steps = readinessSteps(facts({ configured: false, contextSkill: false }));
  assert.deepEqual(steps.map(s => s.id), ['install', 'context', 'architecture', 'quality', 'ci', 'docs', 'rules', 'build', 'docker']);
  const s = byId(steps);
  assert.equal(s.install.state, 'todo'); assert.equal(s.install.actionId, 'basic-install');
  assert.deepEqual(s.install.missing, ['.ai-factory.json']);
  for (const id of ['context', 'architecture', 'quality', 'ci']) assert.equal(s[id].state, 'todo', id);
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
  const paths = { description: 'docs/about.md', architecture: 'ARCHITECTURE.md', rulesBase: 'rules/base.md' };
  const files = { 'docs/about.md': true, 'ARCHITECTURE.md': true, 'rules/base.md': true, '.ai-factory/config.yaml': true, 'AGENTS.md': true };
  const s = byId(readinessSteps(facts({ files, paths })));
  assert.equal(s.context.state, 'done'); assert.equal(s.architecture.state, 'done');
  const missing = byId(readinessSteps(facts({ paths: { description: 'docs/about.md' } })));
  assert(missing.context.missing.includes('docs/about.md'));
  assert(!missing.context.missing.includes('.ai-factory/DESCRIPTION.md'));
});

test('skipped applies only to skippable todo steps and never overrides done', () => {
  const s = byId(readinessSteps(facts({ files: {} }), ['install', 'context', 'architecture', 'quality', 'ci']));
  assert.equal(s.install.state, 'done');
  assert.equal(s.context.state, 'todo');
  assert.equal(s.architecture.state, 'todo');
  assert.equal(s.quality.state, 'skipped');
  assert.equal(s.ci.state, 'skipped');
  const done = byId(readinessSteps(facts({ files: { 'lefthook.yml': true, '.github/workflows/ci.yml': true } }), ['quality', 'ci']));
  assert.equal(done.quality.state, 'done'); assert.equal(done.ci.state, 'done');
});

test('skipped quality and CI complete the checklist; the next step is the first todo', () => {
  const files = { ...contextFiles, '.ai-factory/ARCHITECTURE.md': true };
  const steps = readinessSteps(facts({ files }), ['quality', 'ci', 'docs', 'rules', 'build', 'docker']);
  assert.equal(readinessComplete(steps), true);
  assert.equal(readinessComplete(readinessSteps(facts({ files }), ['quality', 'ci'])), false, 'optional steps still wait for run or skip');
  assert.equal(nextReadinessStep(steps), undefined);
  assert.equal(nextReadinessStep(readinessSteps(facts({ files })))?.id, 'quality');
  const s = byId(readinessSteps(facts()));
  assert.equal(s.quality.anyOf, true); assert.equal(s.ci.anyOf, true); assert.equal(s.context.anyOf, false);
});

test('detected artifacts complete their steps', () => {
  const files = {
    ...contextFiles, '.ai-factory/ARCHITECTURE.md': true, 'lefthook.yml': true, '.github/workflows/ci.yml': true,
    'docs/usage.md': true, '.ai-factory/RULES.md': true, 'Makefile': true, 'compose.yml': true,
  };
  const s = byId(applyRan(readinessSteps(facts({ files })), ['docs']));
  assert(Object.values(s).every(v => v.state === 'done'));
  assert.equal(readinessComplete(Object.values(s)), true);
});

test('docs, rules, build and docker follow config.yaml paths and any-of file lists', () => {
  const s = byId(applyRan(readinessSteps(facts({ files: { 'manual/intro.md': true, 'rules.md': true, 'Justfile': true, 'Dockerfile': true }, paths: { docs: 'manual/', rulesFile: 'rules.md' } })), ['docs']));
  for (const id of ['docs', 'rules', 'build', 'docker']) assert.equal(s[id].state, 'done', id);
  const empty = byId(readinessSteps(facts()));
  assert.deepEqual(empty.docs.missing, ['docs/']); assert.deepEqual(empty.rules.missing, ['.ai-factory/RULES.md']);
  assert.equal(empty.build.anyOf, true); assert.equal(empty.docker.anyOf, true);
  for (const id of ['docs', 'rules', 'build', 'docker']) assert.equal(empty[id].skippable, true, id);
});

test('an existing docs/ folder alone does not complete documentation; a run from the block does', () => {
  const steps = readinessSteps(facts({ files: { 'docs/notes.md': true } }));
  assert.equal(byId(steps).docs.state, 'todo');
  assert.deepEqual(byId(steps).docs.missing, []);
  assert.equal(byId(applyRan(steps, ['docs'])).docs.state, 'done');
  const noFolder = readinessSteps(facts());
  assert.equal(byId(applyRan(noFolder, ['docs'])).docs.state, 'todo', 'a run that produced no docs/ stays todo');
});

test('core readiness needs install, context and architecture only; optional steps never block it', () => {
  const facts = (files: Record<string, boolean>): ReadinessFacts => ({ configured: true, contextSkill: true, files, paths: {} });
  const core = { '.ai-factory/DESCRIPTION.md': true, '.ai-factory/config.yaml': true, '.ai-factory/rules/base.md': true, 'AGENTS.md': true };
  assert.equal(readinessCoreComplete(readinessSteps(facts({}))), false);
  assert.equal(readinessCoreComplete(readinessSteps(facts(core))), false, 'architecture is still missing');
  const steps = readinessSteps(facts({ ...core, '.ai-factory/ARCHITECTURE.md': true }));
  assert.equal(readinessCoreComplete(steps), true);
  assert.equal(readinessComplete(steps), false, 'optional steps remain open while core is ready');
});
