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
    docs?: string;
    rulesFile?: string;
  };
}

const QUALITY_FILES = ['.husky/', 'lefthook.yml', '.lefthook.yml', '.pre-commit-config.yaml'];
const CI_FILES = ['.github/workflows/', '.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml'];
export const BUILD_FILES = ['Makefile', 'Taskfile.yml', 'Taskfile.yaml', 'Justfile', 'justfile', 'magefile.go'];
export const DOCKER_FILES = ['Dockerfile', 'compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'];
/** Steps the owner may mark «Пропустить»; the RPC accepts only these ids. */
export const SKIPPABLE_STEPS = ['quality', 'ci', 'docs', 'rules', 'build', 'docker'] as const;
export type SkippableStepId = (typeof SKIPPABLE_STEPS)[number];

const norm = (p: string) => p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
// anyOf: one of the listed files is enough (quality, CI); otherwise every listed file is required.
const step = (id: string, label: string, actionId: string, done: boolean, missing: string[], skippable = false, anyOf = false): ReadinessStep =>
  ({ id, label, actionId, state: done ? 'done' : 'todo', skippable, anyOf, missing: done ? [] : missing });

/** Plain-language descriptions behind the «?» mark of each readiness step. */
export const readinessHelp: Record<string, string> = {
  install: 'Ставит AI Factory в проект: файл .ai-factory.json и навыки /aif-plan, /aif-implement, /aif-verify и другие. Без этого шага остальные команды недоступны.',
  context: '/aif изучает проект и пишет его описание (DESCRIPTION.md), настройки AI Factory (config.yaml: язык, ветки, push) и базовые правила кода (rules/base.md). Эти файлы читают /aif-plan, /aif-implement, /aif-review и /aif-verify, чтобы понимать проект.',
  architecture: '/aif-architecture описывает, из каких частей состоит проект и где какой код должен лежать (ARCHITECTURE.md). По нему агенты кладут новый код в нужные места и не нарушают границы модулей.',
  quality: 'Git-хуки: перед каждым git commit сами запускаются typecheck, тесты и линтер. Если проверка падает, коммит не создаётся и сломанный код не попадает в историю. Шаг выполнен, если в проекте есть любой из: .husky/, lefthook.yml, .lefthook.yml, .pre-commit-config.yaml.',
  ci: 'CI проверяет код на сервере (например, GitHub Actions) после каждого git push: ставит зависимости с нуля и прогоняет тесты. Результат виден у коммита (✅/❌) и в строке «CI» в «Что проверить». Хуки можно обойти, CI — нет. Шаг выполнен, если есть любой из: .github/workflows/, .gitlab-ci.yml, .circleci/config.yml, Jenkinsfile, bitbucket-pipelines.yml. Если над проектом работает один человек с одной машины, шаг можно пропустить.',
  docs: '/aif-docs пишет документацию проекта: короткий README как стартовую страницу и подробные страницы по темам в папке docs/. Шаг выполнен, когда есть папка docs/ с файлами.',
  rules: '/aif-rules записывает правила кода проекта в RULES.md: соглашения, запреты, «всегда делай так». /aif-implement читает их перед каждой задачей, /aif-rules-check проверяет по ним изменения. Навык спросит, какие правила добавить.',
  build: '/aif-build-automation создаёт или дополняет файл команд сборки (Makefile, Taskfile, Justfile), чтобы установка, тесты и сборка запускались одной командой. Если проекту хватает npm-скриптов, шаг можно пропустить.',
  docker: '/aif-dockerize готовит Docker: Dockerfile, compose для разработки и продакшена, .dockerignore, и проверяет безопасность продакшен-образа. Может спросить про базу данных, прокси и кэш. Если проект не запускается в контейнере, шаг можно пропустить.',
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
  const docs = norm(p.docs ?? 'docs');
  const rulesFile = p.rulesFile ?? '.ai-factory/RULES.md';
  const steps: ReadinessStep[] = [
    step('install', 'Установить AI Factory', facts.configured ? 'update-factory' : 'basic-install', facts.configured, ['.ai-factory.json']),
    step('context', 'Описать проект (/aif или aif-analyze)', 'setup-context', contextFiles.every(has), contextFiles.filter(rel => !has(rel))),
    step('architecture', 'Описать архитектуру', 'setup-architecture', has(architecture), [architecture]),
    step('quality', 'Настроить проверки', 'quality-setup', any(QUALITY_FILES), QUALITY_FILES, true, true),
    step('ci', 'Настроить CI', 'ci-setup', any(CI_FILES), CI_FILES, true, true),
    step('docs', 'Написать документацию', 'docs-setup', hasDir(docs), [`${docs}/`], true),
    step('rules', 'Добавить правила кода', 'rules-setup', has(rulesFile), [rulesFile], true),
    step('build', 'Настроить команды сборки', 'build-setup', any(BUILD_FILES), BUILD_FILES, true, true),
    step('docker', 'Настроить Docker', 'docker-setup', any(DOCKER_FILES), DOCKER_FILES, true, true),
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
