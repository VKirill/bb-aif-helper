# Совместимость с AI Factory 2.22

Проверено по [релизу 2.22.0](https://github.com/lee-to/ai-factory/releases/tag/2.22.0), commit `4723d0bbc3b2fae0306d9934545fdd2d193c9578`. Это описание адаптации BB AIF Helper; наличие metadata не подтверждает выполнение workflow.

## Изменения релиза и поддержка в плагине

- **Планы, коммиты и TDD.** Читаются точные токены `## Settings`, `Commit strategy:`, `Development methodology:` и `TDD granularity:`. Значения показаны рядом с прогрессом. Неоднозначные или отсутствующие значения остаются неизвестными. Плагин не переписывает план и не запускает коммиты автоматически.
- **Commit-задачи.** Строка `<!-- aif:task-kind:commit -->` перед чекбоксом помечает commit-boundary. При незавершённой commit-задаче общий `aif-commit` не предлагается, включая предложения из ответа агента: маршрут остаётся у `aif-implement` с его receipt/ownership-проверками. Для `incremental-at-end` и `single-commit` нет промежуточного предложения коммита до завершения рабочих задач.
- **Исходы задач.** Inline-маркеры `aif:task-outcome:skipped` и `aif:commit-outcome:skipped-no-op` больше не удаляют весь чекбокс из прогресса. Отмеченная пропущенная задача подписана отдельно от выполненной. Receipt JSON, примеры и комментарии не создают задачи; валидация receipt остаётся у владельца реализации.
- **Общие skills.** Поддерживаются зарегистрированные ссылки из `useSymlinks` / `skillSymlinks` в `.ai-factory.json`. Разрешён только фактический переход к одноимённому физическому skill в `.agents/skills/` того же проекта. Ссылки вне проекта, переадресации и ссылки в родительских каталогах остаются недоступными. Остальные артефакты по-прежнему читаются без symlink/junction-переходов.
- **Fix defaults.** Показываются `workflow.fix_mode` (`ask`, `now`, `plan`) и boolean `workflow.fix_patch`. Некорректные ключи независимо возвращаются к upstream defaults `ask` / `true` с примечанием. Кнопки не навязывают override-флаги; existing fix-план исполняет `aif-fix`.
- **Coupling.** В дополнительных проверках доступен явный `aif-review +coupling`. Начиная с 0.8.5 предложения сохраняют найденные аргументы команды, включая `+coupling` и plan-mode. Markdown-разметка не передаётся; нажатие отправляет только команду с аргументами без добавочного промпта. Обычный review с неизменными файлами не считается выполненным coupling-анализом и не блокирует его кнопку.
- **Quality setup.** Сохраняется отдельный read-only `aif-quality-setup audit` и отдельный `setup`. JS/TS, PHP, Python, Rust и смешанные проекты анализирует установленный skill; аудит не выдаётся за запуск lint/tests/build или PASS CI.
- **Worktree.** Добавлен необязательный `ai-factory worktree-check --json` только для текущего checkout. Нужен известный стабильный CLI 2.22+ в серии 2.x. Нажатие передаёт команду агенту; обычное чтение панели её не запускает. Отчёт статический, окружения не стартуют, runtime-изоляция не подтверждается.
- **Completion hook.** Читается только наличие `.ai-factory/completion-hook/approval.json`. Декларация остаётся UNKNOWN, а не PASS. В 2.22.0 адаптер ограничен Claude Code **2.1.318**, Linux/macOS. Плагин не включает hook и не запускает verifier. Команды `completion-hook status` нет; поддерживаются `enable`, `disable`, `run`, `inspect <receipt>`. Проверка receipt сама по себе не аутентифицирует evidence.
- **Devin.** Добавлен явный выбор проектных runtime `devin` и исторического `windsurf`. Используется зарегистрированный проектный `skillsDir`; обход домашнего каталога personal skills не добавлен.
- **Вопросы.** Новая runtime-aware доставка сохраняет обязательные вопросы и ранее данные ответы. Плагин продолжает блокировать кнопки при открытом interaction или запросе подтверждения; отсутствие специального question-tool не означает согласие.

## Обновление

Стандартные directory-пути `paths.plans`, `paths.qa` и `aifhub.openspec.root` принимаются с завершающим `/`, как в upstream config template. Нормализация разделителей не разрешает `..`, абсолютные пути или symlink-переходы артефактов.

Кнопки обновления сохраняют последовательность: CLI через его фактического владельца → `ai-factory update` в проекте → `ai-factory extension update` → сверка версий и файлов. Linked/source установки и пользовательские изменения сохраняются. Новый symlink-режим и completion hook не включаются автоматически.

Проверки версий остаются кэшированными на сутки; новая возможность не снимает этот лимит. Явное обслуживание инвалидирует локальный version-sample. Новые строки диагностики остаются необязательными и не заменяют project-required gates.

## Источники контрактов

- [Формат планов](https://github.com/lee-to/ai-factory/blob/2.22.0/skills/aif-plan/references/TASK-FORMAT.md)
- [Commit-boundary и receipt](https://github.com/lee-to/ai-factory/blob/2.22.0/skills/aif-implement/references/IMPLEMENT-COMMITS.md)
- [Общие skills](https://github.com/lee-to/ai-factory/blob/2.22.0/src/core/skill-symlinks.ts)
- [CLI](https://github.com/lee-to/ai-factory/blob/2.22.0/src/cli/index.ts)
- [Completion hook](https://github.com/lee-to/ai-factory/blob/2.22.0/src/core/completion-hook.ts)
