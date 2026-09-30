# ClawForge — статическое ревью XS, раунд 21

Дата: 2026-09-30. Проверенная база: `main` @ `becd35d`, после интеграции исправлений раунда 20. Перед началом рабочее дерево было чистым. Метод — чтение текущих исходников, consumer-документации, существующих checks **как исходников** и локальной истории изменений `0c2c1a0..becd35d`. Приложение, checks/tests, typecheck, build, lint, formatters, smoke, services, контейнеры и нагрузка **не запускались**. Живые секреты и пользовательские deployment-файлы не читались. `/rush` и дополнительные агенты не использовались. Единственное изменение и предмет локального коммита — этот отчёт.

Прочитаны [отчёт раунда 20](review-2026-09-30-xs-round-20.md), [его сессионный статус](session-tasks-2026-09-30-round-20.md), [статус раунда 19](session-tasks-2026-09-30-round-19.md); сопоставлен индекс механизмов прежних XS-раундов 10–19 и доступных внутренних ревью. Закрытые findings не заявлены повторно. Переданные результаты динамической проверки раунда 20 приняты как **ранее полученное evidence**, а не как прогоны этого ревью.

Шкала: **P0** — безусловный критический ущерб; **P1** — утечка секретов или потеря данных в поддерживаемом сценарии; **P2** — существенное нарушение поддерживаемого поведения; **P3** — меньший эксплуатационный дефект. Новые статически подтверждаемые находки: **P0 = 0, P1 = 0, P2 = 1, P3 = 1**. Ни одна новая находка не выдаётся за динамически воспроизведённую.

## Сводка

| ID | Приоритет | Нарушенный supported workflow |
| --- | --- | --- |
| R21-01 | P2 | Независимые installed deployments с одинаковым basename управляют одним и тем же recipe Compose project, несмотря на разные `OC_COMPOSE_PROJECT` |
| R21-02 | P3 | CLI-нормализация и MCP-реконструкция argv теряют буквальный смысл option value, совпадающего с объявленной опцией; штатный `logs --grep=--tail` отказывается вместо фильтрации |

Два первоначальных механизма раунда 20 устранены в прочитанных ветвях: live MCP stdin теперь передаётся явным protocol relay, scheduler ownership больше не определяется basename. R21-01 относится к **другому namespace — recipe stacks в Docker**, а не к исправленному scheduler. R21-02 относится к сохранению границы option/value, а не к прежнему молчаливому поглощению отсутствующего значения.

## Подтверждённые находки

### R21-01 / P2 — recipe stacks разных deployment продолжают делить basename-based Docker project

**Поддерживаемый сценарий.** На одном Linux Docker target два независимых consumer-проекта `/srv/team-a/deployment` и `/srv/team-b/deployment`, созданные штатным installed `clawforge init`. У них разные `OC_DATA_DIR`, gateway ports и `OC_COMPOSE_PROJECT=team-a` / `team-b`. В каждом есть service recipe `cache` с одинаковым именем Compose service, без host-published ports, но со своим bind-mounted каталогом и своим содержимым. Hooks, ручной `container_name`, external volumes и параллельные операции не нужны.

