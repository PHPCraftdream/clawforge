# Реестр находок ревью

Назначение: единый реестр доказанных механизмов дефектов раундов 16–19 и приёмки этапа 7 (S4), раундов 1–3.
Одна строка соответствует одному механизму, а не числу обнаруживших его ревьюеров.
Классы A–G и серьёзность сохраняются из отчётов; неизвестные классы не выводятся из инвариантов.
«Выполнено» означает, что ревьюер воспроизвёл поведение CLI/MCP/проверками.
«Статически» означает только чтение кода; это не считается доказательством удержания.
«Фаза не достигнута» отмечает проверку, которая не дошла до охраняемой фазы.
Неизвестные по источникам поля обозначены «—».
Отрицательный контроль указан, когда он следует из источников; для раундов 16–19 иначе — «нет — S0.3», для S4 — «нет».

Раунды 1–15 здесь не перечисляются: исправленные находки зафиксированы в сообщениях коммитов, CHANGELOG и `docs/internal/review-convergence-after-refactor-2026-10-06.md` §4. Реестр начинается с раунда 16.

## Раунд 16

| ID | База SHA | Класс | Сев. | Механизм (одна строка на причину) | Repro (кратко) | Инвариант | Чинится | Отрицательный контроль | Статус проверки |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R16-01 | a841c16 | E | P2 | `defaultInvocation` не различал checkout и локальный пакет, поэтому выдавал для checkout несуществующую команду `node_modules\\.bin\\clawforge` / `./clawforge` | запустить `entry/bin.ts pull --bogus` из `apps/<name>` | I3 | 1f2c96a | `invocation-hints.check.ts`: checkout + delegated hand-over | выполнено (@ox A) |
| R16-02 | a841c16 | G | P2 | При захвате вывода `host` терял stderr успешного дочернего процесса | `host target -- sh -c "echo OUT; echo ERR >&2"` | — | 1f2c96a | host check: зафиксировать stdout и stderr при exit 0 | выполнено (@ox A) |
| R16-03 | a841c16 | G | P3 | Развёртывание могло объявить зарезервированную dispatcher-команду; тогда его обычные команды отказывали при dispatch | app с командой `help`, затем `--app demo status` | I4 | 1f2c96a | defineApp reserved-name refusal | выполнено (@ox B) |
| R16-04 | a841c16 | G | P3 | Транспорт создавался eagerly в Context, из-за чего локальные команды могли отказать до run при неподдерживаемом `OC_TARGET_LOCATION=local` | `mcp-setup --client claude` с `OC_TARGET_LOCATION=local` | I5, I6 | 1f2c96a (не исправлено; backlog-p3) | нет — S0.3 | выполнено (@ox B) |
| R16-05 | a841c16 | A | P3 | `pull` (и push/backup) брал блокировку операции раньше `requireBootstrapped`: ненастроенное развёртывание получало ошибку блокировки вместо отказа «never been bootstrapped → bootstrap» | `pull` на ненастроенном развёртывании | I1, I5 | 1f2c96a (`pull` вызывает `requireBootstrapped` до блокировки; `push` намеренно без охраны — создаёт экземпляр) | requires-bootstrapped.check: GuardCases pull | выполнено (@ox B) |

## Раунд 17

| ID | База SHA | Класс | Сев. | Механизм (одна строка на причину) | Repro (кратко) | Инвариант | Чинится | Отрицательный контроль | Статус проверки |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R17-01 | 1f2c96a | A | P3 | Отказ init-in-checkout смешивал рамку указания и написание первой команды | отказ checkout-init: строка «from checkout root» и совет от cwd | I1 | b94e163; follow-up 209fb68 | `entryDecisionRefusals` / advice-matrix: одна spelling на place-naming refusal | выполнено (@ox A) |
| R17-02 | 1f2c96a | B | P3 | Отказ choices для gate-команды звучал по-разному в console и MCP | `completion tcsh` на CLI против MCP validate | I6 | b94e163 | сравнение console/MCP отказа choices | выполнено (@ox B) |
| R17-03 | 1f2c96a | B | P3 | Заголовок ошибки обёрнутой команды печатал argv без корректного quoting | воспроизведение из отчёта не указано | I2 | b94e163; follow-up 209fb68 | renderArguments / golden refusal matrix | выполнено (@ox A) |
| R17-04 | 1f2c96a | G | P3 | `set-try.ts` содержал недостижимую ветвь `report === undefined` | статически: assignment sites rethrow или устанавливают report | — | b94e163 | нет — S0.3 | статически (@ox C) |

## Раунд 18

