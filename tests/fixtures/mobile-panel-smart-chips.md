# План: панель как iOS-приложение, кнопки с аргументами и оценка через Gemini Decisions

- Ветка: `main` (без новой ветки, `git.create_branches: false`)
- Создан: 2026-11-19
- Версия: 0.18.0

## Original Request

1. Надо поправить верстку на мобилке, сделать ее адаптированной к телефонам чтобы смотрелось все органично без кучи рамок и отступов чтобы было своего рода панель приложения как на любых iOS приложениях, красиво и эффектно сохраняя дизайн

2. Можно ли как-то сразу в кнопки вписывать не готовые голые команды а если есть какие-то команды которые сразу содержат что надо ввести, то сразу это отображалось бы в кнопках. И на основе таких команд можно как-то у кнопок прописывать как квадратичное число у команды проценты какую команду с большей вероятностью щас надо выбрать? Например оценивать её на основе модели https://aistudio.google.com/docs/decisions-api (если он подключен) и вписан апи ключ.

Так если есть этот плагин, давай заменять обычный ввод апи что можно ввести или выбрать из енв каталога

## Settings

- Testing: yes
- Logging: standard
- Docs: yes
- Commit strategy: single-commit
- Development methodology: implementation-first

## Roadmap Linkage

`ROADMAP.md` нет — привязки нет.

## Проверенные факты (основа решений)

| # | Факт | Как проверен |
|---|---|---|
| 1 | Decisions API: `POST https://generativelanguage.googleapis.com/v1beta/decisions`, заголовок `x-goog-api-key`, модель `gemini-decision-1`, вопрос `type: "choice"` с `criteria` (id → описание) возвращает `answers.<key>.probabilities` (сумма 1), `choice`, `confidence`; выходных токенов 0 | Документация + живой вызов ключом `GEMINI_API_KEY_AISTUDIO` на выдуманном примере: `verify` 0,962, 195 входных токенов |
| 2 | Плагин может вызвать RPC другого плагина: `bb.sdk.plugins.callRpc({ pluginId, method, input, outputSchema, signal })`, таймаут SDK 75 с | `bb-plugin-sdk.d.ts:18282`, `:18379` |
| 3 | env-catalog 0.3.3 регистрирует RPC `env_list` (`{query?, kind?}` → `{variables: summary[]}`, без значений) и `env_get_value` (`{name}` → `{name, kind, value, …}`), без проверки вызывающего; чтение через RPC не пишется в его журнал выдачи | Исходники `v0.3.3` (`server.ts:70-110`, `:636-660`); живой `bb plugin rpc call env-catalog env_list` вернул 8 имён |
| 4 | Строковая настройка с `secret: true` хранится в файле 0600, в UI не попадает (в `useSettings` секретов нет), сервер читает её `settings.get()`, пишет `settings.experimental_set` | `bb-plugin-sdk.d.ts:19751-19758`, разведчики 2 и 3 |
| 5 | Тестовый хост умеет подменять `plugins.callRpc` (`createFakePluginHost({ sdk })` / `harness.sdk.stub`), глобальный `fetch` — нет, его подменяем в тесте сами | `bb-plugin-sdk-testing.d.ts:1094`, `:1359`, `:1461` |
| 6 | BB собирает стили Tailwind 4.3.0; варианты `@container` компилируются; сейчас ширина панели нигде не учитывается | Разведчик 1 (сборка в памяти) |
| 7 | Карточка в сообщении (`Directive`, `ContextCard`) использует те же `Section`, «Сейчас», проверки и версии, что и панель | `app.tsx:521`, разведчик 1 |
| 8 | Чипы из ответа сейчас всегда голые: `extractAifInvocations` берёт только имя (кроме `aif-mode sync`); `id` должен оставаться голым (`commandId` regex, dismiss, gate) | `suggestions.ts:6-19`, `model.ts:59`, разведчик 3 |
| 9 | Чип несуществующей команды (`/aif-composer-mode`) показывается тусклым: доступность решается в `server.ts:256`, а `nextStepItems` такие id отбрасывает | разведчик 3 |
| 10 | Выпадающего меню среди вендорных компонентов нет (`components/ui`: dialog, responsive-overlay, tooltip…) | `ls components/ui` |

