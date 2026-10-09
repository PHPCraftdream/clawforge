# Итог рефакторинга: этапы 0–7

Дата: 2026-10-09. Срез исходников: HEAD `00e7e7d`; исходные базы — `52d188d` (план этапов 0–6, §8) и `3762857` (план этапа 7, §6). Этапы 0–7 завершены в объявленном объёме; S4 закрывается по агрегату R4/R5: новых P0–P3 и RETURN нет, зарегистрированные отрицательные контроли удержаны. Копии решений заменены владельцами значений, затем явными связями frame/binder/content. Это остановка ограниченной приёмки, **не** доказательство отсутствия всех дефектов, универсального I12 или зелёного полного gate сегодня. [R5-A](review-2026-10-08-stage7-R5-A.md) прямо оставляет общую приёмку I12 INCOMPLETE: его новые выполненные границы HELD, но закон имеет записанные остатки; эта оговорка сохраняется при агрегировании, а не превращается в универсальный сертификат.

## Этапы и свидетельства

### 0. Страховка
- Эталоны help, MCP, completion, problem codes и отказов: `2cf876b`.
- Архитектурные храповики и merge gate: `908467d`; возможности отдельных случаев и снимок checkout: `e259d76`.
- Позднее S4 показал, что сам guard требует контролей на подключение в runner, не только unit-проверок снимка.

### 1. Доменные значения
- ImageRef и единое format для пина/пересоздания/отчёта: `2fead89`.
- Общий load/validate набора, отдельная integrity-ошибка и владельцы советов: `13680b1`.
- Один модуль длительностей: `6950e89`; R5-C проверил пин при успехе и двух откатах, паритет четырёх tree/artifact вариантов и четыре typed truncation-отказа.

### 2. Вход и контекст
- Версионное значение Invocation между процессами: `a7d027e`.
- Чистый resolver и выбор deployment/framework: `41caff4`; объявления checkout gate: `dcdc25c`.
- Исторические обходы рамки исправлялись в этапе 6; окончательный параметризованный frame входа — этап 7 S1.3 `46f64a2`.

### 3. Спецификация и конвейер
- Модель и общий parser: `ac2dc85`; executeCommand для console/MCP: `7c86174`.
- Перевод групп команд завершён `dc80216`, property sweep — `b4365f9`; план фиксирует 41 объявленную команду.
- HEAD: legacyCommands=0, три rawArgvPredicates=0, unsummarizedDescriptions=0; совместимый адаптер deployment-authored AppCommand намеренно остаётся.

### 4. Советы как данные
- Advice/renderer/errors/prose tokens: `3dd071a`; структурные next/nextSteps: `54321ff`.
- Перевод producer'ов: `87f5f96`, `9504843`, `acd1b14`; переписывание вывода удалено.
- HEAD: 6 TS-литералов в 5 файлах, все разрешённые; вне владельцев 0. Владение текстом само по себе не доказывает quoting и выбор цели.

### 5. Поверхности из спецификации
- Реестр: `98bdada`; completion table/interpreters: `c882012`; MCP summary: `94ecc5f`; docs table: `7d0abea`.
- Проза переводилась `f0272c5`, `e3ac1f7`, `2c911e7`; закрытие: `81694bd`.
- План фиксирует выбор табличного варианта по Windows p95 0,82–2,19 с (checkout), 1,11 с (installed), порог 0,5 с; повторный замер здесь не выполнялся.

### 6. Ревью по инвариантам
- Ревью обнаружило не только копии значений, но неявные связи: frame, action binding, локальные факты и unknown→empty.
- Семейства фиксировались, в частности, `1f2c96a`, `b94e163`, `209fb68`, `a65697b`, `aefc49e`, `8a20c48`; gate witness — `3762857`.
- Реестр сохраняет раунды 16–19; сама эта серия не заявляется двумя чистыми раундами. Её остатки стали основанием этапа 7, а не поводом бесконечно искать G/P3.

