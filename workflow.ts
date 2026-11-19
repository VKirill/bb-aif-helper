import type { Action, Snapshot } from './model.ts';
import { basicActions, basicPrompt, usesBasicWorkflow } from './basic-workflow.ts';
import { supportsAif222 } from './aif222.ts';
import { compileBriefCommand, sessionBriefBlocked, sessionBriefCommandAvailable } from './session-brief.ts';
import { preparationCommands } from './project-preparation.ts';

/** Task progress guides navigation without declaring an active agent invocation. */
export const planExecutionStarted = (s: Snapshot) => !!s.target && (
  s.target.tasks.some(t => t.done) || ['implement', 'verify', 'fix', 'done'].includes(s.phase)
);
export const contextSetupInDetails = (s: Snapshot, actionId: string) =>
  actionId === 'setup-context' && planExecutionStarted(s);
export const commitNavigationDeferred = (s: Snapshot) => !!(s.target?.tasks.some(t => t.kind === 'commit' && !t.done)
  || ['incremental-at-end', 'single-commit'].includes(s.target?.settings?.commitStrategy ?? '') && s.target?.tasks.some(t => t.kind !== 'commit' && !t.done));

/** Routing is presentation. The selected skill remains the owner of execution/readiness. */
export function workflowActions(s: Snapshot): Action[] {
  const result: Action[] = [];
  const prefix = s.runtime === 'codex' || s.runtime === 'codex-app' ? '$' : '/';
  const hub = s.profile.startsWith('aifhub-');
  const installedHub = s.extensions.some(e => e.name === 'aifhub-extension' && e.state === 'present');
  const contextSkill = installedHub ? 'aif-analyze' : 'aif';
  const maintenance: Action[] = [
    { id: 'update-factory', label: 'Обновить AI Factory', command: 'ai-factory update', group: 'maintenance',
      reason: 'Обновить CLI через владельца установки, затем skills и зарегистрированные расширения проекта; без --force', available: !!s.versions.globalCli || s.configured },
    { id: 'setup-context', label: `Запустить ${contextSkill}`, command: `${prefix}${contextSkill}`, group: 'maintenance',
      reason: s.skills.includes(contextSkill) ? installedHub ? 'Настроить контекст проекта через AIFHub analyze' : 'Настроить контекст проекта через AI Factory' : `Сначала установите ${contextSkill} для ${s.runtime}`,
      available: s.skills.includes(contextSkill) },
  ];
  if (s.extensions.length) maintenance.push({ id: 'update-extensions', label: 'Обновить расширения', command: 'ai-factory extension update', group: 'maintenance',
    reason: 'Сначала обновить AI Factory и установку проекта, затем зарегистрированные расширения и проверить версии/команды; без --force', available: s.configured });
  if (s.configured && supportsAif222(s.versions.installed)) maintenance.push({ id: 'check-worktree', label: 'Проверить ресурсы worktree', command: 'ai-factory worktree-check --json', group: 'check',
    reason: 'Статическая диагностика текущего checkout; не запускает окружения и не доказывает runtime-изоляцию', available: supportsAif222(s.versions.globalCli),
    ...(!supportsAif222(s.versions.globalCli) ? { disabledReason: 'requires-cli222' as const } : {}) });
  if (s.configured && supportsAif222(s.versions.installed)) maintenance.push({ id: 'check-coupling', label: 'Проверить связанность', command: `${prefix}aif-review +coupling`, group: 'check',
    reason: 'Необязательный анализ архитектурных зависимостей по фактическим evidence; без автоматического рефакторинга', available: s.skills.includes('aif-review') });
  // Maintenance can repair an outdated installation even when a selected plan
  // or workflow configuration cannot be resolved. Other actions stay blocked.
  if (s.profile === 'invalid') return maintenance.filter(action => action.id === 'update-factory' || action.id === 'update-extensions');
  if (usesBasicWorkflow(s)) return basicActions(s);
  if (!s.configured) return maintenance;
  for (const step of s.preparation ?? []) {
    const command = preparationCommands[step.id];
    if (!command || step.state !== 'missing' || !s.skills.includes(command.skill)) continue;
    maintenance.push({ id: `prep-${step.id}`, label: step.label, command: `${prefix}${command.skill}${command.args ?? ''}`,
      group: 'setup', reason: 'Отдельный шаг подготовки проекта', available: true });
  }
  const briefBlocked = sessionBriefBlocked(s);
  const contextBlock = s.rulesSync ? 'Сначала синхронизируйте правила выбранного change.'
    : briefBlocked ? 'SessionBrief заблокирован по отчёту из чата; сначала восстановите контекст выбранного change' : null;
  const arg = s.target ? ` ${JSON.stringify(s.target.kind === 'openspec' || s.target.kind === 'classic' ? s.target.id : '@' + s.target.path)}` : '';
  const add = (id: string, label: string, skill: string, group: Action['group'], reason: string, target = arg) => {
    const available = s.skills.includes(skill);
    const blocked = id === 'implement' ? contextBlock : null;
    result.push({ id, label, command: `${prefix}${skill}${target}`, group,
      reason: blocked ?? (available ? reason : `${reason} · skill не установлен для ${s.runtime}`),
      available: available && !blocked, ...(blocked ? { disabledReason: 'context-blocked' as const } : {}) });
  };
  const allDone = !!s.target?.tasks.length && s.target.tasks.every(t => t.done);
  const verify = s.checks.find(c => c.id === 'verify');
  const failed = s.checks.some(c => c.state === 'fail');
  const hasFindings = s.checks.some(c => c.state === 'fail');
  if (s.rulesSync) {
    result.push({ id: 'rules-sync', label: 'Синхронизировать правила', command: s.rulesSync.command, group: 'next',
      available: !!s.versions.globalCli && s.extensions.some(extension => extension.name === 'aifhub-extension'
        && extension.state === 'present' && extension.commands?.includes('aifhub-mode')),
      reason: 'Запустить синхронизацию правил выбранного change по команде из последнего ответа' });
  }
  if (briefBlocked && s.target?.kind === 'openspec') {
    if (!s.rulesSync) add('context-sync', 'Синхронизировать change', 'aif-mode', 'next', 'Первый шаг восстановления контекста выбранного change', ` sync --change ${JSON.stringify(s.target.id)}`);
    result.push({ id: 'context-compile', label: 'Пересобрать SessionBrief', command: compileBriefCommand(s.target.id), group: 'next',
      available: sessionBriefCommandAvailable(s), reason: 'После sync собрать контекст только выбранного change; успешный запуск не означает PASS реализации' });
  }
  if (s.worktree.hasUncommitted === true && !commitNavigationDeferred(s)) {
    add('commit', 'Подготовить коммит', 'aif-commit', 'next', 'В текущем проекте есть незакоммиченные файлы; сначала проверить diff и состав коммита', '');
  }
  if (!s.target) {
    if (s.candidates.length > 1) return [...result, ...maintenance];
    add('plan', 'Составить план', 'aif-plan', 'next', 'Подготовить план новой задачи', hub ? ' full' : '');
    if (!hub && s.phase === 'explore') add('fix-new', 'Исправить проблему', 'aif-fix', 'next', 'Для исследованного дефекта; команда уточнит fix-now / plan-first', '');
    add('explore', 'Продолжить исследование', 'aif-explore', 'next', 'Уточнить требования до реализации', '');
    return [...result, ...maintenance];
  }
  if (s.target.kind === 'fix') {
    add('execute-fix', 'Выполнить исправление', 'aif-fix', 'next', 'Fix-план выполняет владелец aif-fix');
  } else if (s.profile === 'aifhub-ultra' && allDone && (s.phase === 'verify' || s.phase === 'done')) {
    add('ultra-receipt', 'Проверить receipt и следующий шаг', 'aif-done', 'next', 'Read-only проверка receipt: точный handoff verify или archive');
  } else if (s.phase === 'fix') {
    add('verify', 'Проверить исправление', 'aif-verify', 'next', 'После fix авторитетная повторная проверка остаётся за verify');
  } else if (hasFindings && (s.phase === 'verify' || allDone)) {
    add('fix-findings', 'Исправить замечания', 'aif-fix', 'next', 'Исправить выбранные findings; затем повторить verify');
    add('verify', 'Повторить проверку', 'aif-verify', 'next', 'Проверить актуальную реализацию');
  } else if (allDone) {
    if (hub && s.profile !== 'aifhub-ultra' && !failed && verify && ['reported-pass', 'warn'].includes(verify.state)) {
      add('done', 'Проверить готовность и завершить', 'aif-done', 'next', 'Verify и done readiness различаются; финализатор проверит актуальность evidence');
    } else add('verify', 'Проверить реализацию', 'aif-verify', 'next', 'Проверить завершённые задачи и обязательные gates');
    if (!hub) add('commit', 'Подготовить коммит', 'aif-commit', 'next', 'Verify необязателен в upstream; project-required checks сохраняются', '');
  } else {
    // Improvement can be repeated, and an unrelated phase cannot attest that it
    // has or has not happened. Keep both owners reachable for an unfinished plan.
    const started = planExecutionStarted(s);
    add('implement', started ? 'Продолжить выполнение' : 'Выполнить план', 'aif-implement', 'next',
      'Выполнить незавершённые задачи выбранного плана; владелец проверит обязательные handoff и готовность');
    add('improve', 'Улучшить план', 'aif-improve', 'next', 'Повторяемое уточнение выбранного плана; не является обязательным повторным шагом карточки');
  }
  if (s.phase === 'done' && s.profile !== 'aifhub-ultra') {
    // A declared phase is not proof of archive success. These are explicit owner actions.
    if (hub) add('sync', 'Синхронизировать артефакты', 'aif-mode', 'next', 'Синхронизация после подтверждённой финализации', ' sync');
    add('commit', 'Подготовить коммит', 'aif-commit', 'next', 'Коммит выполняется отдельно от done', '');
  }
  add('check-verify', 'Соответствие плану', 'aif-verify', 'check', 'Авторитетная проверка реализации');
  add('check-rules', 'Правила проекта', 'aif-rules-check', 'check', 'Rules gate; при необходимости сохранить durable evidence', s.profile === 'aifhub-openspec' ? arg : '');
  add('check-security', 'Безопасность', 'aif-security-checklist', 'check', 'Проверка безопасности в заявленном scope', '');
  add('check-review', 'Code review', 'aif-review', 'check', 'Review текущих изменений', '');
  if (s.profile === 'aifhub-openspec' && s.target.kind === 'openspec') {
    add('check-mode', 'Проверить конфигурацию', 'aif-mode', 'check', 'Read-only doctor выбранного change; без исправлений и синхронизации', ` doctor --change ${JSON.stringify(s.target.id)}`);
  }
  add('qa-prepare', 'Подготовить QA-сценарии', 'aif-qa', 'check', 'Подготовка сценариев не означает прохождение QA', '');
  add('qa-run', 'Пройти QA-сценарии', 'aif-qa-check', 'check', 'Выбрать human/agent режим; записать результаты сценариев', '');
  add('quality', 'Качество кода', 'aif-quality-setup', 'check', 'Read-only аудит стека и существующих проверок; команды не запускаются автоматически', ' audit');
  add('ci', 'Посмотреть CI', 'aif-chat', 'check', 'Проверить существующий CI для нужного SHA; не генерировать конфигурацию', ' ci');
  result[result.length - 1].available = true; // bundled plugin skill, not an AI Factory installation record
  add('quality-setup', 'Настроить проверки', 'aif-quality-setup', 'setup', 'Отдельная настройка подходящих quality tools', ' setup');
  add('ci-setup', 'Настроить CI', 'aif-ci', 'setup', 'Создание/аудит pipeline не означает успешный CI-run', '');
  return [...result, ...maintenance].filter((v, i, a) => a.findIndex(x => x.id === v.id) === i);
}

