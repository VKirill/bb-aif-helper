# Контракт доказательств и форматы

## 1. Раскладка файлов

`/aif-scout` пишет только в `.ai-factory/scout/<slug>/` (файлы `RESEARCH.md` и `INDEX.md` принадлежат `/aif-explore`):

- `plan.yaml` — вопрос, режим, маршрут (`route`), глубина, `as_of`, список волн (`waves`), карта источников (`source_map`, после картирующей волны) и таблица углов. Контракт неизменен внутри волны; каждая узкая волна (`narrow`) фиксируется отдельным контрактом в `waves` до своего старта.
- `corpus/<angle>.yaml` — карточка находок каждого разведчика (следующие волны по тому же углу — `-w2`, `-w3` без затирания первой).
- `opportunities.yaml` — карточки идей и их приоритизация (только для режима `ideas`).
- `report.md` — итоговый синтез со счётчиком доступа и разделами `## Карта источников` (если была `map`-волна), `## Перекос`, `## Установлено`, противоречиями, `## Неизвестно`, `## Следующий шаг`.

## 2. Примеры YAML

Примеры показывают форму полей, а не настоящие находки: адреса и цитаты в них вымышлены. Описание маршрутов — в [routes.md](routes.md), проверки типов источников — в [sources.md](sources.md).

### `plan.yaml`

```yaml
question: "Ограничения stdio-транспорта MCP при падении дочернего сервера"
mode: dev
route: compare
depth: normal
as_of: 2026-11-24
waves:
  - wave: 1
    kind: map
    angles: [dev-map]
  - wave: 2
    kind: narrow
    angles: [dev-tracker, dev-skeptic]
source_map:  # заполняется после картирующей волны (map)
  - platform: "github.com/example-org/example-sdk"
    type: tracker
    lang: en
    why: "основные отчёты об ошибках и обсуждения транспорта"
    topics: ["обрыв stdio", "буферизация stderr", "различия ОС"]
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
wave: narrow
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
        author: "dev-user-1"
        community: "example-org/example-sdk"
        thread: "issues/1"
        quote: "stderr pipe closes before flush on abrupt exit"
    market_lang: en
    version_scope: ">=1.0 <1.5"
    segment: "разработчики локальных плагинов"  # необязательное; только при опоре на evidence
    journey_stage: implementation             # необязательное; из SCOUT_JOURNEY_STAGES
    contrast: "graceful-vs-sigkill"           # необязательное; связывает парные углы/запросы
    status: VERIFIED
    confidence: low  # один URL: потолок low (раздел 3)
    changes_decision: yes
    cannot_claim: "что потеря stderr воспроизводится при штатном завершении"
counter_evidence: []  # каждый элемент имеет те же поля, что и находка (id, claim, type, origin, evidence, status, confidence, changes_decision)
not_found:
  - "Опровержение по Windows Named Pipes: искал в issues SDK, открытых тредов нет"
injection_suspected: []
open_questions:
  - "Воспроизводится ли потеря при graceful shutdown через stdin EOF"
```

Поля `author` (ник или `unknown`), `community` (сабреддит, форум, канал, репозиторий) и `thread` (идентификатор или заголовок обсуждения) обязательны в каждом элементе `evidence`. Поля `segment`, `journey_stage` и `contrast` у находки необязательны; `segment` добавляется только при явном подтверждении в источниках.

### Карточка картирующей волны `corpus/<angle>.yaml` (`wave: map`)

Поля, общие с узкой карточкой (`scout`, `as_of`, `tools`, `queries_run`, `findings`, `not_found`, `injection_suspected`, `open_questions`), заполняются так же; к ним добавляются поля карты. Координатор переносит `source_map` из всех картирующих карточек в `plan.yaml`, а `candidate_questions` разбивает на направления узкой волны.

