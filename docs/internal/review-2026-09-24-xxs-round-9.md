# ClawForge: defensive audit, XXS round 9 — 2026-09-24

## Снимок и границы проверки

Основа: `e83c98c6aa329c5b67e5ae7e22978795f4947bad`. Проверены архивы и
приватные пути, backup/restore, Docker runtime, recipe hooks и provisioning,
instance lock, MCP, set, deploy, документация и release/CI. Для новых гипотез
использовались только маленькие искусственные деревья и транспортные стабы;
действующее приложение, реальные секреты, контейнеры, удалённый deploy и
живые backup/restore не трогались. Полный набор checks не запускался.

**Подтверждено:** P0 — 0, P1 — 2, P2 — 4, P3 — 1. P1 здесь означает
возможный выпуск ключей или недостоверный backup по обычной команде;
P2 — нарушенный поддерживаемый сценарий; P3 — неверное обещание интерфейса.
Ниже подтверждённые дефекты отделены от рисков и сознательных ограничений.

## Подтверждённые находки

### P1-01 — метасимвол в имени data root отменяет базовые исключения архива

**Код:** [`service/archive.ts:83–107`](../tools/framework/service/archive.ts#L83),
[`service/archive.ts:116–118`](../tools/framework/service/archive.ts#L116),
[`service/archive.ts:127–171`](../tools/framework/service/archive.ts#L127),
[`service/archive.ts:574–580`](../tools/framework/service/archive.ts#L574),
[`commands/lifecycle/backup.ts:176–183`](../tools/framework/commands/lifecycle/backup.ts#L176),
[`core/env.ts:191–212`](../tools/framework/core/env.ts#L191).

`OC_DATA_DIR` допускает basename с `[`, `]`, `*` или `?`. Для data root
`/synthetic/data[1]` `baseExcludes()` отдаёт GNU tar, например,
`--exclude=data[1]/config/.env`. Tar читает `[1]` как glob-класс, поэтому
не исключает буквальный `data[1]/config/.env`. В раунде 8 экранировали
**объявленные** `privatePaths`, но базовые исключения, включая provider
`.env`, staging-файлы и историю, собираются без экранирования имени root.
`backup --profile migrate` и `backup --profile share` после создания
проверяют только непустоту архива; `verifySnapshot()` вызывается в `pull`,
но не в `backup`. В результате профильный backup может опубликовать файл
с ключами, хотя профиль обещает их исключить.

**Проверка:** в изолированном GNU tar 1.35 дереве созданы
`data[1]/config/.env` и публичный файл. Команда с тем же
`--exclude=data[1]/config/.env` завершилась с кодом 0; `tar -tzf` показал
`data[1]/config/.env` в архиве. Значения были искусственными. Профильный
`recipe-private-snapshot.check.ts` прошёл: он покрывает скобки в имени
**объявленного пути**, но использует обычное имя data root.

**Исправление:** экранировать basename один раз перед построением **всех**
tar patterns, оставив намеренные wildcard-суффиксы; перед публикацией
любого `migrate`/`share` backup проверять его профильную политику.
Добавить GNU tar регрессию с glob-символом в basename для обеих команд.

### P1-02 — ошибка `docker compose ps` считается остановленным gateway

**Код:** [`runtime/runtime-docker.ts:201–209`](../tools/framework/runtime/runtime-docker.ts#L201),
[`runtime/runtime-docker.ts:262–265`](../tools/framework/runtime/runtime-docker.ts#L262),
[`commands/lifecycle/backup.ts:134–151`](../tools/framework/commands/lifecycle/backup.ts#L134),
[`commands/lifecycle/backup.ts:176–183`](../tools/framework/commands/lifecycle/backup.ts#L176).

`DockerRuntime.isRunning()` вызывает Compose с `allowFailure: true`, а
затем смотрит только на пустоту stdout. Код 125 при недоступном Docker
daemon, ошибка Compose или обрыв транспорта возвращают `false` точно
так же, как корректное «контейнер остановлен». Обычный холодный `backup`
при `false` не вызывает `pause()` и всё равно запускает tar по data
directory. Если gateway продолжает писать SQLite, результат может быть
нецелостным; оператор не запрашивал `--hot` и не получает предупреждения.
Та же потеря сигнала у recipe stack `isRunning()`
([`runtime-docker.ts:574–580`](../tools/framework/runtime/runtime-docker.ts#L574))
позволяет пропустить quiesce sidecar.

**Проверка:** синтетический `DockerRuntime` получил от `docker`
`{code:125, stdout:"", stderr:"synthetic daemon failure"}` и вернул
`isRunning() === false`. Путь backup от этого значения к tar виден в
указанных строках; реальную базу данных не архивировали.

**Исправление:** различать успешный пустой `ps` и ошибку запроса.
Для операций, обещающих согласованный snapshot, неопределённость должна
прерывать работу до tar; диагностические read-only команды могут показывать
отдельное `unknown`. Проверить ошибку Docker для gateway и sidecar.

### P2-01 — битый recipe manifest скрывает работающий sidecar от backup

**Код:** [`service/recipe.ts:264–287`](../tools/framework/service/recipe.ts#L264),
[`management/recipe/index.ts:75–89`](../tools/framework/commands/management/recipe/index.ts#L75),
[`commands/lifecycle/backup.ts:148–161`](../tools/framework/commands/lifecycle/backup.ts#L148).

Каталог `listRecipes()` правильно терпит битый `recipe.json` для
команды `recipe list`, но `runningRecipeStacks()` переиспользует этот
мягкий каталог в backup. Если после запуска sidecar в manifest появится
ошибка формы, например нечисловой `ports[0].host`, его каталоговая запись
исчезает, stack даже не опрашивается; холодный backup не quiesce-ит и не
предупреждает о нём. При этом архивный policy-reader
[`service/recipe.ts:325–365`](../tools/framework/service/recipe.ts#L325)
проверяет только JSON и `privatePaths`, поэтому такую ошибку формы не
отклоняет. Для sidecar, пишущего в общий data directory, это нарушает
гарантию согласованности. Невалидный **JSON**, напротив, останавливает
создание архива и не является этим сценарием.

**Проверка:** изолированный recipe с корректным JSON, но невалидным
`ports[0].host`, и runtime-stub, который для своего stack вернул бы
`true`, дали `runningFound: 0, stacksProbed: 0`.
`installedRecipePrivatePaths()` принял этот же manifest. Живой stack
не запускался.

**Исправление:** отделить tolerant UI-каталог от строгого обнаружения
stack для backup. Битый manifest при неизвестном состоянии sidecar должен
останавливать согласованный backup или давать доказуемую проверку
существующего compose project.

### P2-02 — query у relative import оставляет вложенный helper в старой версии

**Код:** [`management/recipe/hook-loader.ts:26–36`](../tools/framework/commands/management/recipe/hook-loader.ts#L26),
[`management/recipe/hook-graph.ts:188–190`](../tools/framework/commands/management/recipe/hook-graph.ts#L188),
[`management/recipe/index.ts:142–172`](../tools/framework/commands/management/recipe/index.ts#L142).

Resolve-hook проверяет `parentURL.includes("?g=")`. При допустимом
`import "./helper.ts?x=1"` версия добавляется после существующего query:
URL helper становится `?x=1&g=<checksum>`. Из него импорт
`./nested.ts` уже не проходит тест `"?g="`, поэтому nested module
загружается без версии. Graph checksum правильно замечает правку nested,
hook entry и helper переимпортируются, а nested остаётся в Node module
cache от предыдущего MCP-вызова.

**Проверка:** три временных TS-модуля: hook → `helper.ts?x=1` →
`nested.ts`. После замены только nested `importHookModule()` вернул
другой entry module, но результат остался `before` вместо `after`.
Обычный `recipe-hook-freshness.check.ts` прошёл; query-bearing edge в нём
нет.

**Исправление:** читать `g` через `new URL(parentURL).searchParams`,
не искать буквальный префикс query; закрепить вложенную цепь с другим
query-параметром регрессией.

### P2-03 — локальный `#imports` helper не входит в freshness graph

**Код:** [`management/recipe/hook-graph.ts:112–171`](../tools/framework/commands/management/recipe/hook-graph.ts#L112),
[`management/recipe/hook-graph.ts:175–197`](../tools/framework/commands/management/recipe/hook-graph.ts#L175),
[`management/recipe/hook-loader.ts:26–36`](../tools/framework/commands/management/recipe/hook-loader.ts#L26),
[`management/recipe/index.ts:114–122`](../tools/framework/commands/management/recipe/index.ts#L114).

Hook loader обещает нормальное разрешение `#imports` в package scope
рецепта, но checksum обходят только specifier, начинающиеся с `.`,
а resolver версионирует только `./` и `../`. Поэтому локальный
`package.json` с `"imports":{"#helper":"./helper.ts"}` работает,
но правка `helper.ts` в долгой MCP-сессии не меняет checksum hook и
Node возвращает уже загруженную реализацию. Изменение import map в
`package.json` тоже не попадает в graph.

**Проверка:** временный package scope, hook с `import "#helper"`.
После правки только helper второй `importHookModule()` вернул тот же
module object и `before` вместо `after`. Тесты на bare
`@clawforge/framework` проходят, но локальный `#imports` не покрывают.

**Исправление:** разрешать локальные package aliases в том же графе и
штамповать их URL; либо явно отказывать в изменяемых локальных aliases,
если гарантировать версионирование нельзя. Пакетные зависимости, которые
действительно неизменны, следует отличать от файлов рецепта.

### P2-04 — ошибка listing при rotation backup проходит как пустой список

**Код:** [`commands/lifecycle/backup.ts:45–94`](../tools/framework/commands/lifecycle/backup.ts#L45),
[`commands/lifecycle/backup.ts:233–235`](../tools/framework/commands/lifecycle/backup.ts#L233),
[`commands/lifecycle/state.ts:199–202`](../tools/framework/commands/lifecycle/state.ts#L199).

`rotate()` выполняет `ls -1t` с `allowFailure: true` и сразу
парсит stdout без проверки `listing.code`. Ненулевой код из-за потери
доступа, ошибки файловой системы или транспорта с пустым stdout
считается отсутствием старых архивов. Backup уже опубликован, команда
завершается успешно, а retention перестаёт работать и каталог растёт.
В `rotateSnapshots()` раунд 8 аналогичный `find` уже проверяет.

**Проверка:** транспорт-stub ответил `{code:255, stdout:""}` на
listing; `rotate()` завершился без ошибки. Обычный
`backup.check.ts` прошёл, но не моделирует неуспешный listing.

**Исправление:** различать успешный пустой glob и ошибку
`ls`/транспорта, сообщать о непроведённой ротации; добавить
регрессию на ненулевой exit. Желательно получать имена без shell glob,
как это делает snapshot rotation.

### P3-01 — «первый свободный порт» значит только отсутствие записи в `apps/`

**Код:** [`integration/scaffold.ts:62–109`](../tools/framework/integration/scaffold.ts#L62),
[`integration/init.ts:251–298`](../tools/framework/integration/init.ts#L251),
[`tools/clawforge.ts:59–66`](../tools/clawforge.ts#L59).

`new-app` обещает выбрать первый свободный порт, но `usedPorts()`
смотрит только читаемые `.env` под одним монорепозиторным `apps/`.
Он не опрашивает занятые порты хоста/целевого транспорта; установленный
режим `init` использует тот же сканер, хотя соседние установленные
приложения вовсе не обязаны находиться в этом `apps/`. Поэтому два
независимых installed-проекта могут получить один default port, а
коллизия проявится лишь при bootstrap.

**Проверка:** статический путь `initApp() → deploymentEnv() →
usedPorts()` подтверждает единственный источник занятости; сокет
действующего приложения не занимался и bootstrap не запускался.

**Исправление:** честно назвать выбор «первым неиспользованным в данном
каталоге» и проверять конфликт перед bootstrap; для обещания
«свободный порт» проверять адрес на целевом транспорте и объяснять
гонку между проверкой и запуском.

## Риски и ограничения, не засчитанные как новые дефекты

- Mutation guard намеренно не позволяет `--break-lock` перехватить
  `operation.mutation`, если owner записан другой машиной и его жизнь
  нельзя проверить
  ([`instance-mutation-guard.ts:124–129`](../tools/framework/security/instance-mutation-guard.ts#L124),
  [`takeover.check.ts:90–100`](../tools/checks/runtime/convergence/instance-lock/takeover.check.ts#L90)).
  Синтетический orphan другого хоста действительно блокирует новый
  `takeLock` даже с флагом. Это сознательный запрет небезопасного takeover,
  а не доказанный race; для аварии другой машины нужен отдельный
  безопасный runbook и способ подтвердить её остановку.
- `listArchiveLinks()` делит verbose-строку GNU tar по первому
  `" -> "` в имени symlink
  ([`archive.ts:493–520`](../tools/framework/service/archive.ts#L493)).
  Искусственный архив с этим текстом в имени неверно разбирается.
  Проверка GNU tar 1.35 затем отказала в записи файла через такой link
  (`Cannot open: Not a directory`), поэтому фактический обход restore
  не подтверждён; требуется отдельное исследование перед оценкой как
  security defect.
- Windows → WSL → Docker по-прежнему не выполняется в обычном hosted CI;
  ручной `windows-full.yml` ждёт оснащённый self-hosted runner. Это
  известный инфраструктурный пробел R8-09, не новая регрессия.

## Статус раунда 8 и проверки

R8-01 (неканонический `privatePaths`), R8-03 (ошибки transport listing),
R8-05 (snapshot rotation), R8-06 (MCP-confirmation) и R8-07 (`set build`
`changed`) сохранили исправленное поведение в профильных checks.
R8-02 восстановление guard для доказанно умершего **локального**
процесса также проходит; ограничение для другого хоста описано выше.
R8-04 обычные relative imports и циклы проходят
`recipe-hook-freshness.check.ts`; P2-02/P2-03 показывают непокрытые
формы разрешения модулей, а не возврат прежнего бага с простым import.
R8-08 сравнение release tag и package version осталось в workflow; релиз
не запускался. R8-09 остаётся открытым.

Прошли адресные `recipe-private-snapshot.check.ts`,
`recipe-hook-freshness.check.ts`, `backup.check.ts`,
`instance-lock/takeover.check.ts`, `transport-listing.check.ts`,
`mcp-safety-policy.check.ts` и `state/rotation.check.ts`.
Их зелёный результат совместим с находками: перечисленные выше
искусственные входы в них не моделируются. Все воспроизведения были
изолированы от действующего приложения.