Installed-mode выбирает полный consumer root и не требует глобальной уникальности basename: [bin.ts:28–35](../tools/framework/entry/bin.ts#L28), [bin.ts:65–75](../tools/framework/entry/bin.ts#L65); установка в отдельном repository опубликована в [deploy-and-mcp.md:89–107](guide/deploy-and-mcp.md#L89). `OC_COMPOSE_PROJECT` — поддерживаемый явный Docker project override: [.env.example:30–35](../tools/framework/.env.example#L30), [context.ts:74–76](../tools/framework/core/context.ts#L74), [deployment.ts:58–84](../tools/framework/runtime/deployment.ts#L58). Наличие двух roots с одинаковым basename уже прямо допускается текущей [scheduler-документацией:177–183](guide/monitoring-and-access.md#L177). Операции service recipes обещают собственный Compose project: [recipes.md:6–34](guide/recipes.md#L6).

**Цепочка кода и статический свидетель:**

1. [deployment.ts:50–55](../tools/framework/runtime/deployment.ts#L50) возвращает `deploymentName() = basename(deploymentDir())`, то есть `deployment` для A и B, независимо от `OC_COMPOSE_PROJECT`.
2. [recipe.ts:115–119](../tools/framework/service/recipe.ts#L115) строит `projectName(appName, recipe) = appName + "-recipe-" + recipe`.
3. [recipe/actions.ts:30–33](../tools/framework/commands/management/recipe/actions.ts#L30) передаёт `projectName(deploymentName(), name)` в `ctx.runtime.stack`. Для обоих проектов recipe `cache` получает **одну и ту же** identity `deployment-recipe-cache`, хотя gateway projects — `team-a` и `team-b`.
4. [runtime-docker.ts:213–222](../tools/framework/runtime/docker/runtime-docker.ts#L213) передаёт этот project без добавления deployment namespace. [side-stack.ts:61–70](../tools/framework/runtime/docker/side-stack.ts#L61) использует его как явный `docker compose --project-name`, а definition/project-directory и env-file берёт из соответствующего A или B. Разные cwd и `.env` здесь меняют конфигурацию **одного** Docker project, а не разделяют его identity.
5. Install вызывает `build` и `up` именно этой stack ([actions.ts:411–445](../tools/framework/commands/management/recipe/actions.ts#L411)); remove вызывает `down` ([actions.ts:472–476](../tools/framework/commands/management/recipe/actions.ts#L472), [side-stack.ts:78–91](../tools/framework/runtime/docker/side-stack.ts#L78)). `isRunning` также различает владельцев только по тому же Compose project label ([side-stack.ts:92–101](../tools/framework/runtime/docker/side-stack.ts#L92)).

Получаемые аргументы, **выведенные из builders, не выполненные команды**:

```text
A: docker compose … --project-name deployment-recipe-cache --file /srv/team-a/deployment/recipes/cache/compose.yml --project-directory /srv/team-a/deployment/recipes/cache … up --detach
B: docker compose … --project-name deployment-recipe-cache --file /srv/team-b/deployment/recipes/cache/compose.yml --project-directory /srv/team-b/deployment/recipes/cache … up --detach
A remove: docker compose … --project-name deployment-recipe-cache --file /srv/team-a/deployment/recipes/cache/compose.yml … down
```

`…` обозначает остальные builder arguments (в частности, отдельный private env-file), а не скрытую проверку ownership: вся runtime-цепочка project показана выше. Имена gateway и разные recipe definition paths в переданной Docker identity не участвуют.

**Механизм и последствия.** Последовательность `A: recipe install cache` → `B: recipe install cache` обращается к одному namespace; при одинаковом service name B сходится к своей конфигурации в project A, вместо создания независимой stack. `A: recipe remove cache` затем адресует project с сервисом B. До мутации нет проверки, что project принадлежит именно этому execution root. Даже read-only `status`/`logs` не различают такие deployment. Для доказанного P2 достаточно неверного адресата lifecycle и наблюдения; фактическая потеря volume data или утечка credentials в этом отчёте **не утверждается**.

Это затрагивает и backup-discovery: [recipe/index.ts:69–101](../tools/framework/commands/management/recipe/index.ts#L69) использует тот же basename project для валидного recipe и fallback probe broken manifest. Наличие stack другого root может считаться наличием собственной running stack. Instance lock не решает ошибку identity: он привязан к data coordinates ([lock-claim.ts:70–76](../tools/framework/runtime/lock/lock-claim.ts#L70)), и дефект возникает даже при строго последовательных командах.

**Разумное исправление.** Recipe project должен выводиться из реального Docker namespace deployment, учитывая `OC_COMPOSE_PROJECT`, а не только из human basename. Один builder должен обслуживать install/remove/status/logs/diagnose и backup-discovery, включая broken-manifest probe. Сохранить разделение gateway и recipe projects. При переходе уже существующая basename stack не становится доказанно принадлежащей текущему root только по старому label: неоднозначную старую stack нельзя автоматически остановить или удалить. Нужна явная проверка её связи с deployment либо отказ с безопасным способом operator cutover; не оставлять постоянный alias, продолжающий адресовать чужой project.

**Acceptance после исправления:**

1. Два отдельных installed roots с одинаковым basename и разными действительными gateway Compose/data coordinates, в обоих service recipe `cache` с одинаковым service name и различимыми A/B bind data. Install обоих сохраняет две независимые работающие stacks; каждый `status`/`logs` относится к своему сервису. Проверить фактическую принадлежность контейнеров/данных, а не только неравенство строки `projectName`.
2. Reinstall B не меняет stack A; remove A оставляет контейнеры и данные B неизменными. Отдельно проверить `--volumes` на принадлежащем A recipe volume: volume B не удаляется.
3. Backup-discovery/quiesce каждого root выбирает только его stack; broken recipe manifest в A не делает running stack B доказательством running stack A.
4. Дефолтный single-deployment workflow остаётся работоспособным. Переход от существующих project names не сносит неоднозначную чужую stack и не сообщает независимую установку, продолжая обслуживать старый общий project. Реальные Compose/container checks относятся к фазе исправления, не выполнены здесь.

**Отличие от R20-02.** Account crontab/Task Scheduler уже используют root digest. Их исправление не изменило `service/recipe.ts` или перечисленные recipe stack callers. Здесь объект — Docker Compose project с lifecycle/data mounts; scheduler вообще не нужен.

### R21-02 / P3 — option/value binding теряется перед общим parser в CLI и MCP

**Поддерживаемый контракт.** `logs --grep <pattern>` принимает JS RegExp и работает как с bounded log read, так и с attended stream: [openclawCommands.lifecycle.ts:100–115](../tools/framework/commands/interface/groups/openclawCommands.lifecycle.ts#L100), [lifecycle.ts:296–320](../tools/framework/commands/lifecycle/lifecycle.ts#L296). `--tail` — корректный regex, означающий поиск буквальной строки `--tail`; это не malformed input. Общая CLI-документация прямо обещает inline форму для значения, которое начинается с `-`: [commands.md:24–29](guide/commands.md#L24). MCP публикует для `grep` string option и принимает его как таковое: [schema.ts:202–215](../tools/framework/integration/mcp/schema.ts#L202), [schema.ts:236–270](../tools/framework/integration/mcp/schema.ts#L236).

**Конкретный сценарий.** У bootstrapped deployment в логах есть diagnostic line, содержащая текст опции `--tail`, и другая строка без него. Оператор хочет получить только первую строку:

```text
CLI: ./clawforge logs --grep=--tail
MCP tools/call: name="logs", arguments={"grep":"--tail"}
```

Ни live logs, ни эти вызовы в раунде 21 не запускались. Ниже — статически выводимые преобразования точных arguments.

**Цепочка CLI:**

- `runApp` вызывает `splitInlineOptions(command, args)` до command runner: [cli.ts:121–146](../tools/framework/entry/cli.ts#L121).
- [splitInlineOptions():39–49](../tools/framework/entry/cli.ts#L39) превращает один атом `--grep=--tail` в два: `--grep`, `--tail`. Признак «правая часть `=` является буквальным value» теряется.
- [lifecycle.ts:40–44](../tools/framework/commands/lifecycle/lifecycle.ts#L40) объявляет `tail` и `grep` как options. [arguments.ts:174–176](../tools/framework/core/arguments.ts#L174) теперь видит после `--grep` другую объявленную опцию и отказывает как missing value. До `readLogs`/фильтра дело не доходит.
- Сам parser **правильно** принимает значение из inline формы напрямую: [arguments.ts:139–175](../tools/framework/core/arguments.ts#L139) обрабатывает `inlineValue` до проверки следующего token. Ошибка находится в предшествующей потере этой формы, не в защите от действительно пропущенного значения.

**Цепочка MCP:** `validate` принимает `grep: "--tail"`, затем [toArgv():287–302](../tools/framework/integration/mcp/schema.ts#L287) также создаёт `--grep`, `--tail`. [server.ts:282–294](../tools/framework/integration/mcp/server.ts#L282) передаёт этот argv в command capture, а [server.ts:101–109](../tools/framework/integration/mcp/server.ts#L101) вызывает `logs` с ним. Тот же parser отказывает. Изменить shell quoting в MCP невозможно и не нужно: string value уже был однозначно указан в JSON, но framework снова превратил его в неоднозначный CLI token.

**Последствие.** Валидный штатный фильтр нельзя передать заявленной буквальной формой через оба interfaces. Приоритет P3: это ограниченный diagnostic/automation дефект, не потеря данных и не запрет всех log filters. Regex-обход вроде `[-][-]tail` возможен, но не исправляет общий контракт literal value.

**Граница существующего evidence.** [arguments.check.ts:256–279](../tools/checks/foundation/core/arguments.check.ts#L256) проверяет parser отдельно с `--grep=-x`, а [arguments.check.ts:375–378](../tools/checks/foundation/core/arguments.check.ts#L375) закрепляет split обычного `--set=x`. Значение `-x` не совпадает с объявленной опцией и потому не ловит эту потерю семантики. Это чтение coverage, не результат запуска check. Прежний U6 про `--grep --flag` **без значения** не открывается вновь: отказ той неоднозначной записи корректен; здесь binding явно дан через `=` или JSON.

**Разумное исправление.** Сохранить literal option/value binding до parser и всех raw argv readers. Нельзя просто ослабить missing-value guard: тогда вернётся прежнее поглощение следующего флага. Для CLI нормализация должна учитывать grammar, а не раскладывать `=value` с потерей информации; для MCP option values должны кодироваться однозначно. Обновить affected argv readers, если выбран общий parsed representation. Не чинить только `logs` через special case строки `--tail`.

**Acceptance после исправления:**

1. Через настоящий CLI dispatch на bootstrapped controlled deployment вызвать `logs --grep=--tail`; заданный bounded log содержит одну matching и одну nonmatching строку. Результат — ровно matching line, без refusal. Повторить с буквальным pattern `--tail=5`, который также не должен становиться новой опцией.
2. Через настоящую `control-mcp` JSON-RPC цепочку передать тот же `grep` string; tool возвращает тот же отфильтрованный log, без `isError`. Не ограничиваться сравнением массива, возвращаемого `toArgv`.
3. Отдельное `logs --grep --tail 5` по-прежнему отказывает как отсутствующее значение. Обычные inline options других команд и passthrough arguments `cli`/`exec` не меняют смысл; bare `--` остаётся grammar boundary. Incidental assertions конкретной раскладки argv не перепинивать: acceptance проверяет consumer result/refusal.

## Correctness закрытий раунда 20

«Закрыт» ниже означает: **прежний конкретный механизм устранён в прочитанном коде**. Это не заявление о новом динамическом прогоне.

| Механизм | Текущий статический результат |
| --- | --- |
| R20-01: MCP client stdin превращался в EOF | Закрыт. `mcpServe` явно включает `stdioProtocol` и для helper, и для fallback ([mcp.ts:39–56](../tools/framework/commands/management/credentials/mcp.ts#L39)). Helper передаёт mode в transport и не включает `-t` ([helper-container.ts:39–59](../tools/framework/runtime/docker/helper-container.ts#L39)); one-off принудительно включает `-T` и передаёт mode ([compose-operations.ts:275–292](../tools/framework/runtime/docker/compose-operations.ts#L275)). |
| Протокольный stdout мог фильтроваться/попасть в progress sink | В protocol mode используются byte pipes без UTF-8 decoding/noise filter/captured stdout, stderr идёт отдельно и диагностический tail ограничен ([exec.ts:140–176](../tools/framework/runtime/transport/exec.ts#L140)). `streamToTerminal` в этом mode исключён: прежняя Windows/MSYS pipe-защита не снята. |
| Relay lifetime и обычный finite input | `process.stdin.pipe(child.stdin)` используется только в protocol mode; client EOF завершает pipe, child stdin/child close останавливает relay; protocol EPIPE учитывается отдельно ([exec.ts:199–204](../tools/framework/runtime/transport/exec.ts#L199), [exec.ts:218–269](../tools/framework/runtime/transport/exec.ts#L218)). Сочетание protocol + finite input отклоняется, а явно заданный `input`, включая `""`, по-прежнему завершает дочерний stdin. WSL/SSH сохраняют mode при delegation в `spawnLocal` ([wsl.ts:33–39](../tools/framework/runtime/transport/wsl.ts#L33), [ssh.ts:61–68](../tools/framework/runtime/transport/ssh.ts#L61)). |
| R20-02: scheduler ownership по basename | Закрыт. `schedulerIdentity` хеширует physical execution root/location; SSH получает root на target, POSIX local использует `realpath`, Windows включает transport location ([schedule.ts:31–52](../tools/framework/commands/operate/schedule.ts#L31)). Install/uninstall backup/watch используют эту identity ([backup/install.ts:76–120](../tools/framework/commands/lifecycle/backup/install.ts#L76), [watch/install.ts:110–156](../tools/framework/commands/operate/watch/install.ts#L110)). Windows create/delete адресуют тот же keyed task name, action сохраняет installed project root ([schedule.ts:300–314](../tools/framework/commands/operate/schedule.ts#L300), [schedule.ts:404–435](../tools/framework/commands/operate/schedule.ts#L404)). |
| Legacy scheduler migration и serialization | Старые cron rows мигрируются только при полном совпадении own invocation, не по basename ([schedule.ts:132–148](../tools/framework/commands/operate/schedule.ts#L132)); account-wide flock по-прежнему охватывает read/filter/write ([schedule.ts:181–226](../tools/framework/commands/operate/schedule.ts#L181)). Ambiguous старые Windows tasks намеренно не удаляются автоматически; безопасный manual cutover и риск duplicate execution явно описаны ([monitoring-and-access.md:183–188](guide/monitoring-and-access.md#L183), [data-and-backups.md:167–171](guide/data-and-backups.md#L167)). Это не объявлено новой находкой. |
| Bootstrap precedence после новых target identity queries | В supported POSIX/SSH `install --apply` сначала проверяется cron syntax, затем `requireBootstrapped`, только затем target identity и guarded mutation ([backup/install.ts:76–95](../tools/framework/commands/lifecycle/backup/install.ts#L76), [watch/install.ts:110–129](../tools/framework/commands/operate/watch/install.ts#L110)). Новый ownership query не обходит этот прежний preflight. |

**Сопоставление с переданным verification.** [session-tasks20](session-tasks-2026-09-30-round-20.md#L10) сообщает reproduced-before, Windows targeted 18 check-файлов / 4 capability-пропуска, Linux targeted 4 check-файла и typecheck/Oxlint, настоящие pipe exchanges через executable Docker shim, canonical operator/target identity и настоящий account flock. Общий Windows-набор: 180 из 181 выполненных файлов прошли, 6 capability-пропусков; единственный bootstrap precedence отказ исправлен, адресный повтор 4 файлов и typecheck/Oxlint/build прошли. Эти сведения не повторены здесь и не превращены в «весь набор заново зелёный».

В прочитанном [mcp-stdio.check.ts:20–42, 70–138](../tools/checks/runtime/transport/mcp-stdio.check.ts#L20) действительно есть process/pipe boundary, helper/fallback, второй ответ до client EOF, exact Unicode/CRLF, separate stderr, early child close и finite empty input. [identity.check.ts:50–96, 101–138](../tools/checks/runtime/schedule/identity.check.ts#L50) различает реальные отдельные roots с одинаковым basename, reinstallation/removal и exact legacy invocation; Windows часть использует scheduler runner seam. Это подтверждает соответствие исходников заявленному типу прежней проверки, **не availability живого upstream MCP, Windows Task Scheduler, WSL/Docker или SSH host**.

## Framework в целом: удобство, полнота инструментов, качество

Обзор не ограничен round20 diff. Пройдены consumer CLI/MCP/operator paths; ниже — конкретные границы, на которых основана оценка, без обещания построчного аудита всего repository.

| Область | Статическая оценка и evidence |
| --- | --- |
| Source / installed entry, help и grammar | Installed root явно выбирается до загрузки app; help доступен до Context. Shared declarations используются CLI/MCP, unknown arguments не молча принимаются. Но representation option values между этими слоями теряет смысл — R21-02. [bin.ts:28–75](../tools/framework/entry/bin.ts#L28), [arguments.ts:114–195](../tools/framework/core/arguments.ts#L114), [cli.ts:31–49, 102–146](../tools/framework/entry/cli.ts#L31). |
| MCP completeness и безопасность operator calls | Отдельный `help` позволяет не вкладывать весь manual в каждый tool description; destructive calls имеют explicit confirmation, machine output и ошибки маскируются; ping/list/cancellation не ждут command queue. Running cancellation не обещает abort мутации: эта граница открыто обозначена в коде. Channel bridge и control server разделены. [server.ts:37–50, 266–340, 383–484](../tools/framework/integration/mcp/server.ts#L266), [schema.ts:99–152](../tools/framework/integration/mcp/schema.ts#L99). |
| Context и target coordinates | После собственной записи `.env` apply пересобирает settings; смена target coordinates останавливает оставшиеся steps, не продолжает на старом lock. [context.ts:125–192](../tools/framework/core/context.ts#L125), [apply.ts:175–233](../tools/framework/commands/orchestration/apply.ts#L175). |
| Inspect / doctor / plan / apply | Public inspection очищает config/egress; unreachable сохраняется как finding, failed CLI read блокирует mutation, declaration checksum перепроверяется под lock, outcome основан на повторном inspection. [gather.ts:57–96, 369–385](../tools/framework/commands/orchestration/inspect/gather.ts#L57), [apply.ts:393–398, 468–490](../tools/framework/commands/orchestration/apply.ts#L393). Новых подтверждённых P0/P1 на этих прочитанных границах не добавлено. |
| Recipes и lifecycle isolation | Есть install/remove/status/logs, import/new и app-owned hooks; readiness удерживает required services в grace window, не удовлетворяется одним удачным poll. Backup требует paired quiesce/resume и собирает compensation failures. Но recipe ownership всё ещё теряет различие independent roots — R21-01. [actions.ts:132–185, 411–476](../tools/framework/commands/management/recipe/actions.ts#L132), [lifecycle.ts:81–143](../tools/framework/commands/management/recipe/lifecycle.ts#L81). |
| Backup / restore / upgrade | Archive сначала пишется в private staging, проверяется до публикации; gateway/recipe compensation отделена от основного failure. Restore проверяет ancestry/layout, сохраняет data aside и честно сообщает missing-secrets/no-start. Upgrade валидирует target image до durable pin и компенсирует exception после начала recreation. [backup/index.ts:370–528](../tools/framework/commands/lifecycle/backup/index.ts#L370), [restore/index.ts:430–548](../tools/framework/commands/lifecycle/restore/index.ts#L430), [lifecycle.ts:498–580](../tools/framework/commands/lifecycle/lifecycle.ts#L498). Полнота native archive конкретного upstream release здесь не сертифицирована. |
| Secrets, sharing и deploy | Private writers и отдельные repo/target locations существуют; recreated repo-env подтверждается без печати values. Share allow-list и deploy source-root/private-content refusals не заменены «угадыванием» exclusions. [secrets.ts:149–188](../tools/framework/commands/management/secrets.ts#L149), [profile.ts:197–207](../tools/framework/service/archive/profile.ts#L197), [deploy/refusals.ts:17–98](../tools/framework/commands/management/deploy/refusals.ts#L17), [deploy/sync.ts:35–123](../tools/framework/commands/management/deploy/sync.ts#L35). |
| Sets, trials и acceptance evidence | Trial секреты читаются до смены deployment, live read failure не подставляет stale store; private trial `.env` использует общий writer. Receipt связывает subject с runtime до/после и security gate, не только с количеством passed checks. [set-try.ts:161–187, 264–306](../tools/framework/commands/sets/set-try.ts#L161), [accept.ts:444–488](../tools/framework/commands/orchestration/accept.ts#L444), [evidence.ts:38–91](../tools/framework/set/artifacts/evidence.ts#L38). |
| Monitoring / scheduling / recovery | Watch history разделяет operator SSH cycles и scheduled target state; transition delivery/persistence имеет local exclusion, scheduler table — account exclusion. Install/uninstall после round20 адресуют root identity. [watch/state.ts:17–107](../tools/framework/commands/operate/watch/state.ts#L17), [watch/check.ts:259–311](../tools/framework/commands/operate/watch/check.ts#L259), [schedule.ts:181–242](../tools/framework/commands/operate/schedule.ts#L181). Эти locks решают разные ресурсы и не могут заменить исправление recipe identity. |
| Installed distribution | Builder выпускает JS и declaration imports для `node_modules`; hook loader выбирает `.ts`/`.js` по distribution mode. Прежний R16 installed hook-loader finding не заявлен вновь. [build-framework-package.ts:38–59, 103–126](../tools/build-framework-package.ts#L38), [hook-runtime.ts:49–60](../tools/framework/commands/management/recipe/hook-runtime.ts#L49). Package не собирался/не устанавливался в этом раунде. |

**Удобство.** Operator loop в целом имеет необходимые переходы: read-only prerequisites → bootstrap → inspect/doctor → plan/apply → operations/rollback; отдельно backup/restore/upgrade, secrets/recovery, recipes/agents/sets, scheduling/watch и incident response. README группирует выбор по намерению пользователя, а команда `help` даёт side-effect/ordering contract. Поэтому дополнительные команды ради количества не предложены. Новые замечания — к работоспособности и изоляции **существующих** tools: пользователь не должен помнить, что уникальность gateway ещё не означает уникальность recipe, или менять буквальный log pattern из-за внутренней argv-реконструкции.

**Качество и «пахнущий код».** Общие runtime/private publication/argument declarations полезны и уменьшают расхождения. В подтверждённых дефектах проблема не в размере функции, количестве комментариев или предпочитаемом naming: это неправильная domain identity и потеря семантики данных на общей границе. Исправление должно быть там, а не в специальных retries, command-specific regex substitutions или ослаблении missing-value guard. Стилистические предпочтения, assertions длины/wording/help/argv copies и известные infrastructure capability gaps не засчитаны P3.

## Пределы и результат

- Это новый **статический** обзор ключевых framework/consumer workflows и correctness round20, не proof каждого файла и не сертификация всех зависимостей/платформ.
- Две находки основаны на достижимых цепочках и точных identity/argv transformations. Примеры команд и inputs — статические свидетели, не выполненный вывод. Частота и наличие этих условий в пользовательских deployments не утверждаются.
- Docker Compose, generated MCP launchers, WSL/SSH, cron/Task Scheduler, webhooks, runtime logs и native archive compatibility здесь не запускались. Acceptance новых findings предназначен для фазы исправлений у основного исполнителя.
- Manual cutover неоднозначных старых Windows tasks уже документирован; он не объявлен новым bug. Полный живой Windows→WSL→Docker MCP путь, upstream server и SSH host остаются известными пределами прежнего verification, а не новыми findings.
- Прежние механизмы R20-01 и R20-02 закрыты по прочитанному коду и согласуются с ранее переданным evidence. Наличие новой recipe namespace collision не отменяет исправление scheduler.
- До состояния без P0–P3 review-fix loop **ещё не завершён**: остаются **R21-01 (P2)** и **R21-02 (P3)**. Исходники и checks не менялись; локальный commit содержит только этот отчёт.
