import type { ReadinessStep } from './model.ts';

export interface ReadinessFacts {
  configured: boolean;
  /** Context skill (aif / aif-analyze) installed for the runtime; availability is checked by actions, not step state. */
  contextSkill: boolean;
  /** Project-relative path → present. A directory is satisfied by its own entry or any path inside it; `.github/workflows/` needs at least one *.yml/*.yaml. */
  files: Record<string, boolean>;
  /** Resolved artifact paths from config.yaml `paths.*` and `config.rules.base`; defaults are applied here. */
  paths: {
    description?: string;
    architecture?: string;
    roadmap?: string;
    rulesBase?: string;
    docs?: string;
  };
  /** config.rules keys other than `base`; their presence completes the optional rules step. */
  ruleAreas?: string[];
}

const QUALITY_FILES = ['.husky/', 'lefthook.yml', '.lefthook.yml', '.pre-commit-config.yaml'];
const CI_FILES = ['.github/workflows/', '.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml'];
const BUILD_FILES = ['Makefile', 'Taskfile.yml', 'justfile', 'magefile.go'];
const DOCKER_FILES = ['Dockerfile', 'compose.yml', 'compose.yaml', 'docker-compose.yml'];

const norm = (p: string) => p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
const step = (id: string, label: string, actionId: string, done: boolean, missing: string[], optional = false, skippable = false): ReadinessStep =>
  ({ id, label, actionId, state: done ? 'done' : 'todo', optional, skippable, missing: done ? [] : missing });

export function readinessSteps(facts: ReadinessFacts, skipped: string[] = []): ReadinessStep[] {
  const present = new Set(Object.entries(facts.files).filter(([, v]) => v).map(([k]) => norm(k)));
  const has = (rel: string) => present.has(norm(rel));
  const hasDir = (rel: string) => {
    const d = norm(rel);
    for (const k of present) if (k === d || k.startsWith(`${d}/`)) return true;
    return false;
  };
  const any = (rels: string[]) => rels.some(rel => rel.endsWith('/') ? hasDir(rel) : has(rel));
  const p = facts.paths;
  const description = p.description ?? '.ai-factory/DESCRIPTION.md';
  const architecture = p.architecture ?? '.ai-factory/ARCHITECTURE.md';
  const roadmap = p.roadmap ?? '.ai-factory/ROADMAP.md';
  const rulesBase = p.rulesBase ?? '.ai-factory/rules/base.md';
  const docs = p.docs ?? 'docs/';
  const contextFiles = [description, '.ai-factory/config.yaml', rulesBase, 'AGENTS.md'];
  const steps: ReadinessStep[] = [
    step('install', 'Установить AI Factory', facts.configured ? 'update-factory' : 'basic-install', facts.configured, ['.ai-factory.json']),
    step('context', 'Описать проект (/aif или aif-analyze)', 'setup-context', contextFiles.every(has), contextFiles.filter(rel => !has(rel))),
    step('architecture', 'Описать архитектуру', 'setup-architecture', has(architecture), [architecture]),
    step('roadmap', 'Составить roadmap', 'setup-roadmap', has(roadmap), [roadmap], false, true),
    step('quality', 'Настроить проверки', 'quality-setup', any(QUALITY_FILES), QUALITY_FILES, false, true),
    step('ci', 'Настроить CI', 'ci-setup', any(CI_FILES), CI_FILES, false, true),
    step('rules', 'Настроить правила проекта', 'setup-rules', (facts.ruleAreas?.length ?? 0) > 0, ['.ai-factory/rules/'], true),
    step('docs', 'Создать документацию', 'setup-docs', hasDir(docs), [docs], true),
    step('build', 'Настроить сборку', 'setup-build', BUILD_FILES.some(has), BUILD_FILES, true),
    step('docker', 'Настроить Docker', 'setup-docker', DOCKER_FILES.some(has), DOCKER_FILES, true),
  ];
  return applySkipped(steps, skipped);
}

export function applySkipped(steps: ReadinessStep[], skipped: string[]): ReadinessStep[] {
  const set = new Set(skipped);
  return steps.map(s => !s.skippable || s.state === 'done' ? s : { ...s, state: set.has(s.id) ? 'skipped' : 'todo' });
}

export function readinessComplete(steps: ReadinessStep[]): boolean {
  return steps.every(s => s.optional || s.state !== 'todo');
}

export function nextReadinessStep(steps: ReadinessStep[]): ReadinessStep | undefined {
  return steps.find(s => !s.optional && s.state === 'todo');
}
