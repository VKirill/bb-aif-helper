# Контракт доказательств и форматы

## 1. Раскладка файлов

`/aif-scout` пишет только в `.ai-factory/scout/<slug>/` (файлы `RESEARCH.md` и `INDEX.md` принадлежат `/aif-explore`):

- `plan.yaml` — вопрос, режим, глубина, `as_of` и таблица углов (контракт исследования; после старта волны не меняется).
- `corpus/<angle>.yaml` — карточка находок каждого разведчика (по одной на угол).
- `opportunities.yaml` — карточки идей (только для режима `ideas`).
- `report.md` — итоговый синтез со счётчиком доступа и разделами `## Установлено`, `## Неизвестно`, `## Следующий шаг`.

## 2. Примеры YAML

Примеры показывают форму полей, а не настоящие находки: адреса и цитаты в них вымышлены.

### `plan.yaml`

```yaml
question: "Ограничения stdio-транспорта MCP при падении дочернего сервера"
mode: dev
depth: normal
as_of: 2026-11-24
angles:
  - id: dev-tracker
    role: discovery
    hypothesis: "При падении MCP-сервера по stdio теряются буферизованные сообщения stderr"
    required: true
    market: en
  - id: dev-skeptic
    role: constraint
    hypothesis: "Проблема зависит от ОС и буферизации Node.js, а не от спецификации MCP"
    mirror_of: dev-tracker
    required: true
```

### Карточка разведчика 1 `corpus/<angle>.yaml`

```yaml
scout: dev-tracker
as_of: 2026-11-24
tools: [gh, WebFetch]
queries_run: 5
findings:
  - id: F101
    claim: "При SIGKILL дочернего процесса буфер stderr в Node.js может не дойти до родителя"
    type: fact
    origin: vendor
    evidence:
      - url: https://github.com/example-org/example-sdk/issues/1
        capture: full
        source_date: 2026-09-02
        quote: "stderr pipe closes before flush on abrupt exit"
    market_lang: en
    version_scope: ">=1.0 <1.5"
    status: VERIFIED
    confidence: low  # один URL: потолок low (раздел 3)
    changes_decision: yes
    cannot_claim: "что потеря stderr воспроизводится при штатном завершении"
counter_evidence: []  # each item has the same fields as a finding (id, claim, type, origin, evidence, status, confidence, changes_decision)
not_found:
  - "Опровержение по Windows Named Pipes: искал в issues SDK, открытых тредов нет"
injection_suspected: []
open_questions:
  - "Воспроизводится ли потеря при graceful shutdown через stdin EOF"
```

### `opportunities.yaml` (режим `ideas`)

```yaml
opportunities:
  - id: O1
    unmet_need: "Диагностика тихих падений stdio-процессов без пересборки клиента"
    user_context: "Разработчики интеграций на Node.js при отладке локальных плагинов"
    workaround_today: "Оборачивают запуск сервера в shell-скрипт с tee в временный лог"
    why_existing_misses_it: "Штатный SDK отбрасывает незакрытый stderr после обрыва pipe"
    evidence: [F101]
    counterpoints: []
    market: en
    severity: rare-critical
    next_check: "Проверить поведение в актуальном релизе SDK на macOS и Windows"
    status: draft
```

## Словари

- SCOUT_MODES: `dev`, `ideas`
- SCOUT_DEPTHS: `quick`, `normal`, `deep`
- SCOUT_ROLES: `discovery`, `validation`, `constraint`, `measurement`
- SCOUT_CAPTURE: `full`, `excerpt`, `metadata_only`, `unavailable`
- SCOUT_STATUS: `VERIFIED`, `REPORTED`, `SNIPPET_ONLY`, `INFERRED`
- SCOUT_CONFIDENCE: `low`, `med`, `high`
- SCOUT_ORIGIN: `user`, `vendor`, `author`, `paper`, `unknown`
- SCOUT_FINDING_TYPES: `fact`, `opinion`, `pain`, `wish`, `workaround`, `metric`, `competitor-capability`
- SCOUT_DECISION_IMPACT: `yes`, `no`, `unknown`
- SCOUT_SEVERITY: `rare-critical`, `frequent-background`, `unknown`

## 3. Уверенность, потолки и эхо-источники

- `high` — ≥ 3 независимых источника, ≥ 1 первичный (`full` или `excerpt`), в окне свежести, нет значимых противоречий, искали опровержение.
- `med` — выполнена часть условий (например, 2 источника или только вторичные с полным текстом).
- `low` — один источник, только мнения, устаревшие данные или открытое противоречие.
- **Недостаточно данных** — только сниппеты выдачи (`SNIPPET_ONLY` / `metadata_only`), paywall, или пересказы одного первоисточника: `high`/`med` запрещены; либо `confidence: low` с `SNIPPET_ONLY`, либо перенос в `not_found`.
- **Потолок по слабому звену** (`RM:3062-3081`, `SF:691-731`): итог не выше минимального звена. Единственный независимый URL или опора только на `SNIPPET_ONLY` ставит потолок `low`.
- **Эхо-источники:** один и тот же URL в нескольких находках или пересказы одного первоисточника склеиваются и считаются за один источник.

## 4. Риск переноса, происхождение, лестница смысла и запретные фразы

- **Риск переноса** (`SG:320-383`, `MS:21-56`): различай три слоя — универсальный механизм, опыт конкретного пользователя и локализацию (право, платежи, язык, доступность). У каждой находки фиксируй `market_lang` и `version_scope`. В `opportunities.yaml` значение `market: both` разрешено только при наличии находок с обоих рынков.
- **Происхождение (`origin`):** `user`, `vendor`, `author`, `paper`, `unknown` — рекомендации вендора/документации не заменяют пользовательский опыт (`SG:267`).
- **Лестница смысла** (`RM:374-417`): `observation` → `signal` → `inference` → `hypothesis` → `recommendation`. Дословная цитата (`quote`) хранится отдельно от перевода и пересказа (`RM:2317-2322`).
- **Запретные фразы без входа** (`RM:475-500`) проверяются во всём отчёте, кроме разделов `
  - «растёт / growing» — если пункт не ссылается на находки минимум с двумя разными `source_date`;
  - «никто не решает / nobody solves / у конкурентов нет» — без угла по конкурентам;
  - «пользователи хотят / users want» — без находок `type: wish` или `type: pain`;
  - «основная боль / main pain» — без опоры на корпус.
