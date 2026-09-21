# Общее ревью ClawForge — XA, 2026-09-21

Проверенный commit: `4426fe04486638392b87639cc3b009b6fa32f8f9`.
Проверки выполнены 20–21 сентября 2026 года в отдельном worktree.

## Результат

**Найдено 10 проблем: 2 × P1, 5 × P2, 3 × P3. Подтверждённых P0 нет.**

P0 — критическая авария; P1 — исправить до релиза; P2 — существенный дефект отдельного сценария;
P3 — поддерживаемость, документация или удобство. Отсутствие P0 относится только к проверенной
области и не является доказательством отсутствия уязвимостей.

Главный риск: защита приватных файлов рецептов зависит от необязательной, читаемой с подавлением
ошибок декларации и от несовпадающих правил обработки путей. На синтетических данных подтверждён
**share-архив с приватным файлом, который проходит собственную проверку framework**. Зелёный
штатный набор этот сценарий не покрывает. Также подтверждены обход instance lock командами
рецепта, перезапись декларации при `--dry-run` и выполнение `host engine` с UID 0 без root-флагов.

## Область и метод

Прочитаны последние изменения и критические пути recipes/private-config, secrets/recovery,
transport/runtime, backup/pull/verify/restore, instance lock, MCP dispatch/schema, apply/rollback,
set artifacts, deploy и CI. Предыдущий отчёт серии 2 использован для проверки исправлений,
а не как замена новому анализу кода.

Воспроизведения использовали только временные декларации, синтетические значения и одноразовые
каталоги. Архивация и чтение архивов проверялись настоящим GNU tar через WSL transport; для
сценариев без контейнеров использовались минимальные runtime adapters. `host engine` проверен
настоящим framework-вызовом с единственной командой `id -u`. Рабочее приложение, его конфигурация,
контейнеры и реальные секреты не изменялись. Продуктовый код и штатные тесты не менялись.

## P1-01 — Ошибка чтения recipe.json отключает исключение приватных файлов из backup

