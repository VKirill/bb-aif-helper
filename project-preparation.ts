export const preparationCommands: Record<string, { skill: string; args?: string; icon: string }> = {
  architecture: { skill: 'aif-architecture', icon: 'Layers' },
  roadmap: { skill: 'aif-roadmap', icon: 'Map' },
  quality: { skill: 'aif-quality-setup', args: ' setup', icon: 'ListChecks' },
  ci: { skill: 'aif-ci', icon: 'Workflow' },
  rules: { skill: 'aif-rules', icon: 'ScrollText' },
  docs: { skill: 'aif-docs', icon: 'BookOpen' },
  build: { skill: 'aif-build-automation', icon: 'Hammer' },
  docker: { skill: 'aif-dockerize', icon: 'Box' },
};

export const preparationHelp: Readonly<Record<string, string>> = {
  install: 'Устанавливает AI Factory и добавляет навыки в текущий проект.',
  describe: 'Фиксирует назначение проекта, его стек и контекст для следующих задач.',
  architecture: 'Описывает устройство проекта, границы модулей и расположение кода.',
  roadmap: 'Фиксирует цели проекта и порядок работ.',
  quality: 'Настраивает подходящие проекту проверки кода и локальные Git-хуки.',
  ci: 'Настраивает автоматические проверки в CI проекта.',
  rules: 'Фиксирует правила и соглашения, которыми пользуются агенты в этом проекте.',
  docs: 'Готовит README и документацию проекта.',
  build: 'Собирает команды сборки и разработки в одном месте.',
  docker: 'Готовит конфигурацию для запуска проекта в контейнерах.',
};