## Решения

1. **Одна раскладка на все ширины, без двойного кода.** Строки шага подготовки и роли исполнителя устроены одинаково на телефоне и на компьютере; узкость обрабатывают только container queries (`@container/aif` на `.aif-panel`) там, где без них не обойтись (шапка).
2. **Стиль «сгруппированный список iOS» только в панели.** `Section` читает контекст поверхности (`panel` | `card`): в панели — заголовок группы мелким серым текстом над блоком, сам блок `rounded-xl bg-card` без рамки, строки разделены `divide-y` с отступом слева; в карточке сообщения — как сейчас. Вложенные рамки внутри секций («В работе», «Что проверить») в панели убираются.
3. **Шаг подготовки:** `[○] 4. Настроить проверки ⓘ … [›]`. Стрелка `›` запускает шаг (имя кнопки «Запустить: …», те же условия блокировки). Нажатие на название раскрывает под строкой описание шага и кнопку «Пропустить» / «Вернуть». Отдельных кнопок «Запустить» / «Пропустить» в строке больше нет.
4. **Роль исполнителя:** вся строка — кнопка: первая строка «Код», вторая — «Devin · swe-2-flash-medium · high» мелким серым, справа `›`; нажатие раскрывает тот же выбор модели, что и «Изменить». `?` остаётся отдельной кнопкой.
5. **Кнопки с аргументами:** если агент написал команду целиком в `code` (`` `/aif-fix refresh … passes` ``), чип берёт весь текст из code span (одна строка, до 300 символов). `id` остаётся голым. Один чип на `id`: вариант с аргументами важнее голого, из нескольких вариантов с аргументами берётся первый.
6. **Нажатие на чип с аргументами** при пустом поле подставляет команду и отправляет её, как обычный чип (правило «ждать текст» для `/aif-plan`, `/aif-fix`, `/aif-explore` действует только для голых команд). При непустом поле — заменяет первую строку, если она начинается с команды, иначе ставит команду первой строкой; не отправляет, ставит фокус.
7. **Чипы несуществующих команд скрываются** (кроме `suggested_next` из gate — он авторитетен и остаётся тусклым с причиной).
8. **Оценка выключена по умолчанию.** Включается в «Настройках» → «Оценка кнопок». Ключ: «Из Env Catalog» (храним только имя, значение читаем перед каждым запросом) или «Ввести вручную» (секретная настройка плагина). Если env-catalog не установлен — только ручной ввод.
9. **Оценка асинхронна:** RPC `suggestions` отдаёт чипы сразу; при 2+ доступных чипах сервер в фоне один раз на `sourceKey` + набор id спрашивает Decisions API (таймаут 15 с), кладёт результат в ограниченный кэш (200 записей) и публикует `changed`. Ошибка → чипы без процентов, причина в «Настройках».
10. **В Google уходит** только последний ответ агента (обрезанный до 20 000 символов) и описания команд-кандидатов. В журнал плагина не пишутся ни ключ, ни текст ответа: только `threadId`, имя ключа из каталога, число вариантов, результат.

## Requirements Reconciliation

Источники: Original Request (владелец) → проверенные факты выше → `rules/base.md`, `ARCHITECTURE.md`. Противоречий нет; правило `rules/base.md` «логгера нет» устарело относительно `bb.log` в `server.ts` — не меняем его здесь, сообщаем как WARN.

**Оценка кнопок: комбинации**

| Включено | Источник ключа | Состояние | Результат | Проверка |
|---|---|---|---|---|
| нет | любой | — | запросов в Google нет, процентов нет | тест: `fetch` не вызван |
| да | каталог | env-catalog есть, имя найдено, ключ верный | проценты на чипах, порядок по убыванию | тест с подменой `callRpc` и `fetch`; живой вызов в задаче 12 |
| да | каталог | env-catalog не установлен / имя не найдено | процентов нет, в настройках «ключ не найден в каталоге» | тест: `callRpc` бросает ошибку |
| да | вручную | ключ задан | как строка 2 | тест |
| да | вручную | ключ пуст | процентов нет, «ключ не задан» | тест |
| да | любой | Google ответил ошибкой / таймаут | процентов нет, причина в настройках, повтор не чаще раза на `sourceKey` | тест: `fetch` 403 |
| да | любой | доступных чипов < 2 | запроса нет | тест |