**Evidence:** [service/recipe.ts:161](../tools/framework/service/recipe.ts#L161),
[service/recipe.ts:190](../tools/framework/service/recipe.ts#L190),
[service/archive.ts:342](../tools/framework/service/archive.ts#L342),
[lifecycle/verify.ts:168](../tools/framework/commands/lifecycle/verify.ts#L168).

`installedRecipePrivatePaths()` использует `listRecipes()`. Последний возвращает пустой список
при ошибке перечисления каталога и молча пропускает любой рецепт, который не удалось загрузить.
Повреждённый JSON, невалидная декларация или ошибка доступа поэтому трактуются как отсутствие
приватных путей. Архиватор и verifier получают одинаково неполный список и не замечают пропуск.

**Воспроизведение:** создать корректный рецепт с `privatePaths: ["workspace/private"]`, записать
синтетический `credentials.env` через `replacePrivateTargetFile`, затем заменить `recipe.json`
на незавершённый JSON. Вызвать настоящие `createArchive(..., profile: "share")` и
`verifySnapshot(..., "share")` над одноразовым target. Получено:

```json
{"containsPrivateFile":true,"shareVerificationPassed":true}
```

Отдельно подтверждён тот же пропуск в `migrate`: список приватных путей становится пустым,
файл остаётся в архиве, проверка возвращает `true`. Для `share` выбран разрешённый корень
`workspace`, поэтому положительный allow-list не компенсирует потерянную декларацию.

**Impact:** ошибка редактирования или доступа к metadata превращает ранее защищённый файл в
разрешённый для передачи. Это не требует вредоносного рецепта или доступа к реальным ключам.

**Рекомендация:** отделить best-effort каталог для UI от строгого чтения security policy.
Архивация и verification должны останавливаться при ошибке существующего recipe manifest или
его корня. Отсутствие каталога при отсутствии рецептов нужно обрабатывать явно. Для оставшихся
после удаления рецепта runtime-файлов нужна сохраняемая на target декларация приватных путей
или отдельный защищённый корень. Добавить регрессии malformed/unreadable manifest и share round-trip.

## P1-02 — privatePaths трактуется буквально при записи и как glob при архивации

**Evidence:** [service/recipe.ts:102](../tools/framework/service/recipe.ts#L102),
[private-config.ts:49](../tools/framework/security/private-config.ts#L49),
[service/archive.ts:105](../tools/framework/service/archive.ts#L105),
[service/archive.ts:342](../tools/framework/service/archive.ts#L342),
[lifecycle/state.ts:288](../tools/framework/commands/lifecycle/state.ts#L288).

Декларация разрешает символы шаблонов в именах. Private helper сравнивает путь как обычную строку,
но `createArchive` передаёт его в GNU tar как `--exclude=<path>`, где действуют wildcards.
Например, `vault[1]` обозначает для helper каталог с квадратными скобками, а для tar — шаблон
для `vault1`. Приватный каталог с буквальным именем `vault[1]` не исключается.

**Воспроизведение:** объявить `privatePaths: ["vault[1]"]`, записать файл через штатный helper,
создать настоящий `migrate` archive и прочитать его listing. Получено:

```json
{"declarations":["vault[1]"],"containsPrivateFile":true}
```

Самостоятельный `verifySnapshot(..., "migrate")` с исправной декларацией способен обнаружить
этот файл, однако `pull` автоматически проверяет содержимое только для `share`. Обычный migrate
publish на verifier не опирается.

**Impact:** валидный рецепт теряет обещанное исключение credential-файлов из migrate backup.
Обратное несовпадение шаблонов также может исключить посторонние файлы и сделать backup неполным.

**Рекомендация:** дать privatePaths единый контракт буквальных путей и корректно экранировать их
для GNU tar либо переключать literal matching только для этих правил. Не отключать существующие
шаблонные base exclusions целиком. Дополнительно проверять privacy-policy перед публикацией
migrate. Регрессия должна использовать настоящий tar: текущая симуляция в
[snapshot.check.ts:49](../tools/checks/security/credentials/recipe-private-snapshot/snapshot.check.ts#L49)
обрабатывает скобки как литералы и поэтому не воспроизводит поведение GNU tar.

## P2-01 — Private helper разрешает выход из объявленного каталога через `..`

**Evidence:** [private-config.ts:42](../tools/framework/security/private-config.ts#L42),
[private-config.ts:70](../tools/framework/security/private-config.ts#L70).

`assertDeclaredPrivatePath()` проверяет только строковые префиксы `dataDir/` и объявленного пути.
Путь назначения не нормализуется. Проверка `..` в recipe.json защищает декларацию, но не аргумент
`replacePrivateTargetFile` или `ensurePrivateTargetDirectory`.

**Воспроизведение:** при декларации `privatePaths: ["vault"]` вызвать helper для
`<data>/vault/../workspace/private.env`. Настоящий transport записал файл в
`<data>/workspace/private.env`; отказа не было:

```json
{"normalized":"workspace/private.env","writeAccepted":true}
```

**Impact:** ошибка сборки пути в доверенном hook обходит защитный контракт helper. Получившийся
файл не покрывается объявленным backup exclusion; несколько `..` также позволяют выйти из
data-каталога. Это дефект защиты от ошибок recipe author, а не изоляция от враждебного JavaScript:
сам hook и так обладает полным `Context`.

**Рекомендация:** нормализовать и проверять target POSIX-путь до mkdir/write, сверять границы
по сегментам. Отдельно определить поведение symlink ancestors и проверять разрешённый физический
корень, если helper обещает защиту при наличии ссылок. Добавить проверки `..`, повторных слешей,
точных file declarations и symlink parent.

## P2-02 — Рекомендованный restart не применяет изменение repo-env секретов

**Evidence:** [management/secrets.ts:119](../tools/framework/commands/management/secrets.ts#L119),
[lifecycle/lifecycle.ts:51](../tools/framework/commands/lifecycle/lifecycle.ts#L51),
[runtime-docker.ts:177](../tools/framework/runtime/runtime-docker.ts#L177).

После записи repo-env `secrets --apply` предлагает restart для загрузки новых значений.
`restart` вызывает `docker compose restart`: контейнер не пересоздаётся и его `Config.Env`
сохраняется. Изменение секретов в bind-mounted target `.env` и изменение environment,
заданного Compose при создании контейнера, требуют разных действий.

**Проверка:** прослежен путь команды до runtime; штатная проверка CLI helper прямо закрепляет,
что restart не пересоздаёт контейнер. Docker отдельно документирует, что изменение environment
не применяется командой restart: [Docker Compose restart](https://docs.docker.com/reference/cli/docker/compose/restart/).
Живой credential не ротировался.

**Impact:** после `secrets --apply` и рекомендованного `restart` оператор считает ротацию токена
завершённой, но работающий сервис всё ещё использует старое значение. Клиенты с новым значением
теряют доступ, а старое значение остаётся действительным.

**Рекомендация:** различать restart для файловой конфигурации и reconcile/recreate для
container environment. Для repo-env выдавать и выполнять путь, который пересоздаёт изменённый
сервис, затем сверять фактически загруженное значение без его вывода. Проверять ротацию
синтетическим credential в отдельном runtime test.

## P2-03 — Mutating recipe hooks обходят instance lock

**Evidence:** [management/recipe.ts:62](../tools/framework/commands/management/recipe.ts#L62),
[management/recipe.ts:155](../tools/framework/commands/management/recipe.ts#L155),
[management/recipe.ts:226](../tools/framework/commands/management/recipe.ts#L226),
[instance-lock.ts:417](../tools/framework/runtime/instance-lock.ts#L417).

`install` выполняет `prepare`/`afterStart`, а `verify`, `onboard`, `diagnose` исполняют app-owned
код с полным `Context`. MCP уже признаёт эти действия mutating, однако command dispatcher
не оборачивает их в `guarded`. Подтверждение MCP не заменяет сериализацию разных процессов.

**Воспроизведение:** на одноразовом target получить настоящий `takeLock` от имени backup.
Вне его owning scope вызвать обычный `guarded` и затем `recipe install` с hook, записывающим
безопасный marker. Результат:

```json
{"guardedCommandRefused":true,"recipeChangedTarget":true,"holderUnchanged":true}
```

Runtime stack в этом сценарии был stub: Docker build и реальные контейнеры не запускались.
Lock и запись marker выполнялись настоящим transport.

**Impact:** hook может менять конфигурацию или приватные файлы одновременно с backup/restore/apply.
Возможны несогласованный snapshot, запись в перемещаемое restore дерево и потеря изменений.

**Рекомендация:** включить mutating recipe actions в общий nesting-safe instance guard. Scope
должен покрывать подготовку, build/up и afterStart, а также неизвестные по эффектам hooks.
Проверить refusal при чужом lock и вложенный вызов при собственном lock.

## P2-04 — `host engine` может запускаться как root без root-флагов

**Evidence:** [host/contexts.ts:56](../tools/framework/commands/interface/host/contexts.ts#L56),
[host/contexts.ts:98](../tools/framework/commands/interface/host/contexts.ts#L98),
[host/index.ts:59](../tools/framework/commands/interface/host/index.ts#L59).

В Windows обычный engine execution вызывает `wsl.exe -d docker-desktop --exec ...` без
указания пользователя. Это выбирает default user дистрибутива, который в проверенном окружении
имеет UID 0. Проверка пары `--root --confirm-root` регулирует только явный запрос пользователя,
но не фактические полномочия запуска.

**Воспроизведение:** настоящий `host(ctx, ["engine", "--", "id", "-u"])` без root-флагов
вернул UID `0`. Это единственная выполненная команда внутри engine; она ничего не изменяла.

**Impact:** заявленный контракт «root только с двумя флагами» не выполняется. Обычный
диагностический вызов получает полномочия на изменение engine state, которых оператор мог
не предполагать. Это не получение новых прав непривилегированным атакующим: оператор уже
имеет доступ к WSL; проблема в скрытом выборе полномочий framework.

**Рекомендация:** определять effective user выбранного контекста. Если непривилегированного
контекста нет, явно требовать consent для root execution либо выбирать поддерживаемого
непривилегированного пользователя. Добавить контрактный test с реальным UID вместо проверки
только наличия `-u root` в argv.

## P2-05 — `apply-config --dump --dry-run --force` перезаписывает декларацию

**Evidence:** [orchestration/config.ts:30](../tools/framework/commands/orchestration/config.ts#L30),
[orchestration/config.ts:38](../tools/framework/commands/orchestration/config.ts#L38),
[orchestration/config.ts:158](../tools/framework/commands/orchestration/config.ts#L158).

Parser принимает комбинацию флагов, но ветка `dump` вызывается раньше обработки `dryRun` и
не получает его значение. `dumpDesiredState` записывает файл и при `--dry-run`.

**Воспроизведение:** во временном deployment создать desired-state с дополнительным полем,
подставить безопасный live config adapter и вызвать `applyConfig` с
`["--dry-run", "--dump", "--force"]`. Получено:

```json
{"localDeclarationReplaced":true,"customSettingLost":true}
```

**Impact:** операция, которую оператор или агент запрашивает как предварительный просмотр,
может потерять локальные настройки. Dump восстанавливает только три фиксированных пути,
поэтому прочие декларации исчезают.

**Рекомендация:** реализовать dry-run для dump либо отклонять несовместимую комбинацию до любой
записи. Аналогично валидировать взаимоисключающие operation flags вместо неявного приоритета.
Регрессия должна сравнивать байты существующего файла до и после вызова.

## P3-01 — MCP не выражает CLI-операцию импорта рецепта под новым именем

**Evidence:** [management/recipe.ts:129](../tools/framework/commands/management/recipe.ts#L129),
[openclawCommands.management.ts:288](../tools/framework/commands/interface/groups/openclawCommands.management.ts#L288),
[mcp-schema.ts:182](../tools/framework/integration/mcp-schema.ts#L182).

CLI принимает `recipe import <source> [name]`. MCP declaration содержит только `action` и
`name` как positional arguments; отдельного source/destination нет. Описание `name` называет
его destination, хотя dispatcher использует второй positional как source.

**Проверка:** `validate(recipe, {action: "import", source: "fixture-source", name: "renamed",
confirm: true})` возвращает `unknown argument: source`. Без `source` `toArgv` может сформировать
только `["import", "fixture-source"]`, а нужный третий positional выразить нечем.

**Impact:** агент не может выполнить поддерживаемый CLI импорт с переименованием через
объявленный MCP tool и вынужден обращаться к произвольному host execution или редактированию.

**Рекомендация:** явно объявить source/destination или совместимую positional схему для import,
исправить help и добавить MCP round-trip test обоих вариантов импорта.

## P3-02 — Private-file policy появилась в коде, но не в инструкции автора рецепта

**Evidence:** [service/recipe.ts:65](../tools/framework/service/recipe.ts#L65),
[private-config.ts:50](../tools/framework/security/private-config.ts#L50),
[README.md:466](../README.md#L466).

README рекомендует private-file helpers и `execWithSecrets`, но не объясняет `recipe.json`
`privatePaths`. Поиск этого поля в README, package README и command help не находит описания.
Исторический review предлагает такую декларацию, однако это не действующая инструкция API.

**Impact:** корректно выглядящий новый recipe hook отказывает на первой записи, а автор вынужден
читать framework source. Не объяснено и различие профилей: `migrate`/`share` исключают объявленные
пути, `full` сохраняет их.

**Рекомендация:** добавить короткий generic пример recipe.json и private-write hook, контракт
буквальных data-relative путей, таблицу поведения snapshot profiles и способ проверки recipe.
Согласовать описание verify hook: заголовок service/recipe.ts всё ещё называет его read-only,
хотя MCP теперь обоснованно требует подтверждение неизвестного app-owned кода.

## P3-03 — Recipe import сохраняет сведения о конкретном приложении в framework

**Evidence:** [management/recipe.ts:140](../tools/framework/commands/management/recipe.ts#L140),
[service/recipe.ts:66](../tools/framework/service/recipe.ts#L66).

Фильтр импорта содержит имя credential-файла и расширение registry-файла конкретного sidecar.
В public interface comment также приведено его конкретное имя. Это нарушает принятую границу:
framework предоставляет механизмы, приложение декларирует свои файлы и формат.

**Impact:** blacklist расширяется под каждую интеграцию, не даёт общей гарантии для другого
формата credential-файла и требует изменения framework при добавлении приложения.

**Рекомендация:** вынести особенности импорта в generic declarative policy/allow-list,
использовать нейтральные примеры в interface/docs. Не считать file-name blacklist достаточной
защитой от секретов. Переход должен сохранить существующие исключения до миграции деклараций.

## Выполненные проверки

| Проверка | Результат |
| --- | --- |
| Node | `v24.12.0` |
| `npm ci --ignore-scripts --no-audit --no-fund` в worktree | Успешно |
| `npm test`, с выбранным тестовым WSL transport | **82 check-файла прошли** |
| `npm run format:check` | tsgo и Oxlint прошли |
| `npm run build` | **85 файлов**, успешно |
| `npm run pack:check` | Успешно, включая prepack |
| GNU tar: malformed declaration, literal bracket path | Оба дефекта воспроизведены |
| Share verification после повреждения declaration | Приватный fixture-файл ошибочно принят |
| Private-write traversal и held-lock recipe execution | Оба дефекта воспроизведены |
| `apply-config` dump + dry-run | Перезапись fixture-декларации подтверждена |
| MCP import schema и настоящий `host engine ... id -u` | Пробел схемы и UID 0 подтверждены |

Падений штатного набора не было. CI workflow просмотрен: Linux/Node 24 выполняет test,
typecheck/lint, build и pack. Удалённый CI этим audit не запускался; локальная проверка не
выдаётся за новый GitHub Actions result.

## Границы выводов и порядок исправления

В первую очередь закрыть P1-01/P1-02 и добавить настоящие tar round-trip regressions. Затем
согласовать private-path validation, instance lock и lifecycle секретов; отдельно исправить
dry-run и effective UID. После изменения generic API обновить README/help/MCP schema.

Существующие тесты дают хорошую защиту уже известных сценариев, но некоторые security tests
моделируют внешние программы и поэтому пропускают расхождение с настоящими правилами tar.
Полезнее добавить проверки конкретных контрактов, чем расширять mock теми же предположениями.

Не проверялись восстановление рабочего deployment, реальная ротация ключей, SSH end-to-end,
полный restore sidecar state, публикация npm и security advisory databases зависимостей.
Факт успешной архивации не считается доказательством восстановимости. Найденные проблемы
зафиксированы в этом отчёте; исправления продукта в audit-коммит не включены.