```yaml
scout: dev-map
wave: map
as_of: 2026-11-24
tools: [WebSearch, gh]
queries_run: 8
source_map:
  - platform: "github.com/example-org/example-sdk"
    type: tracker
    lang: en
    why: "основные отчёты об ошибках транспорта"
    topics: ["обрыв stdio", "буферизация stderr"]
terms: ["stdio transport", "child process crash", "stderr flush"]
user_types: ["авторы локальных плагинов", "интеграторы на Node.js"]
candidate_questions:
  - "Теряется ли stderr при SIGKILL на macOS и Windows"
findings: []
not_found: []
injection_suspected: []
open_questions: []
```

### `opportunities.yaml` (режим `ideas`)

```yaml
opportunities:
  - id: O1
    unmet_need: "Диагностика тихих падений stdio-процессов без пересборки клиента"
    user_context: "Разработчики интеграций на Node.js при отладке локальных плагинов"
    workaround_today: "Оборачивают запуск сервера в shell-скрипт с tee во временный лог"
    why_existing_misses_it: "Штатный SDK отбрасывает незакрытый stderr после обрыва pipe"
    evidence: [F101]
    counterpoints: []
    market: en
    severity: rare-critical
    confidence: med
    scores:
      evidence_strength: 3       # 0–5
      cross_signal_support: 2    # 0–5
      decision_impact: 4         # 0–5
      actionability: 4           # 0–5
      gap_relevance: 3           # 0–5
      uncertainty_penalty: 1     # 0–5
      bias_penalty: 1            # 0–5
    priority_tier: test_first
    next_check: "Проверить поведение в актуальном релизе SDK на macOS и Windows"
    status: draft
```

## Словари

У каждого словаря один дом — этот раздел. При запуске разведчика этот раздел копируется в бриф целиком.

- SCOUT_MODES: `dev`, `ideas`
- SCOUT_ROUTES: `scan`, `deep`, `compare`, `debug`, `intl`, `science`, `factcheck`, `trend`, `delta`
- SCOUT_DEPTHS: `quick`, `normal`, `deep`
- SCOUT_WAVES: `map`, `narrow`
- SCOUT_ROLES: `discovery`, `validation`, `constraint`, `measurement`
- SCOUT_CAPTURE: `full`, `excerpt`, `metadata_only`, `unavailable`
- SCOUT_STATUS: `VERIFIED`, `REPORTED`, `SNIPPET_ONLY`, `INFERRED`
- SCOUT_CONFIDENCE: `low`, `med`, `high`
- SCOUT_ORIGIN: `user`, `vendor`, `author`, `paper`, `unknown`
- SCOUT_FINDING_TYPES: `fact`, `opinion`, `pain`, `wish`, `workaround`, `metric`, `competitor-capability`
- SCOUT_JOURNEY_STAGES: `orientation`, `problem_recognition`, `education`, `shortlisting`, `comparison`, `trust_validation`, `purchase_decision`, `implementation`, `post_purchase`, `recovery`
- SCOUT_DECISION_IMPACT: `yes`, `no`, `unknown`
- SCOUT_SEVERITY: `rare-critical`, `frequent-background`, `unknown`
- SCOUT_COVERAGE: `covered`, `partially_covered`, `uncovered`, `contradictory`, `unknown`
- SCOUT_CONTRADICTION_TYPES: `context`, `segment`, `market`, `time`, `version`, `method`
- SCOUT_PRIORITY_TIERS: `must_cover`, `should_cover`, `test_first`, `monitor_only`

## 3. Уверенность, потолки и эхо-источники

- `high` — ≥ 3 независимых источника (разных авторов и сообществ), ≥ 1 первичный (`full` или `excerpt`), в окне свежести, нет значимых противоречий, искали опровержение.
- `med` — выполнена часть условий (например, 2 независимых источника или только вторичные с полным текстом).
- `low` — один источник, только мнения, устаревшие данные или открытое противоречие.
- **Недостаточно данных** — только сниппеты выдачи (`SNIPPET_ONLY` / `metadata_only`), paywall или пересказы одного первоисточника: `high`/`med` запрещены; либо `confidence: low` с `SNIPPET_ONLY`, либо перенос в `not_found`.
- **Потолок по слабому звену:** итог не выше минимального звена (достоверность текста, независимость источников, точность трактовки, свежесть). Единственный независимый URL, критическая концентрация на одном источнике или опора только на `SNIPPET_ONLY` ставит потолок `low`.
- **Эхо-источники:** один и тот же URL в нескольких находках, один тред под разными ссылками или пересказы одного первоисточника склеиваются и считаются за один источник.

