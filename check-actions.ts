import type { Snapshot } from './model.ts';

export const rowActions: Record<string, string> = {
  verify: 'check-verify', rules: 'check-rules', security: 'check-security', review: 'check-review',
  'qa-plan': 'qa-prepare', qa: 'qa-run', quality: 'quality', ci: 'ci', readiness: 'done',
  mode: 'check-mode',
};
/** Plain-language explanation shown under the «?» button of each check row. */
export const checkHelp: Record<string, string> = {
  verify: '/aif-verify сверяет сделанное с планом: все ли задачи выполнены, ничего ли не забыто, собирается ли код и проходят ли тесты. Код не меняет, итог — PASS, WARN или FAIL.',
  rules: '/aif-rules-check проверяет изменённые файлы на соответствие правилам проекта (RULES.md, rules/base.md и правила отдельных областей). Только читает файлы.',
  security: '/aif-security-checklist ищет проблемы безопасности по OWASP Top 10: инъекции, XSS, секреты в коде, ошибки авторизации, уязвимые зависимости.',
  review: '/aif-review делает ревью текущих изменений, как опытный коллега: ошибки, риски, производительность, читаемость.',
  'qa-plan': '/aif-qa готовит тест-план и конкретные сценарии проверки изменения. Сами сценарии не прогоняет.',
  qa: '/aif-qa-check прогоняет подготовленные QA-сценарии (вы сами или агент) и записывает результат каждого.',
  coverage: 'Отчёт расширения AIFHub: каждое требование изменения связано с реализацией и проверкой.',
  readiness: 'Отчёт расширения AIFHub: все обязательные проверки пройдены и задачу можно закрывать через /aif-done.',
  quality: '/aif-quality-setup audit смотрит, какие линтеры, проверки типов, тесты и git-хуки есть в проекте и чего не хватает. Сами проверки не запускает.',
  ci: 'Смотрит результат CI (например, GitHub Actions) для текущего коммита. Сам pipeline не создаёт и не меняет.',
  mode: 'AIFHub OpenSpec: /aif-mode doctor читает конфигурацию и артефакты выбранного change и сообщает о проблемах. Ничего не исправляет.',
};
export const supplementaryChecks = new Set(['rules', 'security', 'review', 'qa-plan', 'qa', 'quality', 'ci', 'mode']);
const commands: Record<string, string> = {
  'aif-verify': 'verify', 'aif-rules-check': 'rules', 'aif-security-checklist': 'security', 'aif-review': 'review',
};
export const unchangedReason = 'Файлы не изменились с момента фиксации результата этой проверки. Повторный запуск не требуется.';
export function unchangedCheck(snapshot: Snapshot, skill: string) {
  return snapshot.checks.some(check => check.id === commands[skill] && check.chat?.freshness === 'unchanged');
}
export function lockUnchangedChecks(snapshot: Snapshot) {
  for (const action of snapshot.actions) {
    const skill = action.command.match(/^[/$](aif(?:-[a-z0-9]+)*)\b/)?.[1];
    if (skill && action.available && unchangedCheck(snapshot, skill)) {
      action.available = false; action.disabledReason = 'unchanged'; action.reason = unchangedReason;
    }
  }
}
