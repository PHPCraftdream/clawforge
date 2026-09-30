# ClawForge — статическое ревью XS, раунд 20

Дата: 2026-09-30. Проверенная база: `main` @ `0c2c1a0`, после исправлений раундов 18/19. Рабочее дерево перед добавлением отчёта чистое. Метод — чтение исходников, документации, существующих checks как исходников и локальной истории. Приложение, tests/checks, build, lint, formatters, smoke, сервисы, контейнеры и нагрузка **не запускались**. Действующие секреты и файлы пользовательских deployment не читались. Дополнительные агенты и `/rush` не использовались. Единственное изменение и предмет локального коммита — этот отчёт.

Прочитаны [отчёт раунда 19](review-2026-09-30-xs-round-19.md), [его сессионный статус](session-tasks-2026-09-30-round-19.md), отчёт/статус раунда 18; сопоставлены перечни механизмов и статусы раундов 10–17 и доступных более ранних внутренних ревью. Переданные результаты verification раунда 19 приняты как ранее полученное evidence, а не повторены и не расширены новым динамическим прогоном. Закрытые механизмы не заявляются заново.

Шкала: **P0** — безусловный критический ущерб; **P1** — утечка секретов или потеря данных в поддерживаемом сценарии; **P2** — существенное нарушение поддерживаемого поведения; **P3** — меньший эксплуатационный дефект. Новые подтверждаемые статически находки: **P0 = 0, P1 = 0, P2 = 2, P3 = 0**. Ни одна новая находка не выдаётся за воспроизведённую в этом раунде.

## Сводка

| ID | Приоритет | Нарушенный supported workflow |
| --- | --- | --- |
| R20-01 | P2 | Зарегистрированный `mcp-serve` закрывает дочерний stdin вместо передачи клиентских JSON-RPC запросов |
| R20-02 | P2 | `watch`/`backup install` одного deployment заменяет расписание другого с тем же basename; uninstall также удаляет чужое расписание |

Исправления шести механизмов раунда 19 в изученных ветвях согласованы с их исходными acceptance. Две находки этого раунда относятся к другим границам: интерактивному протокольному вводу и идентичности задания в общем scheduler namespace.

## Подтверждённые находки

### R20-01 / P2 — канал `mcp-serve` не передаёт stdin клиента дочернему MCP-серверу