## 4. Риск переноса, происхождение, лестница смысла и запретные фразы

- **Риск переноса:** различай три слоя — универсальный механизм, опыт конкретного пользователя и локализацию (право, платежи, язык, доступность, среда). У каждой находки фиксируй `market_lang` и `version_scope`. В `opportunities.yaml` значение `market: both` разрешено только при наличии находок с обоих рынков.
- **Происхождение (`origin`):** `user`, `vendor`, `author`, `paper`, `unknown` — рекомендации вендора или рекламные описания не заменяют пользовательский опыт.
- **Лестница смысла:** `observation` → `signal` → `inference` → `hypothesis` → `recommendation`. Дословная цитата (`quote`) хранится отдельно от перевода и пересказа; перевод и пересказ цитатой не считаются.
- **Запретные фразы без опоры** проверяются во всём отчёте (кроме дословных цитат в `quote` и разделов `## Неизвестно` / `not_found`):
  - «растёт / growing / усиливается / новый стандарт» — если пункт не ссылается на находки минимум с двумя разными `source_date` в сопоставимых периодах;
  - «никто не решает / nobody solves / у конкурентов нет / уникально на рынке» — без угла по конкурентам;
  - «пользователи хотят / users want» — без находок `type: wish` или `type: pain` (повторная покупка или обход сама по себе не доказывает спрос на конкретную функцию);
  - «основная боль / главная боль / main pain» — без опоры на корпус из независимых авторов и сообществ.

## 5. Аудит перекоса

Перед выводами и расстановкой приоритетов координатор проверяет перекос корпуса и выносит итог в раздел `## Перекос` в `report.md`:

- **Счёт по авторам и сообществам, а не по URL:** независимая повторяемость считается по уникальным `author` (исключая `unknown`) и уникальным `community` / `thread`. Десять ссылок на один и тот же спор или одного автора дают `1` независимый сигнал.
- **Один автор:** повторяющиеся сообщения одного участника (включая 1–2 активных авторов на нишевом форуме) не дают повторяемости и отмечаются как перекос выборки.
- **Риск концентрации:** один и тот же источник (URL, тред, домен или автор), встречающийся в 3 и более темах/возможностях, помечается как риск концентрации; опирающиеся только на него выводы понижаются по уверенности и приоритету.
- **Перекос типа сигналов:** если выборка состоит почти целиком из жалоб (без удачных кейсов и контрпримеров), только из похвалы или только из мнений авторов без практики, это фиксируется явно в `## Перекос`.

## 6. Приоритеты в `ideas` и ворота `must_cover`

Каждая возможность в `opportunities.yaml` оценивается по шкале `0–5`:
- положительные измерения: `evidence_strength`, `cross_signal_support`, `decision_impact`, `actionability`, `gap_relevance`;
- штрафы: `uncertainty_penalty`, `bias_penalty`.

Итоговый уровень `priority_tier` выбирается из `SCOUT_PRIORITY_TIERS` (`must_cover`, `should_cover`, `test_first`, `monitor_only`).

**Ворота `must_cover`:** статус `must_cover` разрешён только при выполнении всех пяти условий:
1. `evidence_strength >= 3`
2. `cross_signal_support >= 2`
3. `confidence` не ниже `med` (`med` или `high`)
4. `uncertainty_penalty <= 2` и `bias_penalty <= 2`
5. нет нерешённого критичного противоречия (`impact: high`)