### 7. Связи и доказательная приёмка
- S0: fixture/stages `051aea2`, controls `f607fa1`, isolation `e080233`, независимые ожидания `7e0bd04`.
- S1: Frame `39b5da1`, resolver `46f64a2`, advice anchor `a48310d`, durable/remote frame `c75d778`/`1026c6b`, real-shell law `e54590b`.
- S2: selection `cbdc2df`, named binder `4698a48`, kinds `c38d98d`, prepared plan `9a07ded`, needs/gate `ecb4aa5`/`fdc835f`, stages `2b8f97e`, completion oracle `772ff6d`.
- S3: имена `474c2e8`, portable content `af86729`, tar owner `bf94d8b`, typed target-read `9c6d2a0`; S4 фиксы сведены ниже, R4/R5 отчёты — `4e659cf`/`00e7e7d`.

## Метрики этапов 0–6: полная таблица §8

«Было» и цели цитируются из [плана](refactor-plan-2026-10-01.md) §8; старые базы заново не запускались. A — собственный HEAD-прогон `node --experimental-strip-types tools/checks/architecture/architecture.check.ts`, exit 0. B1–B5 — дословные команды приложения Б ниже. Эквиваленты помечены: их знаменатели не подменяют исторический счётчик.

| Метрика | Было 52d188d | Цель | Сейчас HEAD | Команда / свидетельство пересчёта |
| --- | --- | --- | --- | --- |
| `./clawforge` в framework | 461 / 97 файлов | 0 вне владельцев | 6 / 5 файлов; вне exemptions 0 | B1/B2; A dotClawforgeLiterals 0, total 6 |
| infoRaw / reportErrorVerbatim / localizeHints | 7 / 3 / 5 | 0 | 0 / 0 / 0 | B3; определения отсутствуют, вычитать нечего |
| Предикаты сырых argv | 28 | 0 | 0 / 0 / 0 | A rawArgvPredicates; **не** rawArgvScans |
| Эвристически обрезаемые MCP descriptions | 61 из 183 | 0 | unsummarizedDescriptions 0; declaredArguments 184 | A, эквивалент по декларациям и retiredSymbols=0; не счётчик длины прежнего description |
| Реализации решения completion | 3 | 1 | 1 семантический владелец; shell interpreters остаются | Структурный эквивалент: `rg -n 'completionCandidates' tools/framework/integration/completion/table.ts`; `c882012`, `772ff6d`, R5-B completion ledger |
| Конвейеры команды | 2 | 1 | 1 общий конвейер console/MCP | Структурный эквивалент: `rg -n 'executeCommand' tools/framework/core/command/execute.ts`; `7c86174`, R5-B; gate также executeBody, не независимая семантика |
| Модули, решающие режим | 5 | 1 чистая функция | 1 | A modeDeciders, параметризованный resolver `46f64a2` |
| Строковые операции образа вне owner | 34 строки / 10 файлов, 11 проза | 0 кодовых | 0 неразрешённых; total 4 exempt; грубый grep 11 | A imageStringOps — честный кодовый эквивалент; B4 не отделяет прозу |
| Грамматики длительности | 3 | 1 модуль | 1 owner с явными режимами | Структурный эквивалент: `rg -n 'parseInterval' tools/framework/core/values/durations.ts`; `6950e89`; число всех функций parser не измерено (иная метрика) |
| Проверки с прозой | около 846 / 144 из 226 файлов | ≤ половины базы | B5 417 строк; A prosePins 426, proseMatchers 108, proseEquality 216, proseHeld 142, proseHeldFlow 1189 | B5 — прежняя regex; A — расширенные, несуммируемые измерения. Историческая цель prosePins ≤427 соблюдена; flow с иной моделью не сравнивается с 846 |
| Ручные списки gate / failure-order | 2 | 0 | 0 старых списков (структурный эквивалент) | `dcdc25c`, `b4365f9`; A retiredSymbols=0, declaration-derived property sweep; полный поиск любых будущих ручных списков не измерено |
| Находки A–F за раунд | 7–11 | ≤1; P2=0 два подряд | R4/R5: всего новых находок 0, P2=0, RETURN=0 | Все шесть R4/R5 отчётов + registry; A–G в S4 не назначены, поэтому 0 — следствие пустых findings, не новая классификация |