**Чип из ответа: комбинации**

| Команда в ответе | Тип команды | Поле ввода | Что делает нажатие | Проверка |
|---|---|---|---|---|
| голая `/aif-plan` | тема нужна | пусто | подставляет `/aif-plan `, не отправляет | существующий тест |
| `` `/aif-fix refresh x so y` `` | тема нужна | пусто | подставляет всю команду и отправляет | новый тест |
| `` `/aif-verify @plan.md` `` | обычная | текст без команды | команда первой строкой, текст сохранён, не отправляет | новый тест |
| `` `/aif-fix A` `` в черновике `/aif-fix B` | любая | начинается с команды | первая строка заменена на `/aif-fix A`, остальное сохранено | новый тест |
| `/aif-composer-mode` (нет такого навыка) | — | — | чипа нет | новый тест |

Реальный пример: ответ со скриншота владельца (`` `/aif-fix refresh src/rooms/sma-map/provenance.json via npx tsx scripts/sma-provenance.ts so npm run sma:facts:check passes on HEAD` ``) используется как фикстура в тестах разбора.

## Tasks

### Фаза 1. Панель как iOS-приложение

- [ ] Task 1: Поверхность и сгруппированные секции. В `components/aif/layout.tsx` добавить контекст поверхности (`SurfaceProvider`, `useSurface`: `'panel' | 'card'`, по умолчанию `'card'`). `Section` в панели: заголовок группы (`text-xs text-muted-foreground px-1`) над блоком `rounded-xl bg-card` без `border`, внутренние отступы 12–16 px; в карточке — без изменений. `WorkflowPanel` (`app.tsx` ~527) оборачивает содержимое в провайдер `panel`, ставит `@container/aif` на `.aif-panel`, отступ панели `px-3 py-3` вместо `p-4 pb-8` (низ — `pb-[max(1rem,env(safe-area-inset-bottom))]`). Во «В работе» (`app.tsx` ~429) и «Что проверить» (~194) в панели убрать вложенную рамку, оставить `divide-y`. Files: `components/aif/layout.tsx`, `app.tsx`. Логи: не нужны (UI без побочных эффектов).
- [ ] Task 2: Шапка. На узкой панели (`@max-md/aif`) переключатель «Навигация | Настройки» уходит второй строкой шапки на всю ширину, две равные половины, подписи `whitespace-nowrap`; на широкой — как сейчас в строке заголовка. Высота сегмента 32 px, точка «есть что проверить» внутри сегмента справа от подписи. Files: `app.tsx` (~133-150). Depends on 1.
- [ ] Task 3: Строки «Подготовки проекта» по решению 3. `ReadinessSection` (`app.tsx` ~464-520): строка `[статус] N. название [?] … [›]`; `›` — `Button variant="ghost" size="icon"` с `aria-label="Запустить: <label>"`, первая невыполненная — с акцентом (`text-primary`), те же условия `disabled`; нажатие на название (кнопка `aria-expanded`) раскрывает описание (`readinessHelp`) и «Пропустить» / «Вернуть» (через существующий `toggleSkip`). «Выполнено · N» остаётся свёрнутым списком в той же стилистике. Files: `app.tsx`. Depends on 1.
- [ ] Task 4: Строки «Исполнителей» по решению 4. `ModelChoice` (`app.tsx` ~282-360): вся строка — `button` (`aria-label="Изменить: <роль>"`, `aria-expanded`), две строки текста (роль; модель + уровень мелким серым, `truncate`), справа `ChevronRight` с поворотом при раскрытии; `?` — отдельная кнопка вне основной (не вложенная). Сохранить блокировку чужого агента и путь `setDelegation`. Убрать подпись навыков из строки (она есть под `?`). Files: `app.tsx`. Depends on 1.

### Фаза 2. Кнопки с аргументами