| ID | База SHA | Класс | Сев. | Механизм (одна строка на причину) | Repro (кратко) | Инвариант | Чинится | Отрицательный контроль | Статус проверки |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | R18-01 | 209fb68 | A+F | P3 | Отказы в checkout печатают один и тот же ряд `./clawforge` дважды или только bash-шим; у пользователя cmd/pwsh нет рабочей строки (регрессия 209fb68) | `resolveInstalledEntry` init-в-checkout под `clawforge` / `clawforge.cmd` | I1, I12 | 8a20c48; полностью — S1 | S1.6: закон render→resolve | выполнено (@ox A, B, C); S1.6 (второй проход): строгий закон — 1612→441 остаточных механизмов записано в baseline.frameLawViolations (вербатим-резолюция и отказ=провал возвращены; full case set), real-shell вставки bash/cmd/pwsh, контроли C30/C181/C183–C187 held |  
  | R18-02 | 209fb68 | A | P3 | Соседние предложения «at the checkout root» в integration/gate.ts пишут `commandLine` из cwd (`../clawforge`) | replay bin.ts из `<checkout>/docs` с копией checkout | I1, I12 | 8a20c48 | S1.6 | выполнено (@ox A); S1.6 (второй проход): строгий закон — 1612→441 остаточных механизмов записано в baseline.frameLawViolations (вербатим-резолюция и отказ=провал возвращены; full case set), real-shell вставки bash/cmd/pwsh, контроли C30/C181/C183–C187 held |  
  | R18-03 | 209fb68 | A | **P2** | `new-app` печатает git-init подсказку `lock` без `--app` нового деплоя и со смешанной рамкой `cd apps/<name>` | `new-app demo3` → `./clawforge lock` попадает в цель openclaw | I1, I12 | 8a20c48 | S1.6 + контроль «убрать --app»; C3 (check:controls) | выполнено (@ox A); S1.6 (второй проход): строгий закон — 1612→441 остаточных механизмов записано в baseline.frameLawViolations (вербатим-резолюция и отказ=провал возвращены; full case set), real-shell вставки bash/cmd/pwsh, контроли C30/C181/C183–C187 held |  
  | R18-04 | 209fb68 | A | P3 | Конфликт `--app` эхом возвращает недопустимое имя в совет (`--app 'a b'`), совет сам отказывается | `replay-bin.ts global apps/demo --app "a b" status` | I1 | 8a20c48 | S1.6 | выполнено (@ox A); S1.6 (второй проход): строгий закон — 1612→441 остаточных механизмов записано в baseline.frameLawViolations (вербатим-резолюция и отказ=провал возвращены; full case set), real-shell вставки bash/cmd/pwsh, контроли C30/C181/C183–C187 held |  
| R18-05 | 209fb68 | A | P3 | `deploy sync`: строка «install them there» без `cd <remote> &&`, ssh-туннель склеен вручную без кавычек | stub-транспорт, host с `$` | I1, I2 | 8a20c48 | S1.5 | выполнено (@ox A; server lines from the target frame in S1.5b) |
| R18-06 | 209fb68 | A | P3 | Строки «Install:» автодополнения написаны под фиксированный shell, но с программой текущего вызова (`node_modules\.bin\clawforge` в bash) | `completion bash` под win32 wrapper | I2, I12 | 8a20c48 | S1.5 | выполнено (@ox A) |
| R18-07 | 209fb68 | B+F | P3 | Структурный совет (`die(msg, advice)`) теряется в JSON-документе отказа и в конверте MCP (`nextActions:[]`) | команда деплоя с `die(…, command(["bootstrap"]))` | I4, I6 | 8a20c48 | контроль «next: advice без masked»; C6 (check:controls) | выполнено (@ox A) |
| R18-08 | 209fb68 | G | P3 | `--keep` у `set try` оставляет пустой каталог, если попытка падает до создания экземпляра; заметка без рабочей команды | порт занят / ошибка моста путей | I5 | aefc49e | S0.3 | выполнено (@ox A) |
| R18-09 | 209fb68 | A | P3 | `recover-env` проглатывает любую ошибку транспорта: «docker is not running» вместо TARGET_UNREACHABLE | недоступная WSL-цель | I1 | 8a20c48; контракт — S3.4 | контроль «unreachable → empty» | выполнено (@ox A) |
  | R18-10 | 209fb68 | A | P3 | Строка `cd "<checkout>"` собрана вручную в двойных кавычках (раскрытие `$`, backtick в bash) | путь с `$` | I2 | 8a20c48 (shellQuote); cmd — R19-A3 | S1.6 | выполнено (@ox A); S1.6 (второй проход): строгий закон — 1612→441 остаточных механизмов записано в baseline.frameLawViolations (вербатим-резолюция и отказ=провал возвращены; full case set), real-shell вставки bash/cmd/pwsh, контроли C30/C181/C183–C187 held |  
