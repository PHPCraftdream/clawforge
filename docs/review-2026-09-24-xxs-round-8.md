# ClawForge: defensive audit, XXS round 8 — 2026-09-24

## Снимок и метод

Основа: `e57bb8ecc3e1a9fc8637bd5d23594d3c80e7d0ad` (`main` после закрытия задач раунда 7 и очистки истории). Проверены границы приватных путей и архивов, backup/restore, блокировка экземпляра, перечисление файлов и provisioning, recipe hooks, секреты и MCP, set, deploy, сборка, CI и публикация. Это аудит исходников и изолированных воспроизведений, а не свидетельство запуска действующего приложения: контейнеры, реальные секреты, SSH-deploy, live backup/restore и общение с агентом не трогались. Полный набор тестов в этом worktree не запускался.

**Подтверждено:** P0 — 0, P1 — 1, P2 — 5, P3 — 1. Ниже риск и уже закрытые находки отделены от дефектов. P1 означает возможный выпуск приватного файла; P2 — нарушенный поддерживаемый сценарий или защитную гарантию; P3 — неверное машинное сообщение о результате.

## Подтверждённые дефекты

### P1-01 — `privatePaths` принимает двойной `/`, а архив и verifier трактуют путь иначе

**Код:** [`service/recipe.ts:126–145`](../tools/framework/service/recipe.ts#L126), [`service/archive.ts:574–580`](../tools/framework/service/archive.ts#L574), [`commands/lifecycle/verify.ts:86–105`](../tools/framework/commands/lifecycle/verify.ts#L86), [`security/private-paths-ledger.ts:74–84`](../tools/framework/security/private-paths-ledger.ts#L74).

`privatePath()` запрещает пустой первый/последний сегмент и `.`/`..`, но оставляет пустой *внутренний* сегмент. Декларация `privatePaths: ["workspace//credential.txt"]` загружается как допустимая. `excludesFor("migrate", "data", …)` передаёт GNU tar `--exclude=data/workspace//credential.txt`; реальный файл в архиве записывается как `data/workspace/credential.txt` и не исключается. `forbiddenViolations()` сравнивает нормализованное имя записи с исходным литералом `workspace//credential.txt`, поэтому тоже не находит нарушения. Для `share` файл под `workspace/` проходит положительный allow-list; поиск известных значений не обязан знать пароль, созданный сторонним сервисом. Наличие файла возможно при прежней версии recipe или записи вне helper; текущий `private-config` сам такую некорректную декларацию для новой записи не принимает, что сужает, но не устраняет сценарий.

**Проверка:** изолированный вызов `loadRecipe()` вернул `["workspace//credential.txt"]`, а `excludesFor()` — `data/workspace//credential.txt`. GNU tar в временном каталоге Ubuntu оставил `data/workspace/credential.txt` в архиве с этим `--exclude`. Реальные данные и секреты не читались.

**Исправление:** единый канонический валидатор для декларации и ledger должен отвергать любой пустой сегмент до backup/verify; защита должна сравнивать одну каноническую форму на всех этапах. Нужен регрессионный check с настоящим GNU tar для `migrate` и `share`, включая итоговый verifier.

### P2-01 — осиротевший `operation.mutation` блокирует все изменения без штатного восстановления

**Код:** [`runtime/instance-lock.ts:84–105`](../tools/framework/runtime/instance-lock.ts#L84), [`runtime/instance-lock.ts:486–494`](../tools/framework/runtime/instance-lock.ts#L486), [`instance-lock/takeover.check.ts:91–110`](../tools/checks/runtime/convergence/instance-lock/takeover.check.ts#L91).

Новая сериализация takeover создаёт отдельный каталог `operation.mutation`. При завершении процесса между `mkdir` и `finally` каталог остаётся без holder, поколения или срока. Все последующие `takeLock()` отказывают на первом `mkdir`; даже `--break-lock` до чтения обычной блокировки не доходит. Сообщение «retry shortly» продолжает повторяться бессрочно, пока оператор вручную не удалит каталог. Это особенно вероятно при аварийном завершении во время восстановления, для которого `--break-lock` и нужен.

**Проверка:** транспорт-стаб с существующим guard ответил одинаковым отказом для `breakLock: false` и `breakLock: true`. Текущий takeover-check успешно проверяет только живую конкуренцию и нормальное снятие guard.

**Исправление:** предусмотреть доказуемое восстановление после аварии без удаления действующего guard «на глаз»: владелец/поколение, явная процедура безопасного takeover и тест остановки между `mkdir` и освобождением.

### P2-02 — ошибка перечисления target-файлов превращается в «пустой каталог»

**Код:** [`runtime/transport.ts:457–466`](../tools/framework/runtime/transport.ts#L457), [`runtime/transport.ts:480–491`](../tools/framework/runtime/transport.ts#L480), [`provision-agent/reconcile.ts:48–69`](../tools/framework/commands/management/provision-agent/reconcile.ts#L48), [`provision-agent/reconcile.ts:117–151`](../tools/framework/commands/management/provision-agent/reconcile.ts#L117), [`inspect/observe.ts:126–133`](../tools/framework/commands/orchestration/inspect/observe.ts#L126), [`transport-listing.check.ts:136–141`](../tools/checks/integration/mcp/transport-listing.check.ts#L136).

`LocalTransport.listFiles()` ловит любую ошибку `readdir`, а `listFilesVia()` возвращает `[]` при любом ненулевом коде `find`, включая `Permission denied` и частичный обход. Это оправдано только для отсутствующего каталога. `syncRecipeFiles()` после такого ответа считает старые файлы отсутствующими и не удаляет отозванный `server.ts`/контент; `writeWorkspacePromptFiles()` аналогично оставляет старые управляемые `.md`. Успешное provisioning тогда может обслуживать старые инструкции, а inspect использует тот же ложно пустой список.

**Проверка:** изолированный `listFilesVia()` с `find` exit 1 и `stderr: Permission denied` вернул `[]`. Имеющийся check закрепляет именно поведение «любой failing find ⇒ []» и потому проходит, не проверяя отказ доступа.

**Исправление:** отдельно доказать отсутствие root и только для него вернуть `[]`; ошибки доступа/обхода передавать вызывающему коду. Добавить оба случая в check и проверить, что provisioning/inspect не заявляют согласованность при неполном списке.

### P2-03 — лексические regex в hook graph допускают устаревший импорт и отвергают комментарий

**Код:** [`management/recipe/index.ts:127–159`](../tools/framework/commands/management/recipe/index.ts#L127), [`management/recipe/index.ts:170–193`](../tools/framework/commands/management/recipe/index.ts#L170), [`management/recipe/index.ts:213–244`](../tools/framework/commands/management/recipe/index.ts#L213), [`management/recipe/hook-loader.ts:26–36`](../tools/framework/commands/management/recipe/hook-loader.ts#L26).

Допустимый TypeScript `import /* note */ ("./helper.ts")` не соответствует ни одному regex: зависимость не попадает в checksum graph, а запрет вычисляемого импорта её не отклоняет. Изменение только `helper.ts` оставляет `?g=` прежним, и длительная MCP-сессия продолжает исполнять старый модуль. В обратную сторону `// import(variable)` в обычном комментарии regex принимает за исполняемый computed import и отказывает в загрузке hook. Важна синтаксическая, а не текстовая природа обоих случаев.

**Проверка:** временный hook с `import /* note */ ("./helper.ts")` вернул `1` до и после замены экспортируемого значения helper на `2` в том же процессе; hook только с комментарием `// import(variable)` получил ошибку о computed dynamic import. Профильный freshness-check проходит, потому что проверяет формы без комментария между `import` и `(`.

**Исправление:** распознавать импорты синтаксически либо fail-closed на форме, которую анализатор не может учесть. Закрепить обе формы регрессионными проверками в одной длительной сессии.

### P2-04 — ротация snapshots игнорирует отказ `ls` и `rm`

**Код:** [`commands/lifecycle/state.ts:176–207`](../tools/framework/commands/lifecycle/state.ts#L176), [`commands/lifecycle/state.ts:410–417`](../tools/framework/commands/lifecycle/state.ts#L410), [`service/state.check.ts:173–218`](../tools/checks/runtime/service/state.check.ts#L173).

`rotateSnapshots()` делает `ls` и удаление старых архивов вместе с `.secrets.env` через `allowFailure: true`, но ни один `result.code` не проверяет. Недоступный каталог читается как отсутствие старых snapshots; отказ `rm` после успешного списка воспринимается как успешная ротация. `pull` затем завершает работу без сообщения о неограниченно растущих архивах и сохранённых секретных sidecar-файлах. Check проверяет лишь аргументы `rm` при коде 0.

**Проверка:** это прямой проход по двум веткам кода: при `rm` с кодом 1 исполнение достигает конца функции без throw; при `ls` с кодом 1 пустой stdout даёт `stale.length === 0`. На действующем каталоге отказ удаления намеренно не вызывался.

**Исправление:** различать «glob не нашёл совпадений» и ошибку чтения каталога; проверять код удаления, сообщать список неубранных путей и завершать команду с отказом/явным предупреждением. Добавить тесты обоих ненулевых кодов.

### P2-05 — MCP не требует подтверждения для перезаписи секретов

**Код:** [`openclawCommands.management.ts:181–222`](../tools/framework/commands/interface/groups/openclawCommands.management.ts#L181), [`integration/mcp-server.ts:274–282`](../tools/framework/integration/mcp-server.ts#L274), [`management/secrets.ts:90–130`](../tools/framework/commands/management/secrets.ts#L90), [`management/secrets.ts:305–357`](../tools/framework/commands/management/secrets.ts#L305), [`integration/mcp-schema.ts:265–273`](../tools/framework/integration/mcp-schema.ts#L265).

Команда `secrets` объявляет `--apply`, `--init-store`, `--dump` и `--force`, но не объявляет `destructive`; единственный MCP-gate смотрит именно на этот флаг. Поэтому вызов `secrets` с `apply: true` без `confirm: true` может заменить target `config/.env`, локальный repo-env и пересоздать контейнер. `init-store + force` прямо заменяет имеющийся store пустым шаблоном; здесь `force` всё же нужно указать явно, но отдельного MCP-подтверждения нет. Обычный статус и `--print-template` должны остаться доступными без подтверждения.

**Проверка:** сопоставлены декларация, условие gate и исполняемые ветки. Live-операции с ключами не запускались. Простое добавление `destructive: true` опасно: `toArgv()` автоматически добавляет `--force` ко *всем* destructive-командам с одноимённым аргументом; для `secrets` это превратило бы безопасное `--init-store` в перезапись существующего store.

**Исправление:** разделить подтверждение MCP и предметный `--force`; классифицировать действия по их фактической мутации, а не одним флагом на все варианты команды. Проверить, что `status` не просит `confirm`, `apply` просит, а `init-store` никогда не получает `--force` неявно.

### P3-01 — MCP сообщает `changed: false` после `set build`, записавшего артефакт

**Код:** [`openclawCommands.sets.ts:9–13`](../tools/framework/commands/interface/groups/openclawCommands.sets.ts#L9), [`commands/sets/set.ts:188–205`](../tools/framework/commands/sets/set.ts#L188), [`commands/sets/set-manifest.ts:325–355`](../tools/framework/commands/sets/set-manifest.ts#L325), [`integration/mcp-server.ts:274–294`](../tools/framework/integration/mcp-server.ts#L274), [`integration/mcp-schema.ts:88–99`](../tools/framework/integration/mcp-schema.ts#L88).

`readOnlyWhen(["build"])` возвращает true, но `buildSet()` создаёт или атомарно заменяет файл `sets/<name>-<id>.tar.gz`. MCP использует эту классификацию и в gate, и в envelope; `structuredResult()` принудительно выставляет `changed: false`. Для агента ответ утверждает отсутствие изменений, хотя на диске появился новый артефакт. Потребность спрашивать `confirm` для создания артефакта — отдельное продуктовое решение; машинный факт `changed` должен быть правдивым в любом случае.

**Проверка:** трассировка `set → buildSet → writeArtifact → rename` и `readOnlyWhen → toolEnvelope`. Тест MCP сейчас явно ожидает `set build` как read-only (`mcp-server.check.ts:223`).

**Исправление:** отделить «нужно подтверждение удаления/замены» от «команда что-либо записала»; формировать `changed` из реального результата build и обновить контракт теста.

## Риски и гипотезы, не подтверждённые запуском

- **P3-R1, выпуск:** [`publish.yml:29–31`](../.github/workflows/publish.yml#L29) проверяет только префикс `v` у выбранного тега, но не равенство тега версии в [`tools/framework/package.json:3`](../tools/framework/package.json#L3). При ошибочном ручном выборе тега workflow способен попытаться выпустить другую версию. Публикацию не запускал; нужен preflight сравнения перед `npm publish`.
- **P3-R2, покрытие Windows:** [`ci.yml:42–74`](../.github/workflows/ci.yml#L42) честно исключает две WSL-bound проверки и не поднимает Docker/WSL на hosted runner. Зелёный Windows job доказывает Windows-safe subset, а не реальный путь `Windows → WSL → Docker`; его стоит закрыть отдельным оборудованным runner/периодическим прогоном. Это задокументированный пробел проверки, а не обнаруженная неисправность приложения.

## Ранее найденное и состояние на этом снимке

- R7 P1-01: restore проверяет canonical ancestry перед остановкой, переносом, распаковкой и откатом ([`restore.ts:257–286`](../tools/framework/commands/lifecycle/restore.ts#L257), [`restore.ts:335–345`](../tools/framework/commands/lifecycle/restore.ts#L335)). Старый порядок действий в текущем коде не обнаружен.
- R7 P1-02/P1-03: direct verify объединяет target-side privacy history и использует канонические имена archive entries ([`verify.ts:239–280`](../tools/framework/commands/lifecycle/verify.ts#L239)). P1-01 этого раунда относится к **неканонической декларации**, а не к прежнему обходу неканоническим именем archive entry.
- R7 P2-01/P2-02: deploy исключает собственный маркер из rsync и сверяет его после первой синхронизации ([`deploy.ts:434–461`](../tools/framework/commands/management/deploy.ts#L434)); takeover сериализован mutation guard ([`instance-lock.ts:486–494`](../tools/framework/runtime/instance-lock.ts#L486)). P2-01 этого раунда — отказ восстановления после аварии guard, не прежняя гонка двух живых takeovers.
- R7 P2-12/P3-01: прямой computed import отвергается; Windows CI перечисляет новые check-файлы ([`recipe/index.ts:149–159`](../tools/framework/commands/management/recipe/index.ts#L149), [`ci.yml:100–205`](../.github/workflows/ci.yml#L100)). P2-03 касается лексического обхода этого запрета.

Профильные checks `transport-listing.check.ts`, `instance-lock/takeover.check.ts`, `recipe-hook-freshness.check.ts` прошли. Их зелёный результат совместим с находками выше: соответствующие входы они не моделируют, а transport-listing сейчас утверждает неверное поведение для любого failing `find`. Изолированные воспроизведения работали только с временными искусственными данными и не оставили изменений в репозитории.
