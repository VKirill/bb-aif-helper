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
    rulesBase?: string;
  };
}

const QUALITY_FILES = ['.husky/', 'lefthook.yml', '.lefthook.yml', '.pre-commit-config.yaml'];
const CI_FILES = ['.github/workflows/', '.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml'];

const norm = (p: string) => p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
// anyOf: one of the listed files is enough (quality, CI); otherwise every listed file is required.
const step = (id: string, label: string, actionId: string, done: boolean, missing: string[], skippable = false, anyOf = false): ReadinessStep =>
  ({ id, label, actionId, state: done ? 'done' : 'todo', skippable, anyOf, missing: done ? [] : missing });

/** Plain-language descriptions behind the «?» mark of each readiness step. */
export const readinessHelp: Record<string, string> = {
  install: 'Ставит AI Factory в проект: файл .ai-factory.json и навыки /aif-plan, /aif-implement, /aif-verify и другие. Без этого шага остальные команды недоступны.',
  context: '/aif изучает проект и пишет его описание (DESCRIPTION.md), настройки AI Factory (config.yaml: язык, ветки, push) и базовые правила кода (rules/base.md). Эти файлы читают /aif-plan, /aif-implement, /aif-review и /aif-verify, чтобы понимать проект.',
  architecture: '/aif-architecture описывает, из каких частей состоит проект и где какой код должен лежать (ARCHITECTURE.md). По нему агенты кладут новый код в нужные места и не нарушают границы модулей.',
  quality: 'Git-хуки: перед каждым git commit сами запускаются typecheck, тесты и линтер. Если проверка падает, коммит не создаётся и сломанный код не попадает в историю. Подходит любой инструмент: .husky/, lefthook.yml или .pre-commit-config.yaml.',
  ci: 'CI проверяет код на сервере (например, GitHub Actions) после каждого git push: ставит зависимости с нуля и прогоняет тесты. Результат виден у коммита (✅/❌) и в строке «CI» в «Что проверить». Хуки можно обойти, CI — нет. Если над проектом работает один человек с одной машины, шаг можно пропустить.',
};

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
  const rulesBase = p.rulesBase ?? '.ai-factory/rules/base.md';
  const contextFiles = [description, '.ai-factory/config.yaml', rulesBase, 'AGENTS.md'];
  const steps: ReadinessStep[] = [
    step('install', 'Установить AI Factory', facts.configured ? 'update-factory' : 'basic-install', facts.configured, ['.ai-factory.json']),
    step('context', 'Описать проект (/aif или aif-analyze)', 'setup-context', contextFiles.every(has), contextFiles.filter(rel => !has(rel))),
    step('architecture', 'Описать архитектуру', 'setup-architecture', has(architecture), [architecture]),
    step('quality', 'Настроить проверки', 'quality-setup', any(QUALITY_FILES), QUALITY_FILES, true, true),
    step('ci', 'Настроить CI', 'ci-setup', any(CI_FILES), CI_FILES, true, true),
  ];
  return applySkipped(steps, skipped);
}

export function applySkipped(steps: ReadinessStep[], skipped: string[]): ReadinessStep[] {
  const set = new Set(skipped);
  return steps.map(s => !s.skippable || s.state === 'done' ? s : { ...s, state: set.has(s.id) ? 'skipped' : 'todo' });
}

export function readinessComplete(steps: ReadinessStep[]): boolean {
  return steps.every(s => s.state !== 'todo');
}

export function nextReadinessStep(steps: ReadinessStep[]): ReadinessStep | undefined {
  return steps.find(s => s.state === 'todo');
}