- [ ] Task 5: Разбор команд с аргументами. `suggestions.ts`: новая чистая функция разбора inline code span — если содержимое span начинается с `/aif-…`/`$aif-…`, однострочное и не длиннее 300 символов, команда = содержимое без внешних пробелов. `extractAifInvocations` возвращает `{ id, command }`, где `command` — полный текст для span-варианта; один элемент на `id`, вариант с аргументами важнее голого. `analyzeReply.commands` несёт полные команды; gate `next` по-прежнему голый. `chipDraft` по решению 6 (правило `TOPIC_COMMANDS` только для голых; замена первой строки при ведущей команде). Files: `suggestions.ts`. Depends on —.
- [ ] Task 6: Скрыть чипы несуществующих команд. `server.ts` `suggested()` (~238-260): элементы из ответа с `id` не из `snapshot.skills` (и не `aif-chat`) не попадают в `items`, кроме `id === next` из gate. Лог `aif-chat: suggestions threadId=… shown=N hiddenUnknown=M`. Files: `server.ts`. Depends on 5.

- [ ] Task 14: (запрос владельца 2026-11-19, выполняется сразу после задачи 1) пилюля режима не попадает в команды. Причина: BB передаёт текст пилюли агенту вместе с сообщением, и для `/aif-…` он становится аргументами навыка — виден в чате и путает разбор аргументов (`/aif-implement @AI Factory …`). Сделать: в `suggestions.ts` чистая `isCommandDraft(draft)` — текст без пилюль начинается с `/` или `$`; `chipDraft` больше не переносит пилюлю в черновик с командой (команды AI Factory и так читают `skill-context`). `AifPillController` (`app.tsx`): не вставлять пилюлю и не подтверждать флаг, пока черновик — команда; если в черновике команда и пилюля, убрать пилюлю (`removeAifPill`). Флаг остаётся до первого обычного сообщения. Тесты: `isCommandDraft`, `chipDraft` без пилюли, контроллер не вставляет пилюлю в черновик-команду и убирает её. Files: `suggestions.ts`, `app.tsx`, `tests/suggestions.test.ts`, `tests/aif-mode-app.test.ts`.

### Фаза 3. Оценка через Gemini Decisions

- [ ] Task 7: Доменный модуль `chip-scoring.ts` (чистый): `decisionsRequest(reply, candidates)` → тело запроса (`model: 'gemini-decision-1'`, `input` — ответ, обрезанный до 20 000 символов, вопрос `next` типа `choice`, `criteria`: `id` → «команда — описание из `actionDescriptions`/`id`»); `decisionsResponseSchema` (zod) и `probabilitiesFor(response, ids)` → `Record<id, number>`; `scoringKey(sourceKey, ids)`. Файл добавить в карту модулей `ARCHITECTURE.md` (домен). Files: `chip-scoring.ts`, `.ai-factory/ARCHITECTURE.md`. Depends on —.
- [ ] Task 8: Настройки оценки и ключ. `server.ts`: секретная настройка `decisionsKey` (`type: 'string', secret: true`); в `bb.storage.kv` ключ `chip-scoring` (`{ enabled: boolean, source: 'catalog' | 'manual', catalogName: string | null, lastError: string | null, lastScoredAt: number | null }`, схема в `model.ts`). RPC в `contract.ts`: `chipScoring` → `{ enabled, source, catalogName, catalogAvailable, catalogNames, manualKeySet, lastError, lastScoredAt }` (значение ключа никогда); `setChipScoring` → `{ enabled?, source?, catalogName?, manualKey?: string | null }`, внутри `serial('chip-scoring')`. Список имён: `callRpc({ pluginId: 'env-catalog', method: 'env_list', input: { kind: 'secret' } })` с `AbortSignal.timeout(5000)`, имена с `GEMINI` первыми; ошибка → `catalogAvailable: false`. Функция `resolveDecisionsKey()` — по источнику: `env_get_value` (5 с) или `settings.get().decisionsKey`. Логи: `aif-chat: chip scoring settings enabled=… source=…`, `aif-chat: decisions key read source=catalog name=<имя>` (без значения), `warn` с причиной при ошибке. Files: `server.ts`, `contract.ts`, `model.ts`. Depends on 7.
- [ ] Task 9: Фоновая оценка. `server.ts`: в `suggested()` при `enabled` и 2+ доступных элементах — если в кэше (`Map`, ≤200, вытеснение старейшего) есть `scoringKey`, проставить `probability` элементам; иначе запустить единственный на ключ фоновый `score()` (без ожидания): ключ → `fetch(DECISIONS_URL, { method: 'POST', headers: { 'x-goog-api-key', 'content-type' }, body, signal: AbortSignal.timeout(15000) })` → проверка `ok`, размер ≤ 1 MiB, `decisionsResponseSchema` → кэш → `bb.realtime.publish('changed', { threadId })`; при ошибке — кэшировать пустой результат для этого ключа (без повторов), записать `lastError`. В `model.ts` элементу чипа добавить `probability: z.number().min(0).max(1).nullable().default(null)`. Логи: `aif-chat: chips scored threadId=… options=N top=<id> ms=…`, `warn` `aif-chat: chip scoring failed threadId=…: <статус>`. Files: `server.ts`, `model.ts`. Depends on 8.
- [ ] Task 10: Интерфейс. Чипы (`app.tsx` ~528-595, `aif-chat.css`): если у элементов есть `probability`, сортировать по убыванию; слева в чипе квадратная метка `96%` (моно, `tabular-nums`), у самого вероятного — акцентная рамка; длинная команда в одну строку с многоточием (`max-width: 100%`, `text-overflow: ellipsis`), полный текст — в подсказке `Hint`. «Настройки» → новый `Section` «Оценка кнопок» после «Исполнителей»: переключатель «Вкл/Выкл», `?` с описанием (что уходит в Google), радиогруппа «Из Env Catalog / Ввести вручную» (первый вариант скрыт, если `catalogAvailable: false`), `select` имён каталога или поле пароля с «Сохранить» / «Удалить ключ», строка состояния («Ключ задан», «Последняя оценка: …», ошибка `Callout`). Хук по образцу `useDelegationView`. Files: `app.tsx`, `aif-chat.css`. Depends on 3, 4, 9.

