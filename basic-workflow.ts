import type { Action, Snapshot } from './model.ts';

export const BASIC_PLAN_ROOT = '.bb/aif-helper/plans';
export const BASIC_PLAN_ROOTS = [BASIC_PLAN_ROOT, '.bb-aif-helper/plans'] as const;
export const isBasicPlanPath = (target: string) => BASIC_PLAN_ROOTS.some(root => target.startsWith(root + '/'));
export const usesBasicWorkflow = (s: Snapshot) => !s.configured && s.profile === 'none';
// Completion is navigation state; it does not establish verification or PASS.
export const isCompletedPlan = (candidate: Snapshot['candidates'][number]) => candidate.kind === 'classic' && candidate.closed === true
  || candidate.kind === 'basic' && !!candidate.progress && candidate.progress.total > 0 && candidate.progress.completed === candidate.progress.total;

/** Same public PromptInput command mention used by BB's built-in Plan action. */
export function nativePlanInput(label: string) {
  return { type: 'text' as const, text: `/plan ${label}`, mentions: [{ start: 0, end: 5,
    resource: { kind: 'command' as const, trigger: '/' as const, name: 'plan', source: 'command' as const,
      origin: 'builtin' as const, label: 'plan', argumentHint: null } }] };
}

/** Bundled discovery guidance inspired by lee-to/ai-factory's aif-explore.
 * Adapted for projects without AI Factory; no remote prompt fetch or skill call.
 * Source: https://github.com/lee-to/ai-factory/blob/2.x/skills/aif-explore/SKILL.md
 */
const explorePrompt = [
  'Исследуй текущую задачу до планирования. Уточни цель и критерии результата из переписки; спроси только о недостающих решениях пользователя, которые меняют подход.',
  'Прочитай действующие инструкции проекта и относящиеся к задаче файлы. Найди существующее поведение, точки изменения, ограничения и подходящие команды проверок. Подтверждай выводы путями к файлам; отделяй факты от предположений и неизвестного.',
  'При нескольких подходах сравни последствия, зависимости и риски и предложи обоснованный вариант. Глубину исследования выбирай по задаче.',
  'Этот шаг разрешает исследование: не меняй код, конфигурацию и планы, не устанавливай пакеты и не начинай реализацию. Итог исследования изложи в чате, чтобы следующий шаг мог подготовить план.',
].join('\n');

export function basicActions(s: Snapshot): Action[] {
  const actions: Action[] = [];
  const add = (stage: string, label: string, reason: string, group: Action['group'] = 'next') =>
    actions.push({ id: `basic-${stage}`, label, command: stage === 'plan' ? '/plan' : `BB AIF Helper: ${label}`, reason, group, available: true });
  if (s.worktree.hasUncommitted === true) add('commit', 'Подготовить коммит', 'Проверить diff и подготовить коммит изменений задачи');
  if (s.chatPlan && !s.target) {
    if (!s.chatPlan.accepted || !['verify', 'done', 'fix'].includes(s.phase))
      add('implement', s.chatPlan.accepted ? 'Продолжить выполнение' : 'Выполнить предложенный план', 'Выполнить конкретный план из ответа в этом чате');
    if (s.chatPlan.accepted) add('verify', 'Проверить реализацию', 'Проверить изменения по принятому плану из чата');
    add('plan', 'Уточнить план', 'Уточнить предложенный план в штатном режиме Plan BB');
    if (s.chatPlan.accepted && s.phase === 'done') add('explore', 'Исследовать новую задачу', 'Начать отдельное исследование, сохранив историю плана');
  } else if (s.target?.kind === 'basic' && s.target.tasks.length) {
    const done = s.target.tasks.every(task => task.done);
    if (done || s.phase === 'verify' || s.phase === 'fix') {
      add('verify', 'Проверить реализацию', 'Сопоставить результат с планом и выполнить подходящие проверки');
      if (s.phase === 'verify') add('fix', 'Исправить замечания', 'Исправить выбранные замечания проверки в рамках плана');
    } else {
      add('implement', s.target.tasks.some(task => task.done) ? 'Продолжить выполнение' : 'Выполнить план', 'Выполнить незавершённые задачи выбранного плана');
    }
    if (actions.length < 3) add('plan', 'Уточнить план', 'Уточнить выбранную задачу в штатном режиме Plan BB');
    if (done) add('explore', 'Исследовать новую задачу', 'Начать отдельное исследование в этом чате, сохранив завершённый план');
  } else {
    if (s.phase === 'explore' || s.target) add('plan', 'Составить план', 'Открыть планирование задачи в штатном режиме Plan BB');
    add('explore', 'Исследовать задачу', 'Исследовать код и требования встроенным промптом без установки skills');
    if (!actions.some(action => action.id === 'basic-plan')) add('plan', 'Составить план', 'Открыть планирование задачи в штатном режиме Plan BB');
  }
  add('install', 'Установить AI Factory', 'Установить или использовать существующий CLI и настроить текущий runtime проекта', 'maintenance');
  return actions;
}