| R18-11 | 209fb68 | D | **P2** | Проверки грамматики аргумента выполняются в `run` после Context: recipe/set build,validate --name/set receipts ids/secrets --store/deploy --path/missing --set для plan,apply,accept | `--app <local> deploy host --path relative` → LOCAL_TARGET_UNSUPPORTED | I5, I13 | aefc49e (частично); полностью — S2.4/S2.5 | S0.2 sweep достигает run; C2 (check:controls) | выполнено (@ox B) |
| R18-12 | 209fb68 | D | **P2** | `set try --set <артефакт>` читает секреты цели раньше, чем проверяет локальный артефакт | `set try --set missing.tar` на недоступной цели | I5 | aefc49e (порядок); артефакт-в-prepare — fix33-X, S2.5 | S0.3 | выполнено (@ox B, C) |
| R18-13 | 209fb68 | B | **P2** | MCP: `new-name` у `recipe` попадает в слот `<name>` при пропущенном `name` (toArgv по позициям) | MCP `recipe {action:"new","new-name":"zzz"}` создаёт рецепт | I4, I6, I13 | aefc49e (срез позиционных); общий binder — S2.2/S2.3 | S0.3; C4 (check:controls) | выполнено (@ox B) |
| R18-14 | 209fb68 | B | P3 | Эффект `destroy` команды шлюза виден только по MCP (нет маркера в справке, `--help`, docs) | `help` / `remove-app --help` | I4 | aefc49e; `help <gate>` — fix33-Y | effect-markers check | выполнено (@ox B) |
| R18-15 | 209fb68 | B | P3 | Два голоса: «required» на консоли и в MCP различаются (choices чинили в R17) | `new-app {}` в MCP | I6 | aefc49e | property: byte-equal | выполнено (@ox B) |
| R18-16 | 209fb68 | G | P3 | `apply-config --dump --force` объявлен `change`, MCP не просит confirm; `secrets --store/--force` молча игнорируются | MCP `apply-config {dump,force}` | I4 | aefc49e | S0.3 | выполнено (@ox B) |
| R18-17 | 209fb68 | G | P3 | `safeName` принимает имена устройств Windows (`con`, `nul`…); `new-app con` создаёт неоткрываемый каталог | `new-app con` | I14 | aefc49e (но: регрессия чтения R19-14) | контроль «device names read» | выполнено (@ox A, B) |
| R18-18 | 209fb68 | G | P3 | Документированная граница summary ≤ 60 не обеспечивается; 4 summary длиннее | скан деклараций | I4 | aefc49e (проверка), fix33-X | S0.5 | выполнено (@ox B) |
| R18-19 | 209fb68 | C | **P2** | Папка рецепта с недопустимым именем проходит `set validate`/`set build` по дереву, но артефакт отказывается как INTEGRITY | `recipes/MyNotes` | I8 | a65697b | parity-вариант; C13 (check:controls) | выполнено (@ox C) |
| R18-20 | 209fb68 | C | P3 | Правила acceptance-spec в `validateManifest` — INTEGRITY, у дерева — content-находка (классификация наоборот) | crafted artifact | I8 | a65697b | parity-вариант | выполнено (@ox C) |
| R18-21 | 209fb68 | G | P3 | `tar` повторяется без `--force-local` при любой ошибке → «Cannot connect to D» вместо причины | corrupt archive под Git Bash | I8, I14 | a65697b; владелец — S3.3 | S0.3 | выполнено (@ox C) |
| R18-22 | 209fb68 | C | P3 | `compareLock` сравнивает digest строкой: зеркальный реестр = LOCK_DRIFT | mirror digest | I7 | a65697b | lock check | выполнено (@ox C) |
| R18-23 | 209fb68 | B | P3 | `upgrade --dry-run --json` не содержит строку пина | stub-run | I7 | a65697b (недостаточный контроль: R19-C-05) | S0.3; C7 (check:controls) | выполнено (@ox C) |
| R18-24 | 209fb68 | F | P3 | Пустые проверки: restore-dry-run (`at(-2)`), webhook (`?? ""`), gate-commands:331 | мутации plan.ts / webhook.ts | I9 | a65697b, 3762857 | S0.3 | выполнено (@ox C) |
| R18-25 | 209fb68 | F | P3 | Охрана запуска проверок не видит запись в игнорируемые пути вне `apps/` | запись `.claude/…` | I10 | a65697b (частично: R19-C-08) | S0.4 | выполнено (@ox C) |
| RUSH-R18 | 209fb68 | — | — | Волна rush `reviewer` (gpt-6.1-sol) раунда 18: пустые таблицы; инструментов выполнения у роли нет | — | — | не засчитывается | — | только статически |