**Поддерживаемый контракт.** `mcp-setup` регистрирует два разных сервера: `clawforge` для разговоров/каналов OpenClaw и `clawforge-control` для административных команд framework. Это не один и тот же процесс и не взаимозаменяемые возможности: [project.ts:76–84](../../tools/framework/integration/mcp/project.ts#L76), [deploy-and-mcp.md:118–143](../guide/deploy-and-mcp.md#L118). Сам `mcpServe()` обещает stdio bridge с унаследованными stdin/stdout/stderr: [credentials/mcp.ts:38–56](../../tools/framework/commands/management/credentials/mcp.ts#L38).

**Цепочка кода:**

- [credentials/mcp.ts:43–56](../../tools/framework/commands/management/credentials/mcp.ts#L43): при работающем helper вызывается `execInHelper("cli-helper", ["mcp", "serve", ...args])` без `input`; иначе `runOneOff("cli", ["mcp", "serve", ...args], { profile: "cli" })`, также без `input`.
- [helper-container.ts:39–58](../../tools/framework/runtime/docker/helper-container.ts#L39): `docker exec -i` получает `stream: options.input === undefined`, но никакого источника живого stdin ему не передаётся.
- [compose-operations.ts:275–292](../../tools/framework/runtime/docker/compose-operations.ts#L275): one-off путь выставляет `stream: options.input === undefined`, а `input` оставляет `undefined`. При pipe stdout Compose получает `-T`, то есть этот путь намеренно не опирается на TTY.
- [exec.ts:140–150](../../tools/framework/runtime/transport/exec.ts#L140): наследование stdio разрешено лишь когда stdout **и** stderr framework — настоящие терминалы. У запускаемого MCP-клиентом процесса stdout является протокольным pipe, поэтому `streamToTerminal` ложно и дочерний процесс создаётся с `stdio: ["pipe", "pipe", "pipe"]`.
- [exec.ts:232–234](../../tools/framework/runtime/transport/exec.ts#L232): при `input === undefined` выполняется `child.stdin?.end()`. `process.stdin` не подключается к этому pipe ни здесь, ни в `mcpServe()`.
- Это общий путь встроенных transports: [local.ts:13–15](../../tools/framework/runtime/transport/local.ts#L13), [wsl.ts:33–39](../../tools/framework/runtime/transport/wsl.ts#L33), [ssh.ts:61–68](../../tools/framework/runtime/transport/ssh.ts#L61).

**Конкретный сценарий.** Deployment работает; оператор выполнил штатный `mcp-setup` либо использует конфигурацию от `new-app`/`init`. Claude Code/Codex запускает entry `clawforge` с pipe stdin/stdout и отправляет `initialize`, затем дальнейшие запросы. Launcher импортирует CLI в том же процессе ([project.ts:24–35](../../tools/framework/integration/mcp/project.ts#L24), [:43–55](../../tools/framework/integration/mcp/project.ts#L43)); он не является дополнительным stdin-relay. С `cli-start` или без него нижний `spawnLocal()` создаёт отдельный pipe дочернему Docker/WSL/SSH процессу и сразу подаёт EOF. Байты `initialize` остаются на stdin framework и не достигают `openclaw mcp serve`.

**Механизм и последствия.** В одной опции смешаны «показывать output по мере поступления» и «унаследовать живой stdin». После перехода на pipes для не-терминального stdout унаследованный input больше не существует, а fallback не реализует duplex forwarding. Сервер внутри контейнера не может ответить на запрос, который до него не дошёл: зарегистрированный разговорный MCP-канал не устанавливает штатный обмен. Будет ли конкретный upstream процесс сразу завершаться на EOF или ждать, здесь не утверждается — потеря входных запросов доказана до этой развилки. Работающий `control-mcp` не закрывает дефект: его Node-сервер сам читает `process.stdin`, без этого дочернего bridge.

**Почему прежнее evidence не опровергает находку.** [cli-helper.check.ts:486–519](../../tools/checks/foundation/cli/cli-helper.check.ts#L486) подменяет runtime и проверяет выбор helper/fallback и readiness, а не реальный клиентский stdin. [mcp-project.check.ts:123–127](../../tools/checks/integration/mcp/mcp-project.check.ts#L123) обращается к entry `clawforge-control`, не к `clawforge`. Transport scenarios проверяют конечный переданный `input` ([contract.ts:81–84](../../tools/checks/runtime/transport/scenarios/contract.ts#L81)), что не проверяет отсутствие `input` при живом stdio-протоколе. Это чтение границы имеющегося покрытия, не результат запуска этих файлов.

**Разумное исправление.** Явно отделить режим двустороннего stdio bridge от обычного captured input/output и провести его через `mcpServe`, helper/one-off runtime и transport. В протокольном режиме клиентский stdin должен оставаться подключённым к дочернему stdin до EOF/закрытия, а ответ — доходить обратно без превращения в command-result. Сохранить безопасный piped путь для Windows: просто вернуть безусловное наследование всех дескрипторов значит вернуть уже закрытый отказ Windows/MSYS pipe. Не выводить progress в протокольный stdout и не применять к JSON-RPC content фильтр «Compose noise». Конечный `input: ""` read-only queries по-прежнему должен закрывать stdin и не ждать клиентского ввода.

**Acceptance после исправления:**

1. Реальный process/stdio сценарий без TTY через настоящий `mcpServe` → runtime → transport: клиент отправляет `initialize`, получает ответ с тем же id, затем отправляет второй запрос и получает второй ответ **до** закрытия своего stdin. Проверить отдельно helper и one-off ветви, не только наличие `-i` или имя вызываемой функции.
2. Ответы на stdout — только JSON-RPC; stderr/progress не попадает в протокол. EOF клиента и закрытие дочернего процесса завершают bridge без зависшего relay.
3. Адресно проверить путь Windows→WSL с pipe, не ослабляя прежнюю защиту не-TTY streaming. Если реальный WSL/Docker недоступен, отдельно обозначить этот предел; процессный relay проверять настоящими pipes, а не fixture, сразу возвращающим готовый `ExecResult`.
4. Обычный `Transport.exec` с явно заданным конечным input и административный `control-mcp` сохраняют свои существующие контракты.

**Отличие от прежних findings:** не проблемы JSON-RPC dispatch/cancellation/redaction `control-mcp`, не freshness recipe hook и не недостаток списка инструментов. Здесь другой supported сервер и физическая потеря входного потока.

### R20-02 / P2 — scheduler считает basename полной идентичностью deployment и заменяет чужое задание

**Поддерживаемый сценарий.** Два независимых installed consumer-проекта на одном Linux host под одним scheduler account: `/srv/team-a/deployment` и `/srv/team-b/deployment`. Оба созданы штатным `clawforge init`. У них разные `OC_DATA_DIR`, порты и допустимые `OC_COMPOSE_PROJECT` (`team-a`/`team-b`), то есть Docker instances и target instance locks независимы. Installed-mode действительно выбирает deployment по полному project root: [bin.ts:28–35](../../tools/framework/entry/bin.ts#L28), [:65–75](../../tools/framework/entry/bin.ts#L65); сам сценарий установки опубликован в [deploy-and-mcp.md:89–107](../guide/deploy-and-mcp.md#L89). `OC_COMPOSE_PROJECT` отдельно валидируется и не обязан равняться имени каталога ([deployment.ts:58–83](../../tools/framework/runtime/deployment.ts#L58)). Ни `init`, ни dispatch не требуют глобально уникального basename среди всех consumer repositories ([init.ts:214–241](../../tools/framework/integration/deployment/init.ts#L214)).

**Код и механизм:**

1. [deployment.ts:50–55](../../tools/framework/runtime/deployment.ts#L50) возвращает `basename(deploymentDir())`, в обоих проектах — `deployment`. Полный root в этой строке больше не участвует.
2. [schedule.ts:30–39](../../tools/framework/commands/operate/schedule.ts#L30) строит marker `# clawforge-<job>:<name>` и Windows task name `clawforge-<name>-<job>` только из job и этого basename.
3. Installed POSIX invocation различает проекты правильно по cwd ([schedule.ts:248–256](../../tools/framework/commands/operate/schedule.ts#L248)), но [ownedCronPattern():103–110](../../tools/framework/commands/operate/schedule.ts#L103) принимает **любой** цитированный cwd при совпадении job/name. Ни root, ни Compose project, ни data root с ownership identity не сверяются.
4. [backup/install.ts:64–94](../../tools/framework/commands/lifecycle/backup/install.ts#L64), [:97–118](../../tools/framework/commands/lifecycle/backup/install.ts#L97) и [watch/install.ts:97–129](../../tools/framework/commands/operate/watch/install.ts#L97), [:132–156](../../tools/framework/commands/operate/watch/install.ts#L132) используют именно такую identity при install и uninstall.
5. Account-wide transaction выполняет `grep -Ev` ownership pattern, после чего добавляет новую строку ([schedule.ts:172–186](../../tools/framework/commands/operate/schedule.ts#L172)). Общий flock сериализует операции, но не различает владельцев с совпавшим label.

**Статический свидетель, без запуска scheduler.** Для двух проектов из сценария штатный builder даёт разные команды, но одинаковый owner marker:

```text
0 0 * * * cd '/srv/team-a/deployment' && ./clawforge 'backup' >/dev/null 2>&1 # clawforge-backup:deployment
0 0 * * * cd '/srv/team-b/deployment' && ./clawforge 'backup' >/dev/null 2>&1 # clawforge-backup:deployment
```

Это вывод, выведенный из builder/pattern, **не записанный или выполненный crontab**. Последовательность `A: backup install --apply` → `B: backup install --apply` удаляет первую строку pattern второго проекта и оставляет только B. Затем `A: backup uninstall --apply` удаляет оставшуюся строку B. Для watch механизм тот же. Гонка, malformed table, shell metacharacters и недоступный target не нужны.

На Windows→WSL у двух installed-проектов с тем же basename также совпадает Task Scheduler name. `schtasksCreateCommand()` добавляет `/f`, поэтому install второго заменяет action первого ([schedule.ts:291–300](../../tools/framework/commands/operate/schedule.ts#L291), [:366–377](../../tools/framework/commands/operate/schedule.ts#L366)); uninstall адресует тот же name ([schedule.ts:381–398](../../tools/framework/commands/operate/schedule.ts#L381)). Полный project root в Windows invocation ([schedule.ts:262–276](../../tools/framework/commands/operate/schedule.ts#L262)) делает action исполнимым, но не устраняет коллизию имени задачи.

**Последствие.** У A без ошибки исчезают регулярные backup либо мониторинг; uninstall из A способен выключить расписание B. Оба приложения продолжают существовать и могут быть healthy, поэтому это не диагностируется самим успешным install. Для SSH watch metadata каждого root ещё может сохранять свой interval при единственной оставшейся cron-строке. Фактическая потеря пользовательских данных не утверждается: P2 основан на удалении другого supported задания, а не на предполагаемой последующей аварии без backup.

**Разумное исправление.** Разделить человекочитаемое имя deployment и identity задания в общем scheduler account. В owner marker/task name включить устойчивую различающую identity реально исполняемого deployment — например digest канонического execution root с учётом execution location; одинаковую для install/uninstall и одинаково выводимую оператором и target-side invocation. Ownership predicate должен проверять именно эту identity, а не произвольный cwd под совпавшим basename. Не менять имена Docker project или требовать переименования consumer repositories как обходной путь. Старое задание без такой identity нельзя безусловно считать принадлежащим текущему root: разбирать совпадение invocation либо отказывать неоднозначной миграции до удаления.

**Acceptance после исправления:**

1. Два реальных отдельных deployment roots с одинаковым basename, но независимыми Compose/data coordinates. Последовательная установка backup для обоих оставляет **две** корректные команды; повторная установка A меняет только A; uninstall A оставляет B byte-identical. Повторить для watch и с разными interval.
2. В Windows scheduler scenario `/tn` A и B различается; overwrite и delete из A адресуют только A, а `/tr` каждого по-прежнему содержит его правильный root/entry. Не ограничиваться парой разных basename: она не ловит этот дефект.
3. Install/uninstall одного и того же SSH deployment с operator и target используют согласованную identity. Проверить сохранение unrelated/manual cron lines и безопасный переход от прежних markers.
4. Account-wide flock из раунда 16 продолжает защищать весь read/merge/write. Он решает другую задачу и не должен исчезать при замене ownership key.

**Не повтор R12/R16.** Ранее закрыты substring matching чужих markers и lost update при параллельной записи разных deployment. Здесь полный исправленный pattern всё равно совпадает для двух разных roots, а ошибка возникает при строго последовательных операциях под исправленным flock.

## Корректность исправлений раунда 19

Ниже «закрыт» означает: **прежний конкретный механизм устранён в прочитанном коде**, а не «в этом раунде повторён живой прогон».

| Механизм | Текущий статический результат и evidence |
| --- | --- |
| R19-01: прежний validator image | Закрыт. `recreateWithImage` строит target settings и устанавливает их в runtime до mutating Compose exec ([compose-operations.ts:261–269](../../tools/framework/runtime/docker/compose-operations.ts#L261)); дальнейший `runOneOff` берёт актуальные runtime settings. После doctor проверяется running digest до durable pin ([lifecycle.ts:564–572](../../tools/framework/commands/lifecycle/lifecycle.ts#L564)). Existing DockerRuntime scenario различает doctor A/B и durable pin during validation ([upgrade.check.ts:343–351](../../tools/checks/runtime/connection-facts/upgrade.check.ts#L343), [:372–403](../../tools/checks/runtime/connection-facts/upgrade.check.ts#L372)). |
| R19-02: исключение обходит rollback | Закрыт. Общая compensation-область охватывает recreation, health, validator, identity и pin; `mutationStarted` выставляется фактическим before-exec callback, поэтому env preparation failure до вызова Compose не изображается как уже выполненная мутация ([lifecycle.ts:551–580](../../tools/framework/commands/lifecycle/lifecycle.ts#L551), [compose-operations.ts:194–202](../../tools/framework/runtime/docker/compose-operations.ts#L194)). Migration restore выполняется `noStart`, затем recreates previous digest; failed compensation сохраняет обе причины ([lifecycle.ts:498–529](../../tools/framework/commands/lifecycle/lifecycle.ts#L498)). Existing scenarios включают cleanup/validator/pin/failed rollback, preparation и migration exception ([upgrade.check.ts:379–407](../../tools/checks/runtime/connection-facts/upgrade.check.ts#L379)). |
| R19-03: failed inventory превращается в empty pins | Закрыт. Parser сохраняет unknown как `undefined` и добавляет `CLI_READ_FAILED` ([extensions.ts:46–86](../../tools/framework/commands/management/extensions.ts#L46)); composition не подставляет `[]` ([lock.ts:139–164](../../tools/framework/commands/management/lock.ts#L139)). Writer отказывает до `writeFile`, check включает inventory problems ([lock.ts:298–320](../../tools/framework/commands/management/lock.ts#L298)). Existing cases проверяют failed/malformed/partial inventory и точные прежние bytes ([lock.check.ts:346–382](../../tools/checks/release/release/lock.check.ts#L346)), а successful empty arrays сохраняют смысл настоящего удаления. |
| R19-04: status читает другую историю SSH schedule | Закрыт. Execution source и metadata выводятся из remotePath/deployment; operator SSH cycles имеют отдельный `watch-operator.json`; status читает scheduled history через transport и при отказе возвращает unknown, без подстановки local ([watch/state.ts:17–18](../../tools/framework/commands/operate/watch/state.ts#L17), [:61–107](../../tools/framework/commands/operate/watch/state.ts#L61), [watch/status.ts:41–78](../../tools/framework/commands/operate/watch/status.ts#L41)). Existing двух-filesystem scenario покрывает remote success/error/pending, interval overlay и недоступность source ([status.check.ts:219–280](../../tools/checks/runtime/watch/status.check.ts#L219)). R20-02 — отдельная ownership collision расписания, не возврат local-history ошибки. |
| R19-05: бинарный offsite archive декодируется UTF-8 | Закрыт в runnable примере. Target-side base64 пересекает transport как ASCII; operator декодирует в `Buffer`, пишет bytes и сравнивает SHA-256 именно записанной копии с source ([data-and-backups.md:211–235](../guide/data-and-backups.md#L211)). Объявлены target prerequisites, text-only nature `readFile`/captured exec и memory bound ([data-and-backups.md:250–261](../guide/data-and-backups.md#L250), [exec.ts:87–90](../../tools/framework/runtime/transport/exec.ts#L87)). |
| R19-06: два одинаковых transition-alert | Закрыт для прежнего interleaving. Local history exclusion удерживается через previous-state read, alert/heartbeat и persistence; конкурирующая операция получает busy и не делает POST ([watch/state.ts:21–58](../../tools/framework/commands/operate/watch/state.ts#L21), [watch/check.ts:259–284](../../tools/framework/commands/operate/watch/check.ts#L259)). Config/heartbeat diagnostic writes также берут этот lock. Existing controlled runners задерживают первый POST, проверяют отсутствие второго, последующий unchanged cycle, recovery и pending retry ([check.check.ts:535–565](../../tools/checks/runtime/watch/check.check.ts#L535)). |

Сессионный статус раунда 19 отдельно сообщает scoped smoke и результаты проверок с ограничениями: DockerRuntime/Compose с управляемым transport, настоящий webhook, binary archive/base64 и shell serialization; живой Docker/SSH target не запускался. Здесь это именно ранее сообщённое evidence. Оно не превращает static observations этого отчёта в dynamic verification.

## Framework в целом: удобство, полнота, качество

Обзор не ограничен diff раунда 19. Пройдены следующие consumer-facing цепочки:

| Область | Что изучено и вывод |
| --- | --- |
| Source и installed entry points | Выбор deployment, installed project root, help/unknown args, preparation до Context; общий dispatcher и declared arguments. Самостоятельная установка поддерживается, поэтому её глобальные scheduler names должны различать разные project roots — R20-02. |
| CLI и оба MCP surfaces | Argv/schema/confirmation, captured machine document и masking, отдельная control-сессия и разговорный bridge. Наличие tools/list не доказывает работоспособность второго протокольного канала — R20-01. |
| Context/settings/transports | Пересборка settings после изменения `.env`, target-change refusal, runtime transient image и subprocess input/output. Различие operator/target coordinates в API обозначено; оставшийся доказанный разрыв — duplex stdin, не отсутствие ещё одного transport. |
| Inspect/doctor/plan/apply | Unknown live inventory, advisory actions вместо автоматического принятия drift, declaration checksum под lock, post-run confirmation и operation journal; acceptance subject/runtime/security binding. Сверены current parsers/pinning из раунда 19 и ранее закрытые redaction/security-gate механизмы. |
| Secrets и privacy | Prospective requirements, private target publication, repo-env recreation и confirmation по именам; rollback использует private writer; archive grep допускает только завершённые codes 0/1. Действующие values не читались. Новых доказанных P0/P1 здесь не добавлено. |
| Data lifecycle | Backup staging/publish/compensation, pull archive+sidecars, restore prevalidation/layout и rollback, truthful started outcome, upgrade new-image validation/rollback и offsite hook. Полнота конкретного upstream native archive не предполагалась. |
| Recipes/agent provisioning/sets | Hook quiesce/resume failure path, preflight ownership ledger, provisioning и сохранение memory, trial isolation/teardown, runtime-bound immutable receipts и model opt-in. Рассмотрено как существующий инструмент установки/приёмки, а не повод добавлять новую orchestration систему. |
| Remote deploy | Portable-content refusals, нестандартный recipesDir source root и private roots, guarded rsync destinations и раздельная доставка framework/config/recipes. Ранее закрытые boundaries не заявляются вновь. |
| Monitoring/operator recovery | Watch transition/pending/heartbeat/status, SSH history location, scheduler account transaction, incident продолжает rotate после evidence failure. Удобство основного operator loop зависит от существования именно собственного расписания, а не только успешного `install`. |

**Удобство.** Набор команд покрывает основные operator-задачи: подготовку/запуск, наблюдение и устранение drift, управление секретами, архивы/восстановление, воспроизводимые set artifacts, рецепты/агентов, deploy, scheduling и incident response. Есть полезные boundaries: destructive confirmation в MCP, явные unknown/not-checked outcomes, deliberate re-pin и advisory supply-chain actions. В этом раунде не обнаружен новый доказательный пробел, требующий ещё одной команды лишь ради полноты списка. Два P2 — проблемы работоспособности уже заявленных инструментов.

**Качество/maintainability.** Общие argument declarations, общий private publication путь и общий account scheduler transaction предпочтительнее второй реализации того же поведения. Найденные дефекты связаны с потерей семантики на общей границе: generic output-streaming helper не является stdio-protocol relay, а basename не является уникальным owner key в общем scheduler. Исправлять следует эти границы, не добавляя command-specific retries, скрытого fallback на другой deployment или ещё одного dispatch. Размер функций, количество комментариев, длина help строк и вкусовые naming preferences не засчитаны P3.

## Пределы обзора и результат раунда

- Это статический проход ключевых framework/CLI/MCP/operator workflows, **не построчное доказательство корректности каждого файла и не сертификация всех dependency combinations**.
- Новые findings установлены по полной достижимой цепочке вызовов/условий и scheduler ownership predicate. Пример cron выше — вычисленный статический свидетель; scheduler не изменялся.
- Ни Docker Compose, ни Task Scheduler/cron, ни WSL/SSH target, ни generated MCP process exchange в этом раунде не запускались. Acceptance предназначен для фазы исправлений у основного исполнителя.
- Не установлены конкретная реакция upstream MCP process на EOF, частота событий на живых hosts и поведение reverse dependencies конкретной версии Compose. В severity эти непроверенные эффекты не включены; stale-helper гипотеза после recreation отдельной находкой не объявлена.
- Полный Windows→WSL→Docker путь, прежние capability-пропуски и гипотеза полноты upstream native backup для ссылок/пустых каталогов остаются известными пределами, не новыми bugs раунда 20.
- По прочитанному коду шесть механизмов раунда 19 закрыты; новых подтверждённых P0/P1/P3 не добавлено. До отсутствия всех P0–P3 review-fix loop **ещё не завершён**: остаются **R20-01 и R20-02 (два P2)**. Исходники в этом read-only раунде не менялись.