export function actionPrompt(s: Snapshot, action: Action): string {
  const basic = basicPrompt(s, action);
  if (basic) return basic;
  if (action.id === 'rules-sync') return 'Выполни команду из сообщения только для выбранного change. Перепроверь свежесть сгенерированных правил и сообщи фактический результат. Выполнение плана пользователь запускает отдельно.';
  if (action.id === 'context-compile') return `${action.command}\n\nПосле sync пересобери SessionBrief только выбранного change. Затем проверь ai-factory aifhub-session-brief status --change ${JSON.stringify(s.target?.id)} --json. Сообщи фактический итог как SessionBrief: valid/stale/missing/blocked/research/invalid, не называя код 0 доказательством готовности реализации. Сохрани точный owner handoff при блокере. Не запускай sync, выполнение, commit или другие этапы автоматически; обнови карточку после результата.`;
  if (action.id === 'check-worktree') return 'В корне текущего проекта выполни ai-factory worktree-check --json через существующий CLI AI Factory 2.22+. Это read-only статическая диагностика только текущего checkout. Не запускай контейнеры, сервисы или verifier, не создавай mapping и не меняй конфигурацию. Для сравнения с другими checkout нужны явно выбранные пользователем пути. Сообщи conflicts и пробелы coverage отдельно; этот результат не подтверждает runtime-изоляцию и не является PASS остальных gates. Затем обнови статус плагина.';
  if (['fix-new', 'fix-findings', 'execute-fix'].includes(action.id)) return `${action.command}\n\nПримени установленный aif-fix и действующие workflow.fix_mode / workflow.fix_patch; не подставляй --fix-now, --plan-first, --patch или --no-patch без отдельного выбора пользователя. Существующий fix-план и его выполнение остаются у владельца aif-fix. Нажатие не разрешает другие этапы. После шага обнови карточку.`;
  if (action.id === 'update-factory' || action.id === 'update-extensions') return [
    `Обнови ${action.id === 'update-extensions' ? 'зарегистрированные расширения с обязательным предварительным обновлением AI Factory' : 'AI Factory и затем зарегистрированные расширения'} по явному нажатию кнопки пользователем в этом чате. Контекст установки: ${JSON.stringify({ root: s.root, versions: s.versions, configured: s.configured, extensions: s.extensions })}.`,
    'Сначала проверь фактическое происхождение используемого CLI, конфигурацию проекта, зарегистрированные расширения и текущие локальные изменения. Выполняй этапы последовательно, не параллельно.',
    '1. AI Factory CLI. Обнови существующую установку через её владельца: для обычной глобальной npm-установки — npm install -g ai-factory@latest; для pnpm/yarn/mise или проектной dependency используй её существующий package manager и scope. Не создавай второй CLI, не понижай версию, не заменяй npm link/исходный checkout пакетом из registry и не делай git pull/reset в исходниках автоматически. Если установка связана с исходниками или provenance не подтверждён, сообщи точный owner-шаг вместо замены установки. Проверь фактическую версию используемого CLI. Подсказка self-update не считается обновлением пакета.',
    '2. Установка проекта. Если проект инициализирован, после обновления CLI заново выполни ai-factory update из рабочей папки проекта и проверь версию в .ai-factory.json. Эта команда сама проверяет расширения перед базовыми skills и затем переустанавливает extension skills/injections; не утверждай, что её внутренний порядок иной. Сохрани пользовательские изменения; не используй --force. Если обновление CLI или базовой установки не удалось/не подтверждено, остановись до следующего этапа и сообщи блокер. Если .ai-factory.json отсутствует, обнови только существующий CLI; не запускай init или обновление расширений.',
    '3. Расширения после AI Factory. Только после успешных этапов 1–2 заново прочитай список зарегистрированных расширений. Если список непустой, выполни ai-factory extension update — это корректная команда для всех зарегистрированных расширений; не используй ai-factory update extensions, extensions update или несуществующий --all. Обычный update мог уже обновить их: неизменная версия допустима, не применяй --force ради изменения номера. Не добавляй новые расширения, не удаляй конфигурацию и не запускай повторные циклы при ошибках.',
    '4. Проверка результата. Выполни ai-factory extension list для инициализированного проекта; сравни записанные версии расширений в .ai-factory.json с установленными extension.json. Проверь наличие объявленных extension-команд и SKILL.md (в том числе aif-analyze, если расширение его предоставляет) для текущего runtime, не запуская сами workflow-команды. Отдельно сообщи результаты CLI, проекта, каждого расширения и доступности команд: updated/unchanged/skipped/failed/unknown. Код 0 не заменяет проверку skipped/failed и отсутствующих файлов. Если список расширений пуст, отметь это и пропусти этап 3.',
    'Сохрани выбранный useSymlinks и skillSymlinks: не переключай --symlinks/--no-symlinks автоматически. Completion hook остаётся opt-in: не выполняй enable или run и не подключай verifier в рамках обновления.',
    'После операции обнови карточку через aif_chat_status с принудительным чтением. Не запускай реализацию или проверки приложения.',
  ].join('\n');
  if (action.id === 'setup-context' || action.id.startsWith('prep-')) return `${action.command}\n\nПользователь выбрал отдельный шаг подготовки проекта. Примени именно ${action.command} по установленному skill-контракту. Выбранный план не является аргументом команды. После шага обнови карточку через aif_chat_status.`;
  if (action.id === 'commit') return `${action.command}\n\nКонтекст кнопки AI Factory: ${JSON.stringify({ target: s.target?.path ?? null, profile: s.profile, expectedFingerprint: s.fingerprint })}.\nПользователь выбрал подготовку коммита. Примени установленный aif-commit в текущем проекте: сначала перечитай правила, git status и diff, определи относящиеся к задаче изменения и сообщение коммита. Незакоммиченные файлы не означают, что все они согласованы для включения: сохрани несвязанные изменения и не добавляй все файлы автоматически. Соблюдай действующие gates и разрешения на коммит; не выполняй push или публикацию без отдельного разрешения. Активный план может отсутствовать после архивации. После действия обнови карточку через aif_chat_status.`;
  const readiness = action.id === 'implement'
    ? '\nНаличие кнопки не подтверждает прохождение improve, sync или готовность к выполнению. Проверь обязательные handoff, артефакты и условия установленного aif-implement/AIFHub. Сохрани действующие blockers; не обходи отсутствующие обязательные условия и не запускай повторное улучшение только из-за неизвестного этапа карточки.' : '';
  return `${action.command}\n\nКонтекст кнопки AI Factory: ${JSON.stringify({ target: s.target?.path ?? null, profile: s.profile, expectedFingerprint: s.fingerprint })}.\nВыполни выбранное действие в текущей задаче. Сначала перечитай выбранный план/change и действующие правила. Для новой задачи без описания запроси её описание. Не расширяй scope. Не считай старые отчёты актуальным PASS без проверки evidence. После этапа обнови карточку через aif_chat_status или bb plugin run aif-chat show. Нажатие этой кнопки не разрешает другие действия workflow.${readiness}`;
}