**Защита от раздувания:**
- доля `must_cover` не превышает ~20% списка без явного обоснования;
- одинаковые наборы `evidence` не создают несколько отдельных тем `must_cover`;
- синонимичные и перекрывающиеся темы объединяются (или в отчёте даётся явная причина разделения);
- редкий, но критичный сигнал (`severity: rare-critical`: потеря данных, безопасность, необратимый отказ, юридический/финансовый блокер) может получить высокий приоритет (`should_cover`, `test_first` или `must_cover` при прохождении ворот), даже если упоминается редко: **частота упоминаний не равна важности**;
- если > 60% тем попали в `monitor_only`, это фиксируется в `report.md` как ограничение доказательной базы.

## 7. Покрытие спроса и противоречия

### Покрытие спроса

Каждый подвопрос или направление исследования получает статус из `SCOUT_COVERAGE`:

| Статус | Когда ставится |
|---|---|
| `covered` | Найдены достаточные и согласованные доказательства, дающие ответ |
| `partially_covered` | Закрыта только часть аспектов (один сегмент, устаревшая версия, только фрагменты) |
| `uncovered` | Целенаправленный поиск выполнен (`queries_run` / `not_found`), но ответа нет («пробел») |
| `contradictory` | Найдены значимые расходящиеся сигналы, требующие разделения по условиям |
| `unknown` | Поиск по этому подвопросу не выполнялся или источники недоступны |

Статус «пробел» (`uncovered`) ставится **только при наличии выполненного поиска**; без него пишется `unknown`.

### Противоречия

Расходящиеся находки не усредняются и фиксируются отдельной структурой в `report.md` (и при необходимости в карточках):

```yaml
contradictions:
  - a: F101
    b: F204
    difference_type: context  # context | segment | market | time | version | method
    impact: high              # low | med | high
    required_action: "Разделить рекомендации для локального запуска и контейнерной среды"
    resolved: false
```

Критичное нерешённое противоречие (`impact: high`, `resolved: false`) запрещает `must_cover` для затронутых тем до проверки человеком или снятия дополнительной волной.

## 8. Карточка научной работы

При использовании научных источников (маршрут `science` или научный угол в `dev`/`ideas`) для каждой ключевой работы заполняется карточка:

```yaml
research_card:
  url: https://arxiv.org/abs/0000.00000
  question: "Какой вопрос проверяло исследование"
  studied: "Что или кого изучали, в каких условиях"
  data: "Какие данные и какого объёма использованы"
  method: "Метод проверки и с чем сравнивали"
  result: "Основной измеренный результат"
  mechanism: "Предложенный механизм явления"
  does_not_prove: "Чего работа не доказывает и её ограничения"
  transfer: "Условия и риск переноса на целевую задачу/рынок"
  testable_implication: "Проверяемое следствие: какой практический шаг или метрику можно проверить"
```

- Если доступна только аннотация или метаданные (`excerpt` / `metadata_only`), **о методе, данных и детальных ограничениях не судить** (`method: unknown`, `confidence: low`).
- Научная работа объясняет механизм или границы применимости, но сама по себе не доказывает пользовательский или рыночный спрос.

## 9. 12 контрольных вопросов перед сильным выводом

Перед включением сильного утверждения или присвоением `high` / `must_cover` проверь:

1. Есть ли конкретная проверяемая ссылка?
2. Виден ли сам текст источника или только заголовок/сниппет?
3. Это дословная фраза пользователя, перевод или пересказ?
4. Сколько независимых авторов это подтверждают?
5. Есть ли подтверждение из других сообществ или типов источников?
6. Искали и найдены ли контрпримеры?
7. Не зависит ли вывод от другой страны, рынка или регуляторики?
8. Не относится ли источник к другой аудитории или сегменту?
9. Не является ли утверждение вендора или автора рекламным обещанием?
10. Есть ли данные для количественного вывода, а не только качественные упоминания?
11. Не перепутаны ли частота упоминаний и важность для решения?
12. Что конкретно изменит этот вывод в решении или плане действий?