Команды B из корня checkout (POSIX-shell):

```bash
# B1, B2
 git grep -o -F './clawforge' -- 'tools/framework/*.ts' ':!tools/framework/dist' | wc -l
 git grep -l -F './clawforge' -- 'tools/framework/*.ts' ':!tools/framework/dist' | wc -l
# B3, отдельно для каждого символа
 git grep -o -F 'infoRaw(' -- 'tools/framework/*.ts' ':!tools/framework/dist' | wc -l
 git grep -o -F 'reportErrorVerbatim(' -- 'tools/framework/*.ts' ':!tools/framework/dist' | wc -l
 git grep -o -F 'localizeHints(' -- 'tools/framework/*.ts' ':!tools/framework/dist' | wc -l
# B4
 git grep -nE '@sha256|split\("@"\)|indexOf\("@"\)|lastIndexOf\(":"\)' -- 'tools/framework/*.ts' ':!tools/framework/dist' ':!tools/framework/runtime/docker/image-ref.ts' | wc -l
# B5
 git grep -E 'includes\((`|")[^"`]* [^"`]*(`|")\)' -- 'tools/checks/*.ts' | wc -l
```

## Все десять метрик этапа 7 §6

База/цели — [план этапа 7](refactor-plan-stage7-2026-10-06.md) §6. [R5-C](review-2026-10-08-stage7-R5-C.md) §§«All ten plan §6 metrics», «Parent verification» — выполненное свидетельство на `4e659cf`; HEAD после него добавил только отчёты. Здесь собственные дешёвые пересчёты не выдаются за повтор приёмочных прогонов.

| Метрика | Было (`3762857`) | Цель | Сейчас (HEAD) | Как измерено (command) |
| --- | --- | --- | --- | --- |
| Mode deciders | 3 | 1 | 1 | Собственный A: `node --experimental-strip-types tools/checks/architecture/architecture.check.ts`, modeDeciders |
| invocation/currentFrame reads вне owner | entry/scaffold | 0 | frameReads 0 | Собственный A (команда выше), frameReads |
| Program decisions by spelling | 1+ | 0 | 0 в объявленном scan; retiredSymbols 0; regex-граница, не универсальный поиск строковых эвристик | R5-C metrics.mts scan (§«All ten plan §6 metrics»); собственный A, retiredSymbols |
| Action selection вне core/command | 2 validate/toArgv | 0 | actionSelectionOutsideCore 0 | Собственный A, actionSelectionOutsideCore |
| Аргументы без value kind | все кроме parse/choices | 0 | untypedValueArguments 0; declaredArguments 184 | Собственный A, untypedValueArguments/declaredArguments |
| Допустимые sweep controls до run | 0 | 100% | 76/76; parse737/prepare2/run76, всего815; здесь не измерено повторно (docs-only) | R5-C: `node --experimental-strip-types tools/checks/foundation/core/command/pipeline/property/property.check.ts`, metrics.mts count |
| Отрицательные контроли | 0 объявлено | все | 144 уникальных объявлений; 144/144 edited exit1/runner0 по отчёту, исполнение здесь не повторялось | Собственный импорт CONTROLS (точная команда ниже); R5-C all-registry `node --experimental-strip-types tools/checks/controls/run-controls.ts`, полный список ID в отчёте |
| Catch-all target reads | ≥1 | 0 неразрешённых | 100 файлов, 21 catches/21 reasoned exceptions, 0 неразрешённых; 0 stale по отчёту | Собственный `node --experimental-strip-types tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts`; R5-C metric8 |
| Проверки, пишущие checkout | ≥1 | 0 | 330 scanned/338 found, 0 anchored/0 unbound/0 unisolated/0 allows, UNKNOWN426; по отчёту 0 observed suite writes, 3/3 temp writers rejected; универсальный ноль не доказан | Собственный `node --experimental-strip-types tools/checks/foundation/hygiene/static/write-isolation.check.ts`; R5-C metric9 и runtime witnesses |
| RETURN за раунд | — | 0 два полноценных подряд | R4=0, R5=0; scoped acceptance, не универсальный I12 | Findings/RETURN A/B/C R4/R5 и реестр S4; документарная сверка, не runtime-команда |

Собственные дополнительные команды (exit 0):

```bash
node --experimental-strip-types tools/checks/foundation/hygiene/static/transport-read-swallow.check.ts
node --experimental-strip-types tools/checks/foundation/hygiene/static/write-isolation.check.ts
node --experimental-strip-types --input-type=module -e 'import {CONTROLS} from "./tools/checks/controls/controls.ts"; console.log("Registered controls",CONTROLS.length,new Set(CONTROLS.map(x=>x.id)).size)'
```

Реальное расположение 144 контролей: `tools/checks/controls/controls.ts` агрегирует `stage7.ts` и `stage7-accept.ts` в том же каталоге; исполняет `tools/checks/controls/run-controls.ts`. Это не 144 новых тестовых файлов. R5-C содержит все ID, named assertions, exits и manifest; повторные/пересекающиеся подборки A/B/C не суммируются.

## S4: раунды, исправления и остановка

Источники: **все** `review-2026-10-08-stage7-R{1,2,3,4,5}-{A,B,C}.md`, [реестр](review-findings-registry.md) S4. В ячейках A/B/C: P0/P1/P2/P3; N/R — NEW/RETURN. Не размеченные N/R четыре P3 R2 не объявлены автоматически NEW.

| Раунд | A: severity; N/R | B: severity; N/R | C: severity; N/R | Исходных findings; N/R/без метки | Вердикт |
| --- | --- | --- | --- | --- | --- |
| R1 | 0/0/1/0; 1/0 | 0/0/0/0; 0/0 | 0/1/2/0; 0/3 | 4; 1/3/0 | не чистый |
| R2 | 0/0/2/0; 1/1 | 0/0/3/1; 1/2 | 0/0/4/3; 1/3 | 13; 3/6/4 | не чистый |
| R3 | 0/0/2/0; 2/0 | 0/0/0/1; 1/0 | 0/0/3/0; 0/3 | 6; 3/3/0 | не чистый |
| R4 | 0/0/0/0; 0/0 | 0/0/0/0; 0/0 | 0/0/0/0; 0/0 | 0; 0/0/0 | чистый; первый подряд |
| R5 | 0/0/0/0; 0/0 | 0/0/0/0; 0/0 | 0/0/0/0; 0/0 | 0; 0/0/0 | чистый; второй подряд - правило остановки §5 выполнено |

После дедупликации R2 содержит 11 механизмов, P2=7/P3=4; общий S4 итог 21 механизм (P0=0/P1=1/P2=15/P3=5), исходных findings 23 (P2=17). RETURN по исходным ID: R1=3/R2=6/R3=3/R4=0/R5=0. Исправление не делает R1–R3 чистыми задним числом. Закрытие — агрегат выполненных областей и controls, с явно принятыми остатками; R5-A не утверждает полноценного универсального I12 и сам не выдаёт глобальное stop-свидетельство.

| Семейство | Исправляющие SHA из git log | Что удержано / предел |
| --- | --- | --- |
| Shell quoting, native PowerShell handoff, cross-app selector, checkout-only runnable advice | `b036090`, `722c1cb`, `5df2338` | R1-A/R2-A/R3-A; R3-A-2 оказался передачей bash -c в пробе, не новым продуктовым фиксом |
| Parse control characters, scheduler fixture и env-read accounting | `0f923c3` | R2-B; четыре scheduler controls достигают sentinel в R3 |
| Write scanner и destructive cleanup | `6260a82`, `d53f266`, `81ecc51` | R1-C → R3-C; static exotic aliases остаются approximation |
| Content snapshot, runner wiring, readability и index bits | `6260a82`, `fc9ec16`, `e763f28`, `81ecc51` | Dirty/untracked/ignored content, mode/readability, git-bit independence; время ignored-файла не доказано повторно |
| Prose flow и scanner self-check environment | `fc9ec16`, `e763f28`, `81ecc51` | 1160→1189 — разрешённое расширение модели, не рост допустимой прозы |
| Strict outgoing MCP nextSteps | `c9547bc` | R3-B-1: общий binder; unbindable remedy не получает machine step |

## Принятые пределы и старые хвосты

- Статические write-isolation, proseHeldFlow и rawArgvScans — модели, не AST/runtime-доказательство. rawArgvScans: 34 total, 0 вне reasoned exemptions; writeTargetsUnresolved **426**, shrink-only, UNKNOWN не CLEAN. I10 держит runtime checkout snapshot в `tools/checks/kit/run.ts`: content/mode/readability tracked/untracked/ignored независимо от index bits. Он обнаруживает изменение после исполнения, но не предотвращает уже совершённую запись.
- `81ecc51` и baseline.json обосновывают proseHeldFlow **1160→1189**: 6 восстановленных evasive comparisons + 23 вновь видимых sites. R4-C и R5-C проверили реальный рост 1189→1190 с exit1; optional mutation/computed keys остаются accepted P3 по backlog, не обещание полной модели.
- PowerShell 7 не выполнен; Windows PowerShell 5.1 не заменяет его свидетельство. cmd `%` expansion — принятый предел. Docker/доступный SSH/packaged release здесь не проверялись. R5-C actual unreachable MCP stdio отказал на startup: выполнение запроса не установлено, in-process parity отдельно.
- Старые stage7-tail residuals из R2-C «Not re-reported», подтверждённые перечнями R4-C/R5-B/R5-C: reversed binder comparison rows; completion note-placement prefix; C126 hard-coded invocation; неполная durable-frame proof; deploy/arguments refusal hint без самостоятельной byte assertion; два неучтённых `.env` reader'а. Новые проверки accounting не объявляются доказательством закрытия этих двух читателей.
- `parseEnv` строки без `=` — owner decision (reject/warn/keep), не разрешено этим docs-only итогом. **441** recorded frame-law keys (`baseline.frameLawViolations`) — принятые остатки, A подтверждает их число, не HELD каждого ключа. Старый backlog содержит исторические строки, перекрытые S0/S2; его не следует читать как новый HEAD-ноль/новую открывающую находку.
- [backlog-p3.md](backlog-p3.md) также сохраняет legacy adapter/name compatibility, tree apply без validate gate, UTF-8 capture loss, completion только built-ins, retained set-try без teardown и accepted scanner approximations; здесь не исправлялись и не пересчитывались как новые findings.

## Уроки

- Severity калибруется наблюдаемым ущербом: реальное удаление данных при runner0 — P1; bypass обеих охран — P2; обход одной статической approximation при работающем runtime guard не автоматически P2.
- Для I10 нужен content snapshot, а не чистый porcelain; git index bits не имеют права скрывать байты оператора.
- Отрицательный контроль обязан падать на именованном assertion после зелёной baseline; timeout/setup failure не является HELD. Число пройденных controls не отменило новые R3-C обходы.
- Проверка подключения guard/capabilities в runner необходима отдельно: direct-file verification пропустила runner failures R2-C-3.
- Инфраструктурный scope creep требует соседних проверок: `81ecc51` затронул kit/spawn.ts (child deadline 45000→60000 ms), `b036090`/`e763f28` — controls/run-controls.ts (diagnostics/edited exit). [Checkpoint 2026-10-08-0834](../checkpoints/2026-10-08-0834.md) фиксирует, что lint/layout/typecheck/capability self-check/template failures нашли лишь собственным полным gate после чужого «all green». Для утверждения, что **именно** проблемы этих двух файлов поймал только gate, отдельного ledger в прочитанных источниках нет — не измерено. Не выдавать прямой запуск файла за runner/gate-проверку.
- Cwd — часть контракта проверки и pasted advice; отчёты сохраняют cwd/argv/child exit. Успех из другого корня или ошибки native handoff пробы нельзя переносить на исходный сценарий.
- Остановка относится к согласованной области и известным пределам, не к бесконечному расширению edge cases; новые G/P3 идут отдельно, остаточная неполнота явно записывается.

## Приложение: дополнение списка SHA этапа 7

Сверка: `git log --reverse --format='%h %s' 3762857..HEAD`, отбор строк subject с `stage 7` или `S4`: 45 коммитов. В тексте выше уже названы 35 уникальных SHA; ниже остальные 10, с дословными subject. Группы следуют только явным обозначениям в subject; общие проекты не приписаны вымышленному срезу. Отбор по subject не претендует на классификацию всех немаркированных подготовительных/хвостовых коммитов.

### Общий план и решения
- `0cdea4d` — docs(plan): stage 7 plan — execution frame, one binder with prepared plans, portable set content, and evidence-bearing checks
- `ed596c2` — docs(design): stage 7 owner decisions for O1–O7 and Q1–Q9 (by @om) and plan section 8
- `150623a` — docs(design): align the stage 7 frame and binder designs with the owner decisions (O1–O7, Q1–Q9, N1–N3) and annotate backlog rows

### S1
- `0a52699` — docs(design): stage 7 S1 execution frame design (draft for owner decisions O1–O7)
- `cf02307` — refactor(invocation): hints spelled relative to the paste directory, absolute outside the launch root (stage 7 S1.2b)

### S2
- `28af5f5` — docs(design): stage 7 S2 binder and prepared plan design (draft for owner decisions Q1–Q9)

### S4: отчёты приёмки
- `193033a` — docs(review): stage 7 acceptance round 1 (R1-A, R1-B, R1-C)
- `4a6911b` — docs(review): stage 7 acceptance round 2 (R2-B, R2-C)
- `0827d68` — docs(review): stage 7 acceptance round 2 (R2-A)
- `b201025` — docs(review): stage 7 acceptance round 3 (R3-A, R3-B, R3-C)

## Состояние репозитория и что не сделано

Read-only команды: `git log -1 --format='%h %s'`, `git rev-parse --short origin/main`, `git merge-base --is-ancestor 5df2338 origin/main`, `git log origin/main..HEAD --oneline`, `git log --format='%h %s' 52d188d..3762857`, `git show 81ecc51 --format=fuller --stat`. Наблюдаемая локальная tracking ref **origin/main=5df2338**, ancestor exit0; после неё ровно четыре локальных коммита: `81ecc51`, `88b72c8`, `4e659cf`, `00e7e7d`. Всё по `5df2338` включительно достижимо из origin/main. Fetch не выполнялся: реальное текущее состояние сервера не измерено. Push следующих коммитов — решение владельца; этот итог ещё не закоммичен.

Изменения ограничены docs/internal и CHANGELOG; git writes, installations/node_modules writes и full gate не выполнялись при составлении черновика (полный gate запускается оператором перед коммитом). Собственные recounts — только перечисленные дешёвые команды; controls/runtime/shell acceptance цитируются из отчётов, не объявляются повторёнными. Финальная обязательная проверка: `node --experimental-strip-types tools/checks/foundation/hygiene/docs-private-content.check.ts` — exit 0, 148 markdown-файлов; `git diff --check` — exit 0.
