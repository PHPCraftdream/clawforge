# Реестр находок ревью

Назначение: единый реестр доказанных механизмов дефектов раундов 16–19.
Одна строка соответствует одному механизму, а не числу обнаруживших его ревьюеров.
Классы A–G и серьёзность P2/P3 сохраняются из отчётов.
«Выполнено» означает, что ревьюер воспроизвёл поведение CLI/MCP/проверками.
«Статически» означает только чтение кода; это не считается доказательством удержания.
«Фаза не достигнута» отмечает проверку, которая не дошла до охраняемой фазы.
Неизвестные по источникам поля обозначены «—».
Отрицательный контроль указан, когда он следует из отчётов; иначе — «нет — S0.3».

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
| R18-01 | 209fb68 | A+F | P3 | Отказы в checkout печатают один и тот же ряд `./clawforge` дважды или только bash-шим; у пользователя cmd/pwsh нет рабочей строки (регрессия 209fb68) | `resolveInstalledEntry` init-в-checkout под `clawforge` / `clawforge.cmd` | I1, I12 | 8a20c48; полностью — S1 | S1.6: закон render→resolve | выполнено (@ox A, B, C) |
| R18-02 | 209fb68 | A | P3 | Соседние предложения «at the checkout root» в integration/gate.ts пишут `commandLine` из cwd (`../clawforge`) | replay bin.ts из `<checkout>/docs` с копией checkout | I1, I12 | 8a20c48 | S1.6 | выполнено (@ox A) |
| R18-03 | 209fb68 | A | **P2** | `new-app` печатает git-init подсказку `lock` без `--app` нового деплоя и со смешанной рамкой `cd apps/<name>` | `new-app demo3` → `./clawforge lock` попадает в цель openclaw | I1, I12 | 8a20c48 | S1.6 + контроль «убрать --app»; C3 (check:controls) | выполнено (@ox A) |
| R18-04 | 209fb68 | A | P3 | Конфликт `--app` эхом возвращает недопустимое имя в совет (`--app 'a b'`), совет сам отказывается | `replay-bin.ts global apps/demo --app "a b" status` | I1 | 8a20c48 | S1.6 | выполнено (@ox A) |
| R18-05 | 209fb68 | A | P3 | `deploy sync`: строка «install them there» без `cd <remote> &&`, ssh-туннель склеен вручную без кавычек | stub-транспорт, host с `$` | I1, I2 | 8a20c48 | S1.5 | выполнено (@ox A) |
| R18-06 | 209fb68 | A | P3 | Строки «Install:» автодополнения написаны под фиксированный shell, но с программой текущего вызова (`node_modules\.bin\clawforge` в bash) | `completion bash` под win32 wrapper | I2, I12 | 8a20c48 | S1.5 | выполнено (@ox A) |
| R18-07 | 209fb68 | B+F | P3 | Структурный совет (`die(msg, advice)`) теряется в JSON-документе отказа и в конверте MCP (`nextActions:[]`) | команда деплоя с `die(…, command(["bootstrap"]))` | I4, I6 | 8a20c48 | контроль «next: advice без masked»; C6 (check:controls) | выполнено (@ox A) |
| R18-08 | 209fb68 | G | P3 | `--keep` у `set try` оставляет пустой каталог, если попытка падает до создания экземпляра; заметка без рабочей команды | порт занят / ошибка моста путей | I5 | aefc49e | S0.3 | выполнено (@ox A) |
| R18-09 | 209fb68 | A | P3 | `recover-env` проглатывает любую ошибку транспорта: «docker is not running» вместо TARGET_UNREACHABLE | недоступная WSL-цель | I1 | 8a20c48; контракт — S3.4 | контроль «unreachable → empty» | выполнено (@ox A) |
| R18-10 | 209fb68 | A | P3 | Строка `cd "<checkout>"` собрана вручную в двойных кавычках (раскрытие `$`, backtick в bash) | путь с `$` | I2 | 8a20c48 (shellQuote); cmd — R19-A3 | S1.6 | выполнено (@ox A) |
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
| R19-08 | 3762857 | A+F | P3 | `checkoutRootProgram` оставляет `node_modules\\.bin\\clawforge` для корня checkout (программы там нет); golden это закрепляет | `resolveInstalledEntry` под win32 wrapper | I3, I12 | fix33-Y; S1.2 | S1.6 | выполнено (@ox A; статически @ox-отчёт сходимости) |
| R19-09 | 3762857 | A | P3 | `cd '<checkout>'` (shellQuote) не работает в cmd.exe | bat-файл с одинарными кавычками | I2 | fix33-Y; S1.4 | S1.6 | выполнено (@ox A) |
| R19-10 | 3762857 | A | P3 | `deploy`: команда для сервера в локальном написании (`node_modules\\.bin\\clawforge bootstrap`) | `setInvocation(win32 wrapper)` | I2 | fix33-Y; S1.5 | S1.6 | выполнено (@ox A) |
| R19-11 | 3762857 | E | P3 | Решение gate-command не несёт app: `check --help` и `help check` печатают разные написания | `--app alpha check --help` | I3 | fix33-Y; S1.3 | S1.6 | выполнено (@ox A) |
| R19-12 | 3762857 | A | P3 | Совет с явным `--app X` из каталога деплоя Y отказывается как конфликт | `frameworkOwner({appRoot: apps/alpha})` | I1, I12 | fix33-Y; S1.4 | S1.6 | выполнено (@ox A) |
| R19-13 | 3762857 | E | P3 | Резолвер читает глобальный `invocation()` для выбора строки отказа; bin.ts считает предварительный frame | чтение кода | I3, I12 | S1.3 (fix33-Y, если мало) | ratchet на invocation() в entry | выполнено (@ox A, статически) |
| R19-14 | 3762857 | G | P3 | Пустой `OC_APP=` считается выбором | `OC_APP= clawforge help` | I3 | fix33-Y | S0.3 | выполнено (@ox A) |
| R19-15 | 3762857 | F | P3 | Токен `{install …}` в прозе справки не проверяется; строки cron/schtasks сравниваются с самим собой | мутации | I9, I11 | fix33-Y; S0.5: C10 (check:controls) | S0.3; C10 (check:controls) | выполнено (@ox A) |
| R19-16 | 3762857 | D | P3 | Идентификаторы без грамматики: `operations ../x`, `rollback --operation ../x`, `apply --expect Bad_Name`, `set forget --name`; образ с `-` | recording transport | I5, I13 | fix33-X; S2.4 | S0.3 | выполнено (@ox B) |
| R19-17 | 3762857 | B | P3 | MCP: неизвестное действие + позиционный → «applies-to» вместо «unknown action»; отказ в `prepare` → `changed:true`; `help <gate>` без ноты effect; conflicts в справке словом «and» | MCP `recipe {action:"bogus",name}` | I4, I6, I13 | fix33-X/Y; S2.3, S2.7 | S0.3 | выполнено (@ox B) |
| R19-18 | 3762857 | F | P3 | Пустые/самосравнивающиеся проверки: summary-loop view.check, upgrade dry-JSON pin, host/backup/watch/effect-markers, маскирование JSON `next` без охраны | мутации M3, M6, M14, M17, M20 | I9, I11 | fix33-X/Y; S0.3, S0.5; S0.5: C12 (check:controls) | S0.3; C8, C12 (check:controls) | выполнено (@ox C) |
| R19-19 | 3762857 | F | P3 | Прозовые пины в константах/`assert.match`/массивах/слитые из слов обходят три ratchet'а | мутации ratchet-regex | I9 | fix33-Y (расширение измерения); S0.5 (решение: токен-измерение) | нет — S0.5 | выполнено (@ox C) |
| R19-20 | 3762857 | F | P3 | Охрана `--ignored=matching` сворачивает каталог в одну строку: утечка внутри существующего `.claude/` невидима | `.claude/…scratch…` | I10 | fix33-Y; S0.4 | S0.4 | выполнено (@ox C) |
| R19-21 | 3762857 | G | P3 | Мелочи: образ в `bootstrap` без тега, порядок маскирования секретов в set try, строка `--keep` с путями оператора, устаревший комментарий | fixture | I7, I9 | fix33-X/Y | — | выполнено (@ox C, B) |

## Статистика

Подсчёт по идентификаторам строк таблиц; RUSH-R18 включён отдельной строкой, но не является находкой и исключён из подсчётов severity.

| Раунд | Строки | P2 | P3 | Неизвестная severity |
| --- | ---: | ---: | ---: | ---: |
| 16 | 5 | 2 | 3 | 0 |
| 17 | 4 | 0 | 4 | 0 |
| 18 | 26 | 4 | 21 | 1 |
| 19 | 21 | 5 | 16 | 0 |
| Всего | 56 | 11 | 44 | 1 |

Классы: A — 12 строк; B — 6; C — 5; D — 7; E — 4; F — 7; G — 13; составные/неизвестные метки — 2. Неизвестные поля в исходных данных сохранены как «—»; в раундах 16–17 неизвестны, в частности, часть инвариантов/воспроизведений и отрицательные контроли там, где источники их не называют.