## Раунд 19

| ID | База SHA | Класс | Сев. | Механизм (одна строка на причину) | Repro (кратко) | Инвариант | Чинится | Отрицательный контроль | Статус проверки |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R19-01 | 3762857 | G | **P2** | `operations` и `rollback` читают недоступную цель как «операций нет», код 0 | `--app <wsl-missing> operations` | I14 | fix33-Y; контракт — S3.4 | S0.3 «unreachable→empty»; C5 (check:controls) | выполнено (@ox A, B) |
| R19-02 | 3762857 | D | **P2** | `recipe import ./Bad_Name`: имя из basename источника проверяется в `run` после Context | recording WSL transport | I5, I13 | fix33-X; prepared plan — S2.5 | S0.2 | выполнено (@ox B) |
| R19-03 | 3762857 | D | **P2** | Локальные факты (отсутствующий артефакт set try/diff, несуществующий рецепт, provision-agent, accept, источник без recipe.json) проверяются в `run` | recording transport | I5, I13 | fix33-X; S2.5 | S0.2 | выполнено (@ox B, C) |
| R19-04 | 3762857 | C | **P2** | Отказ по именам устройств применяется читателями: существующие `apps/aux`, запись установленного набора `aux`, артефакт `aux` | in-process fake FS | I14 | fix33-X; типы имён — S3.1 | S0.3 | выполнено (@ox B, C) |
| R19-05 | 3762857 | G | **P2** | `tar -xzf -C <staging>` разворачивает backslash-escape в пути TEMP (`\\t`, `\\a`…): любой корректный артефакт отказывает | TEMP `…/tom/Temp` | I8 | fix33-Y; владелец — S3.3 | S0.3 | выполнено (@ox C) |
| R19-06 | 3762857 | F | P3 | Sweep I5 не выбирает деплой: стадий run = 0, мутация без `parse` проходит | `set build --name Bad_Name` | I5, I9, I11 | fix33-X; S0.2 | S0.2/S0.3; C1 (check:controls) | выполнено (@ox B, C) |
| R19-07 | 3762857 | A | P3 | Ремарка ошибок транспорта — строка `nextAction`, не Advice; `logs`, `lock`, `secrets`, `backup install` без следующего шага; JSON без `next` | `--json` на недоступной цели | I1, I4 | fix33-Y; S3.4 | S0.3 | выполнено (@ox A, B) |
  | R19-08 | 3762857 | A+F | P3 | `checkoutRootProgram` оставляет `node_modules\\.bin\\clawforge` для корня checkout (программы там нет); golden это закрепляет | `resolveInstalledEntry` под win32 wrapper | I3, I12 | fix33-Y; S1.2 | S1.6 | выполнено (@ox A; статически @ox-отчёт сходимости); S1.6 (второй проход): строгий закон — 1612→441 остаточных механизмов записано в baseline.frameLawViolations (вербатим-резолюция и отказ=провал возвращены; full case set), real-shell вставки bash/cmd/pwsh, контроли C30/C181/C183–C187 held |  
  | R19-09 | 3762857 | A | P3 | `cd '<checkout>'` (shellQuote) не работает в cmd.exe | bat-файл с одинарными кавычками | I2 | fix33-Y; S1.4 | S1.6 | выполнено (@ox A); S1.6 (второй проход): строгий закон — 1612→441 остаточных механизмов записано в baseline.frameLawViolations (вербатим-резолюция и отказ=провал возвращены; full case set), real-shell вставки bash/cmd/pwsh, контроли C30/C181/C183–C187 held |  
  | R19-10 | 3762857 | A | P3 | `deploy`: команда для сервера в локальном написании (`node_modules\\.bin\\clawforge bootstrap`) | `setInvocation(win32 wrapper)` | I2 | fix33-Y; S1.5 | S1.6 | выполнено (@ox A; server line spelled by the remote checkout's own frame in S1.5b); S1.6 (второй проход): строгий закон — 1612→441 остаточных механизмов записано в baseline.frameLawViolations (вербатим-резолюция и отказ=провал возвращены; full case set), real-shell вставки bash/cmd/pwsh, контроли C30/C181/C183–C187 held |  
  | R19-11 | 3762857 | E | P3 | Решение gate-command не несёт app: `check --help` и `help check` печатают разные написания | `--app alpha check --help` | I3 | fix33-Y; S1.3 | S1.6 | выполнено (@ox A); S1.6 (второй проход): строгий закон — 1612→441 остаточных механизмов записано в baseline.frameLawViolations (вербатим-резолюция и отказ=провал возвращены; full case set), real-shell вставки bash/cmd/pwsh, контроли C30/C181/C183–C187 held |  
  | R19-12 | 3762857 | A | P3 | Совет с явным `--app X` из каталога деплоя Y отказывается как конфликт | `frameworkOwner({appRoot: apps/alpha})` | I1, I12 | fix33-Y; S1.4 | S1.6 | выполнено (@ox A); S1.6 (второй проход): строгий закон — 1612→441 остаточных механизмов записано в baseline.frameLawViolations (вербатим-резолюция и отказ=провал возвращены; full case set), real-shell вставки bash/cmd/pwsh, контроли C30/C181/C183–C187 held |  
| R19-13 | 3762857 | E | P3 | Резолвер читает глобальный `invocation()` для выбора строки отказа; bin.ts считает предварительный frame | чтение кода | I3, I12 | S1.3 (fix33-Y, если мало) | ratchet на invocation() в entry | выполнено (@ox A, статически) |
| R19-14 | 3762857 | G | P3 | Пустой `OC_APP=` считается выбором | `OC_APP= clawforge help` | I3 | fix33-Y | S0.3 | выполнено (@ox A) |
| R19-15 | 3762857 | F | P3 | Токен `{install …}` в прозе справки не проверяется; строки cron/schtasks сравниваются с самим собой | мутации | I9, I11 | fix33-Y; S0.5: C10 (check:controls) | S0.3; C10 (check:controls) | выполнено (@ox A) |
| R19-16 | 3762857 | D | P3 | Идентификаторы без грамматики: `operations ../x`, `rollback --operation ../x`, `apply --expect Bad_Name`, `set forget --name`; образ с `-` | recording transport | I5, I13 | fix33-X; S2.4 | S0.3 | выполнено (@ox B) |
| R19-17 | 3762857 | B | P3 | MCP: неизвестное действие + позиционный → «applies-to» вместо «unknown action»; отказ в `prepare` → `changed:true`; `help <gate>` без ноты effect; conflicts в справке словом «and» | MCP `recipe {action:"bogus",name}` | I4, I6, I13 | fix33-X/Y; S2.3, S2.7 | S0.3 | выполнено (@ox B) |
| R19-18 | 3762857 | F | P3 | Пустые/самосравнивающиеся проверки: summary-loop view.check, upgrade dry-JSON pin, host/backup/watch/effect-markers, маскирование JSON `next` без охраны | мутации M3, M6, M14, M17, M20 | I9, I11 | fix33-X/Y; S0.3, S0.5; S0.5: C12 (check:controls) | S0.3; C8, C12 (check:controls) | выполнено (@ox C) |
| R19-19 | 3762857 | F | P3 | Прозовые пины в константах/`assert.match`/массивах/слитые из слов обходят три ratchet'а | мутации ratchet-regex | I9 | fix33-Y (расширение измерения); S0.5 (решение: токен-измерение) | нет — S0.5 | выполнено (@ox C) |
| R19-20 | 3762857 | F | P3 | Охрана `--ignored=matching` сворачивает каталог в одну строку: утечка внутри существующего `.claude/` невидима | `.claude/…scratch…` | I10 | fix33-Y; S0.4 | S0.4 | выполнено (@ox C) |
| R19-21 | 3762857 | G | P3 | Мелочи: образ в `bootstrap` без тега, порядок маскирования секретов в set try, строка `--keep` с путями оператора, устаревший комментарий | fixture | I7, I9 | fix33-X/Y | — | выполнено (@ox C, B) |

## Приёмка этапа 7 (S4), раунды 1-3

Источники: девять отчётов `review-2026-10-08-stage7-R{1,2,3}-{A,B,C}.md` в этом каталоге; правило приёмки и метрика возврата — `refactor-plan-stage7-2026-10-06.md` §§5–6. Ни один отчёт не задаёт класс A–G находок S4: в колонке «Класс» сохранено «—», серьёзность не переопределена. NEW/RETURN и ссылка на прежнюю строку записаны в механизме; выводы о семействе RETURN остаются аналитической классификацией ревьюеров, а воспроизведения — их выполненным свидетельством.

R2-A использует исходные ID `R1-A-2/3`; ниже сохранены ID с явным указанием раунда. R2-B-2/R2-C-1 и R2-B-3/R2-C-2 объединены попарно: это один механизм сканера и один механизм снимка, обнаруженные двумя ревьюерами. Остальные проявления внутри одной находки не размножены. SHA исправлений сверены с `git log --oneline` текущего worktree; это не новая проверка исправленного поведения. Контроли взяты из отчётов и деклараций `tools/checks/controls/stage7-accept.ts` / `stage7.ts`; прежний контроль смежного механизма не засчитывается за контроль новой находки. Для R3 точного контроля по ID/механизму не найдено — «нет».

### Раунд 1

| ID | База SHA | Класс | Сев. | Механизм (одна строка на причину) | Repro (кратко) | Инвариант | Чинится | Отрицательный контроль | Статус проверки |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1-A-1 | e54590b | — | P2 | NEW: POSIX-экранирование апострофа и двойной кавычки в строке PowerShell ломает разбор допустимого аргумента; точной прежней строки нет | реальный powershell.exe: путь с `$` и апострофом / аргумент с двойной кавычкой → exit 1 до resolver | I12 | b036090 | C194–C196: `real-shells.check.ts` | выполнено (R1-A); исправление повторно проверено в R2-A/R3-A |
| R1-C-1 | e54590b | — | P1 | RETURN R18-25: self-check пишет в фиксированный checkout scratch и успешной очисткой удаляет прежние файлы оператора | sentinel в temp-копии исчезает (ENOENT), run-guard exit 0 | I10 | 6260a82 | C200: `run-guard.check.ts` | выполнено (R1-C); исправление повторно проверено R2-A/B/C и R3-A/C |
| R1-C-2 | e54590b | — | P2 | RETURN семейства R18-25: сканер переносит только чистые aliases и считает неизвестное имя CLEAN, пропуская checkout-запись | anchored alias → writes=[]; исполняемая temp-копия пишет BAD при guard exit 0 | I10, I11 | 6260a82 | C201, C204, C205: `write-isolation.check.ts` | выполнено (R1-C); исходные формы исправлены, новые обходы — R2/R3 |
| R1-C-3 | e54590b | — | P2 | RETURN R19-20 (также R18-25): снимок хранит только имена ignored-файлов и размер apps-файлов свыше 65536 байт, не их содержимое | перезапись 65537 байт / ignored AAAA→BBBB → diffSnapshots=[] | I10, I11 | 6260a82 | C202, C203: `run-guard.check.ts` | выполнено (R1-C); исходные формы исправлены, новые обходы — R2/R3 |

R1-B: доказанных находок и RETURN нет; пустая строка отчёта не считается механизмом.

### Раунд 2

| ID | База SHA | Класс | Сев. | Механизм (одна строка на причину) | Repro (кратко) | Инвариант | Чинится | Отрицательный контроль | Статус проверки |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R2-A: R1-A-2 | 4a6911b | — | P2 | RETURN R19-12: рендерер смотрит на выбор app предыдущим вызовом, а не на выбор нового запуска из cwd другого деплоя | cwd demo, предыдущий --project-root aux → совет --app aux; cmd/pwsh exit 1, конфликт с cwd | I12 | 722c1cb | C230, C232, C236: `advice-anchor.check.ts` | выполнено (R2-A); конфликт исправлен в R3-A, доступность программы — R3-A-1 |
| R2-A: R1-A-3 | 4a6911b | — | P2 | NEW: PowerShell разбирает строку, но native handoff через npm wrapper удаляет кавычки и сливает argv; точной прежней строки нет | реальный ps1/cmd wrapper из PS5.1 → exit 0, argv отличается | I12 | 722c1cb | C231, C233–C235: `real-shells.check.ts` (native pwsh / scoped preference) | выполнено (R2-A); исправление проверено R3-A на cmd/PS5.1, не на современном pwsh |
| R2-B-1 | 6260a82 | — | P2 | NEW (отчёт: не RETURN отдельной строки): image/text принимают управляющие символы, MCP достигает lock/target до отказа аргумента | upgrade с NUL → 8 контактов и TypeError в run; restore с NUL → поздний archive not found | I5, I13 | 0f923c3 | C225, C227–C229: `property-control-chars.check.ts` | выполнено (R2-B); новые границы проверены R3-B |
| R2-B-2 / R2-C-1 | 6260a82 | — | P2 | RETURN семейства R18-25, продолжение R1-C-2: фиксированный словарь fs-вызовов пропускает aliases/imports, namespace promises, удаление, источник rename и destructive child | temp-копия: unlink / fs.promises.writeFile / renamed import → guard exit 0, файл удалён или переписан | I10, I11 | d53f266 | C210–C214: `write-isolation.check.ts` | выполнено (R2-B/C); новые обходы — R3-C-1 |
| R2-B-3 / R2-C-2 | 6260a82 | — | P2 | RETURN семейства R19-20, продолжение R1-C-3: вне apps/ignored снимок сравнивает git status, не содержимое dirty/untracked файлов и внутренности свёрнутого каталога | dirty tracked / untracked перезаписан, файл добавлен в существующий untracked dir → diff=[], runner exit 0 | I10; I11 (R2-B) | fc9ec16 | C222: `runtime-guard.check.ts` | выполнено (R2-B/C); новые границы проверены R3-C, index bits — R3-C-2 |
| R2-B-4 | 6260a82 | — | P3 | —: fixture Proxy отдаёт description как функцию; scheduler-контроли достигают run, но не охраняемой ветви тела | backup/watch install/uninstall → description.startsWith is not a function | I11 | 0f923c3 | C226: `property.check.ts` | выполнено (R2-B); четыре scheduler-контроля достигают sentinel в R3-B/C |
| R2-C-3 | 6260a82 | — | P2 | NEW: проверки снимка и capabilities не охраняют подключение этих механизмов в runner; отключение verdict/probe остаётся зелёным | m10a отключает changed verdict; m10d отключает requires → self-checks exit 0 | I10, I11 | fc9ec16; окружение self-check — e763f28 (tails U) | C220, C221; tails U C240: `runtime-guard.check.ts` | выполнено (R2-C); контроли held в R3-B/C |
| R2-C-4 | 6260a82 | — | P2 | RETURN (частичный) R19-19: const-held проза в check/assert.equal/===, поле или результат функции не двигает ratchet | EXPECT с прозой → architecture exit 0; прямой includes(EXPECT) ловится | I9, I11 | fc9ec16; literal/template tail — e763f28 (tails U) | C215, C216; tails U C241: `prose-held.check.ts` | выполнено (R2-C); прямой const исправлен, новые формы — R3-C-3 |
| R2-C-5 | 6260a82 | — | P3 | —: снимок не наблюдает mode/time ignored-файла; обе охраны пропускают chmod/utimes | ignored token: chmod / utimes → guard и runner exit 0 | I10 | fc9ec16 (mode); исправление времени — — | C224: `runtime-guard.check.ts` (mode; отдельного контроля времени нет) | выполнено (R2-C); mode проверен R3-C, время повторно не доказано |
| R2-C-6 | 6260a82 | — | P3 | —: хеширование ignored-файла с эксклюзивной блокировкой бросает EBUSY до запуска проверок | PowerShell удерживает locked token → snapshot бросает, runner exit 1 | I10 | fc9ec16; readability probe — e763f28 (tails U) | C223: `runtime-guard.check.ts` | выполнено (R2-C); locked/unreadable границы проверены R3-C |
| R2-C-7 | 6260a82 | — | P3 | —: грамматика repository шире Docker, допускает `$`/кавычки/uppercase; возможное Compose-расхождение только предположено | tryParse принимает repo$HOME; env round-trip выполнен, lookup такого --image отказывает | I7 | fc9ec16 | C217: `image-ref.check.ts` | выполнено (R2-C: grammar/env); Compose-эффект не выполнен; новые отказы проверены R3-C |

### Раунд 3

| ID | База SHA | Класс | Сев. | Механизм (одна строка на причину) | Repro (кратко) | Инвариант | Чинится | Отрицательный контроль | Статус проверки |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R3-A-1 | 722c1cb | — | P2 | NEW: совет checkout-shim переключается на bare clawforge, наличие которого checkout frame не гарантирует; R19-12/R19-08 — смежные, не RETURN | restricted PATH: исходный shim exit 0, вставленный совет exit 127 command not found | I12 | - | нет | в работе (раунд 3) |
| R3-A-2 | 722c1cb | — | P2 | NEW: вставленная bash-строка теряет один из двух конечных backslash в аргументе с пробелом; причина native handoff и время появления не установлены | npm bash wrapper / прямой shim → exit 0, argv с двумя backslash становится с одним | I12 | - | нет | в работе (раунд 3) |
| R3-B-1 | 722c1cb | — | P3 | NEW: обратная проекция Advice→MCP nextSteps использует плоскую декларацию без strict binder, action slice и проверки вида | recipe new name extra / backup list --native / watch install с плохим interval → nextSteps выдан, оба strict-входа отказывают | I13, I4 | - | нет | в работе (раунд 3) |
| R3-C-1 | 722c1cb | — | P2 | RETURN семейства R18-25, продолжение R1-C-2/R2-C-1: computed/bound/Reflect/optional fs и Node/PowerShell child обходят import-aware сканер | computed write / Node -e writer в temp-копии → writes=[], guard exit 0 | I10, I11 | - | нет | в работе (раунд 3) |
| R3-C-2 | 722c1cb | — | P2 | RETURN семейства R19-20, продолжение R1-C-3/R2-C-2: assume-unchanged/skip-worktree скрывают запись от porcelain; clean entry не хешируется | оба index bit: реальные байты переписаны, diff=[], runner exit 0; с R3-C-1 обе охраны пропущены | I10, I11 | - | нет | в работе (раунд 3) |
| R3-C-3 | 722c1cb | — | P2 | RETURN R19-19, продолжение R2-C-4: destructuring и присваивание поля после инициализации не переносят прозу в flow ratchet | обе формы → architecture exit 0, proseHeldFlow 1160; обычный const → 1161, exit 1 | I9, I11 | - | нет | в работе (раунд 3) |

### Подсчёты и приёмка

Первый подсчёт — по строкам механизмов после дедупликации. «— NEW/RETURN» означает отсутствие явной метки у R2-B-4/R2-C-5/6/7, а не автоматически NEW.

| Раунд | Строки | P0 | P1 | P2 | P3 | NEW | RETURN | — NEW/RETURN | Чистый |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 4 | 0 | 1 | 3 | 0 | 1 | 3 | 0 | нет |
| 2 | 11 | 0 | 0 | 7 | 4 | 3 | 4 | 4 | нет |
| 3 | 6 | 0 | 0 | 5 | 1 | 3 | 3 | 0 | нет |
| Всего | 21 | 0 | 1 | 15 | 5 | 7 | 10 | 4 | нет |

Сумма исходных находок ревьюеров (без дедупликации) сохранена отдельно, чтобы не менять знаменатель отчётов:

| Раунд | Находки A/B/C | P0 | P1 | P2 | P3 | NEW | RETURN | — NEW/RETURN |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 / 0 / 3 | 0 | 1 | 3 | 0 | 1 | 3 | 0 |
| 2 | 2 / 4 / 7 | 0 | 0 | 9 | 4 | 3 | 6 | 4 |
| 3 | 2 / 1 / 3 | 0 | 0 | 5 | 1 | 3 | 3 | 0 |
| Всего | 5 / 5 / 13 | 0 | 1 | 17 | 5 | 7 | 12 | 4 |

Метрика §6 **«возврат механизма из реестра за раунд»** ниже считает исходные ID находок, классифицированных ревьюерами как RETURN, без дедупликации: **R1=3, R2=6, R3=3**.

| Раунд | RETURN-находки A | RETURN-находки B | RETURN-находки C | Всего RETURN-находок | Вердикт |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 0 | 0 | 3 | 3 | раунд не чистый |
| 2 | 1 | 2 | 3 | 6 | раунд не чистый |
| 3 | 0 | 0 | 3 | 3 | раунд не чистый |

R1-C отдельно сообщает два различных исторических механизма, но все три ID R1-C-1/2/3 имеют RETURN; в R2 после дедупликации остаются четыре RETURN-строки. Эти подсчёты не заменяют число исходных RETURN-находок в метрике выше.

Чистый раунд возможен только без P0–P2; дополнительно §5 требует полноценных выполненных границ, падающих отрицательных контролей и отсутствия возврата. Все три раунда имеют P0–P2, **R3 не чистый**. Для остановки нужны **два последовательных полноценных чистых раунда**; пока **ни одного**. Исправляющий коммит не делает исходный раунд ретроспективно чистым; по R3 здесь не учитывается работа других worktree.

Backlog **без изменений**: новых явно допустимых неблокирующих открытых заметок не установлено. Исправленные P3 R2-B-4/R2-C-6/7 не являются открытыми заметками; R2-C-5 исправлен частично (mode закрыт fc9ec16, изменение времени ignored-файла снимок не наблюдает — остаток записан в строке R2-C-5, содержимое при этом не теряется); R3-B-1 остаётся в работе и не паркуется в backlog.

## Статистика раундов 16–19

Подсчёт по идентификаторам строк таблиц; RUSH-R18 включён отдельной строкой, но не является находкой и исключён из подсчётов severity.

| Раунд | Строки | P2 | P3 | Неизвестная severity |
| --- | ---: | ---: | ---: | ---: |
| 16 | 5 | 2 | 3 | 0 |
| 17 | 4 | 0 | 4 | 0 |
| 18 | 26 | 4 | 21 | 1 |
| 19 | 21 | 5 | 16 | 0 |
| Всего | 56 | 11 | 44 | 1 |

Классы: A — 12 строк; B — 6; C — 5; D — 7; E — 4; F — 7; G — 13; составные/неизвестные метки — 2. Неизвестные поля в исходных данных сохранены как «—»; в раундах 16–17 неизвестны, в частности, часть инвариантов/воспроизведений и отрицательные контроли там, где источники их не называют.