### Фаза 4. Тесты, документация, выкатка

- [ ] Task 11: Тесты. `tests/suggestions.test.ts`: разбор span-команд (фикстура со скриншота владельца), приоритет варианта с аргументами, `chipDraft` для комбинаций из таблицы. `tests/chip-scoring.test.ts`: тело запроса, обрезка, разбор ответа, `probabilitiesFor`. `tests/chip-scoring-server.test.ts`: все строки таблицы «Оценка кнопок» с подменой `plugins.callRpc` и `globalThis.fetch` (вернуть оригинал в `finally`), в т.ч. что `fetch` не вызван при выключенной оценке и что ключ не попадает в RPC-ответ и логи. `tests/server.test.ts`: скрытие несуществующих команд. `tests/app.test.ts`: строки подготовки (запуск по `›`, «Пропустить» через раскрытие), роли (строка-кнопка), метки процентов и сортировка, блок «Оценка кнопок»; карточка в сообщении без изменений. Files: `tests/*`. Depends on 1-10.
- [ ] Task 12: Документация и версия. `README.md`, `docs/workflow.md` (раскладка панели, кнопки с аргументами, оценка: что уходит в Google, как выбрать ключ из Env Catalog), `skills/aif-chat/SKILL.md` (агенту: писать команды целиком в `code`), `CHANGELOG.md` 0.18.0, `package.json` / `package-lock.json` → 0.18.0, `.ai-factory/DESCRIPTION.md` (модуль `chip-scoring.ts`). Files: перечисленные. Depends on 11.
- [ ] Task 13: Выкатка и живые проверки (push только после явного «да» владельца): `npm test`, `npm run typecheck`, `npm run build`; коммит; `bb plugin update aif-chat --yes`. Живые проверки координатором: (а) RPC `chipScoring` у живого плагина возвращает имена из Env Catalog — подтверждает `callRpc` из плагина; (б) включить оценку с `GEMINI_API_KEY_AISTUDIO` в тестовом треде, дождаться метки процентов в RPC `suggestions`; (в) в журнале плагина нет значения ключа. Владелец проверяет на телефоне: шапку, строки подготовки и исполнителей, метки на чипах. Depends on 12.

## Commit Plan

1. После задач 1-12, одним коммитом: `feat: iOS-style panel, commands with arguments in chips, Gemini Decisions chip scoring` (deferred до завершения всех задач, включая документацию задачи 12).