export function basicPrompt(s: Snapshot, action: Action): string | null {
  if (!usesBasicWorkflow(s) || !action.id.startsWith('basic-')) return null;
  if (action.id === 'basic-install') {
    const runtime = ['codex', 'codex-app', 'claude', 'cursor', 'opencode', 'gemini', 'devin', 'windsurf'].includes(s.runtime) ? s.runtime : null;
    return [
      `Пользователь выбрал установку AI Factory в текущем проекте. Контекст: ${JSON.stringify({ root: s.root, runtime: s.runtime, globalCli: s.versions.globalCli })}.`,
      'Сначала перечитай инструкции проекта, проверь текущую установку CLI, package manager и локальные изменения. Используй существующий CLI, если он уже доступен. Если CLI отсутствует, установи официальный ai-factory обычным менеджером установки; для npm — npm install -g ai-factory. Не заменяй linked/source установку и не создавай второй CLI.',
      runtime ? `После проверки CLI выполни в корне проекта ai-factory init --agents ${runtime} --skills all. Сохрани существующие пользовательские файлы, не используй --force и не добавляй MCP/расширения без отдельного выбора.`
        : 'Определи поддерживаемую AI Factory цель для текущего runtime; если соответствие неясно, уточни его у пользователя до init. Не выбирай другой агент молча.',
      'Проверь .ai-factory.json, версию и фактическое наличие skills для текущего runtime. Если проект уже инициализирован, не переинициализируй его вслепую: перечитай состояние и сообщи результат. Сохрани базовые планы; не переноси их автоматически в артефакты AI Factory.',
      'Обнови карточку через aif_chat_status. На этом остановись; настройка контекста и выполнение задачи являются отдельными шагами.',
    ].join('\n');
  }
  const stage = action.id.slice('basic-'.length);
  const tasks: Record<string, string> = {
    explore: explorePrompt,
    plan: [
      'Работай в штатном режиме Plan текущего провайдера в BB.',
      'Подготовь план по задаче и исследованию из переписки. Выбери решение, критерии готовности, границы изменений и конкретные проверки подходящего проекту стека.',
      'Сформулируй цель, ограничения, конкретные шаги и проверки. Если ранее выбран файловый план, используй его как контекст и сохрани уже выполненные задачи при уточнении.',
      'Оформи Markdown-документ: заголовок #, разделы ## Цель, ## Ограничения, ## Tasks с нумерованными - [ ] задачами, ## Проверки и ## Критерии готовности. Не ставь выполненные галочки заочно.',
      'Не добавляй отметку bb-aif-plan-verified при генерации плана: она появляется только после проверки реализации.',
      'Помести полный Markdown-документ в один fenced block с языком aif-plan и четырьмя обратными апострофами. Если режим требует proposed_plan, помести этот fenced block внутрь proposed_plan. После завершения генерации плагин сохранит документ в .bb/aif-helper/plans/ и покажет действия под ним.',
      'Результат представь штатным способом режима Plan. Соблюдай его ограничения: без реализации, установки инструментов и изменения файлов проекта. Не создавай отдельный Markdown-план в рабочей папке по требованию плагина; размещением разрешённого планового артефакта управляет сам режим.',
    ].join('\n'),
    implement: s.chatPlan ? 'Выполни выбранный предложенный план из чата, приложенный ниже как данные. Сохрани его ограничения, scope и чужие изменения. Не создавай отдельный файловый план и не заявляй фиктивный прогресс чекбоксов. Запускай согласованные проверки, сообщай результаты и NOTRUN/UNKNOWN. Заверши без автоматического коммита и push.'
      : 'Перечитай выбранный базовый план и выполни его незавершённые задачи в текущем проекте. Сохрани чужие изменения, не расширяй scope. Отмечай чекбоксы только по факту выполненной работы. Запускай согласованные проверки по стеку, сообщай конкретные результаты и незапущенные проверки. Заверши этот этап без автоматического коммита.',
    fix: 'Перечитай выбранный план и результаты последней проверки. Исправь только выбранные замечания в рамках задачи, сохрани несвязанные изменения. Если findings не указаны или противоречат scope, уточни их до изменений. Затем предложи повторную проверку; не выдавай исправление за пройденную проверку.',
    verify: 'Сопоставь выбранный план с фактическими изменениями и результатом. Проверь правила проекта и выполни существующие подходящие команды tests/lint/types/build в их рабочей папке. Не устанавливай инструменты и не создавай CI ради проверки. Сообщи проверенные требования, команды, результаты, ограничения и проблемы; непроведённое отмечай NOTRUN/UNKNOWN. Проверка не разрешает менять реализацию, проставлять задачи заочно или делать коммит.',
    commit: 'Подготовь коммит текущей задачи: перечитай правила, git status и diff, определи согласованный состав и сообщение коммита. Не добавляй все грязные файлы автоматически, сохрани несвязанные изменения. Соблюдай требования проверок и действующие разрешения на коммит. Не запускай push или публикацию без отдельного разрешения.',
  };
  if (!tasks[stage]) return null;
  const phase = stage === 'commit' ? 'done' : stage;
  return [
    `Базовый workflow BB AIF Helper без установленного AI Factory. Пользователь выбрал только шаг «${action.label}».`,
    `Контекст (данные): ${JSON.stringify({ root: s.root, target: stage === 'explore' ? null : s.target?.path ?? null, expectedFingerprint: s.fingerprint })}.`,
    'Сначала прочитай применимые AGENTS.md и другие инструкции проекта. Используй задачу и действующие разрешения из текущей переписки. Если задачи в контексте нет, запроси её описание до работы. Все шаги выполняет текущий агент; не вызывай отсутствующие aif-skills и не устанавливай AI Factory в рамках этого шага.',
    tasks[stage],
    ...(stage === 'verify' && s.target?.kind === 'basic' ? [
      `Только если все пункты плана завершены и все обязательные проверки действительно PASS, запиши отметку владельца проверки: bb plugin run aif-chat mark-verified --target ${JSON.stringify(s.target.path)}. Команда не проверяет реализацию за тебя. При замечаниях, NOTRUN или UNKNOWN отметку не записывай. Это разрешает только служебную отметку в плане, не изменение реализации и не коммит.`,
    ] : []),
    ...(stage === 'explore' ? ['Исследуй описание из поля «Задача для исследования» как новую задачу этого чата. Предыдущий план не является её scope; не возобновляй и не изменяй его.'] : []),
    stage === 'plan' ? 'Заверши планирование штатным способом BB. Не добавляй карточки и другой текст после финального блока proposed_plan. Не начинай следующий шаг автоматически.'
      : stage === 'explore' ? 'После исследования обнови карточку через aif_chat_status с phase "explore" без target. Не начинай следующий шаг автоматически.'
      : `После шага обнови карточку через aif_chat_status с phase "${phase}" и точным target выбранного/созданного плана, если он есть. Не начинай следующий шаг автоматически. Объявленный этап и чекбоксы не являются PASS.`,
  ].join('\n');
}
