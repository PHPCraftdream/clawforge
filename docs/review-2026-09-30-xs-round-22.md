# ClawForge — статическое ревью XS, раунд 22

Дата: 2026-09-30. Проверенная база: `main` @ `2fe4682`, после интеграции и verification раунда 21. Начальное рабочее дерево было чистым. Метод — чтение актуальных исходников, consumer-документации, существующих checks **как исходников** и интегрированного diff `becd35d..2fe4682`. Приложение, checks/tests, typecheck, build, lint, formatters, smoke, services, контейнеры и нагрузка **не запускались**. Живые секреты и содержимое пользовательских deployment не читались. `/rush` и дополнительные агенты не использовались. Единственное изменение и предмет локального коммита — этот отчёт.

Прочитаны отчёты и сессионные статусы [раунда 19](review-2026-09-30-xs-round-19.md), [19: статус](session-tasks-2026-09-30-round-19.md), [раунда 20](review-2026-09-30-xs-round-20.md), [20: статус](session-tasks-2026-09-30-round-20.md), [раунда 21](review-2026-09-30-xs-round-21.md), [21: статус](session-tasks-2026-09-30-round-21.md); сопоставлен индекс прежних механизмов XS/XXS 10–18. Ни одна закрытая находка не переобъявлена без нового механизма. Результаты прежних динамических проверок ниже — **ранее сообщённое evidence**, не запуски этого раунда.

Шкала: **P0** — безусловный критический ущерб; **P1** — утечка секретов или потеря данных в поддерживаемом сценарии; **P2** — существенное нарушение поддерживаемого поведения; **P3** — меньший эксплуатационный дефект. Новые находки: **P0 = 0, P1 = 0, P2 = 2, P3 = 0**. Достижимость и преобразования подтверждены исходниками; сценарии и последствия помечены **[INFERENCE: статический вывод]**, поскольку они не воспроизводились здесь.

## Сводка

| ID | Приоритет | Нарушенный supported workflow |
| --- | --- | --- |
| R22-01 | P2 | Разные допустимые пары gateway namespace / recipe name получают одинаковый recipe Compose project; ownership guard блокирует установку второго независимого deployment |
| R22-02 | P2 | `restore` / `push` обнаруживают требуемый recipe cutover только после замены данных; исключение из нового ownership guard оставляет gateway остановленным без завершения восстановления |

Исходный same-basename механизм R21-01 устранён: recipe builder теперь учитывает реальный gateway namespace и проверяет Compose ownership. R22-01 — **не потеря `OC_COMPOSE_PROJECT`**, а неоднозначная сериализация двух разных компонентов identity. R22-02 — **не требование отключить безопасный отказ**, а слишком поздняя точка этого отказа в другом consumer — восстановлении данных. Буквальный option/value binding R21-02 и исправление readiness query budget статически согласованы с переданным verification.

## Новые подтверждённые находки

### R22-01 / P2 — составное recipe project name неоднозначно для допустимых namespace и recipe name

**Поддерживаемый контракт и ограничения.** Два независимых installed roots на одном Linux Docker target имеют разные data directories, gateway ports и явно разные `OC_COMPOSE_PROJECT`. [recipes.md:23–27](guide/recipes.md#L23) прямо связывает различие gateway namespaces с изоляцией recipes. Installed entry выбирает полный root ([bin.ts:28–35, 65–75](../tools/framework/entry/bin.ts#L28)); отсутствие общего basename не является препятствием для этого workflow.

Все используемые ниже имена проходят действительные проверки:

- `OC_COMPOSE_PROJECT` допускает lowercase letters, digits, `_` и `-`, без запрета подстроки `-recipe-`: [deployment.ts:58–70](../tools/framework/runtime/deployment.ts#L58).
- Recipe name допускает lowercase letters, digits и `-`, также без такого запрета; приведённые имена короче предела 64: [names.ts:8–21](../tools/framework/core/names.ts#L8).
- Context передаёт override из `.env` в общий namespace accessor: [context.ts:74–76](../tools/framework/core/context.ts#L74), [deployment.ts:79–84](../tools/framework/runtime/deployment.ts#L79).

**Конкретный статический свидетель.** Roots намеренно имеют **разные basename**, чтобы не повторять раунд 21:

| | Deployment A | Deployment B |
| --- | --- | --- |
| Root | `/srv/app-a` | `/srv/app-b` |
| `OC_DATA_DIR` | `/srv/app-a/data` | `/srv/app-b/data` |
| Gateway port | `21001` | `21002` |
| `OC_COMPOSE_PROJECT` | `team` | `team-recipe-cache` |
| Recipe directory | `recipes/cache-recipe-worker` | `recipes/worker` |
| Legacy project, если бы он существовал | `app-a-recipe-cache-recipe-worker` | `app-b-recipe-worker` |

Оба recipes — обычные валидные service recipes, без host-published ports, manual `container_name`, external volumes и hooks. В старых legacy projects контейнеров нет. Gateway namespaces действительно разные и не равны recipe project из следующего вычисления.

**Цепочка кода и точное преобразование.** [recipe.ts:117–129](../tools/framework/service/recipe.ts#L117) формирует identity конкатенацией:

```text
recipeProjectName = composeProjectName + "-recipe-" + recipeName
A: team              + -recipe- + cache-recipe-worker = team-recipe-cache-recipe-worker
B: team-recipe-cache + -recipe- + worker              = team-recipe-cache-recipe-worker
```

Это **[INFERENCE: статический вывод из builder, не результат вызова Docker]**. Один и тот же разделитель разрешён внутри обоих входных компонентов, поэтому кодирование пары не сохраняет её границы. Никакое различие data directory, port, basename или definition path в эту project identity не добавляется.

Далее:

1. `stackFor()` передаёт оба recipes в общий `recipeStack()` ([actions.ts:28–31](../tools/framework/commands/management/recipe/actions.ts#L28)); `DockerRuntime.stack()` передаёт project и ownership mode в `buildStack()` без другого identity discriminator ([runtime-docker.ts:213–223](../tools/framework/runtime/docker/runtime-docker.ts#L213)).
2. Install проверяет `stack.isRunning()` ещё до prepare/build ([actions.ts:411–439](../tools/framework/commands/management/recipe/actions.ts#L411)).
3. После успешной установки A `verifyOwnership()` для B выбирает контейнеры по **тому же** project label ([side-stack.ts:64–79](../tools/framework/runtime/docker/side-stack.ts#L64)). Legacy filters различаются и пусты, поэтому это не legacy-cutover отказ.
4. B сравнивает labels A с `/srv/app-b/recipes/worker/compose.yml` и его directory. Они не совпадают; guard бросает `not verifiably linked` ([side-stack.ts:80–88](../tools/framework/runtime/docker/side-stack.ts#L80)). Указание B своего `--file` при последующем Compose вызове уже ничего не меняет: до него выполнение не доходит.

**Последствие и приоритет.** **[INFERENCE: статический вывод]** Последовательная установка A → B не создаёт две независимые stacks: B отказывает как будто namespace занят чужой stack, хотя оператор выполнил опубликованное условие — разные действительные gateway namespaces. Если первой установить B, блокируется A. Read-only status/logs второго deployment также отказывают через тот же guard; backup-discovery использует этот же builder ([recipe/index.ts:68–98](../tools/framework/commands/management/recipe/index.ts#L68)). Guard корректно предотвращает чужую мутацию, поэтому **потеря данных, чтение чужих логов и автоматическое удаление A не заявлены**. P2 основан на невозможности supported independent installation/lifecycle, не на таком неподтверждённом ущербе.

**Разумное исправление.** Стабильно кодировать **пару** `(gateway namespace, recipe name)` без неоднозначных границ: однозначное кодирование компонентов либо digest однозначно сериализованной пары. Оставить один builder для lifecycle и discovery, не добавлять command-specific exceptions и не убирать ownership verification. Переход от уже созданных composite project names должен сохранять безопасную проверку/явный cutover, а не автоматически останавливать совпавший namespace. Простое добавление ещё одного обычного `-` не решает эту причину.

**Acceptance для фазы исправлений, здесь не выполнен:**

1. Два реальных roots из таблицы, разные gateway/data coordinates; install обоих даёт две независимые recipe stacks с различимыми A/B данными. Проверить фактические контейнеры/данные, не только неравенство строк builder.
2. Повторная установка и status/logs каждого относятся только к нему; remove A, в том числе с собственными volumes, сохраняет B. Backup-discovery/quiesce не считает вторую stack чужим owner текущего deployment.
3. Исходный same-basename acceptance раунда 21, default workflow и безопасный отказ для действительно foreign/legacy containers сохраняются. Новое имя не является alias старого ambiguous project.

**Отличие от закрытых механизмов.** R21-01 игнорировал `OC_COMPOSE_PROJECT` и сводил разные roots к одному basename. Здесь оба overrides используются, basename различаются, но два допустимых разбиения строки дают одну identity. R20-02 относится к scheduler account/root digest и не участвует в этой цепочке.

### R22-02 / P2 — ownership/cutover refusal в restore наступает после замены data tree, вне compensation scope

**Поддерживаемый сценарий.** После обновления framework у deployment `/srv/deployment` остаётся старый service recipe `cache`, созданный прежней версией под project `deployment-recipe-cache`. `.env` содержит `OC_COMPOSE_PROJECT=team-a`; новая identity — `team-a-recipe-cache`. В старом project есть хотя бы один **остановленный** контейнер с исходными Compose labels. На target доступен валидный заранее созданный full archive с правильным data root и пригодными secrets. Gateway работает; recipe manifest исправен; никаких hooks или native manifest не требуется.

Оператор вызывает штатное восстановление, например:

```text
./clawforge restore /srv/backups/deployment-full.tar.gz --force
```

Вариант `push <snapshot> --force` проходит через тот же restore API. Это **входы сценария, не выполненные команды**. Наличие старой stack после обновления прямо предусмотрено [recipes.md:29–62](guide/recipes.md#L29). Сам отказ её автоматически adopt/stop правилен и не является finding. Дефект — отказ после уже совершённой другой мутации.

**Цепочка кода и порядок действий:**

1. `restore()` разбирает аргументы и вызывает `restoreArchive()` под instance lock ([restore/index.ts:577–585, 620–643](../tools/framework/commands/lifecycle/restore/index.ts#L577)). `prepareRestore()` проверяет archive existence/layout/root, native manifest при наличии и data ancestry, но **не вызывает recipe discovery/ownership preflight** ([restore/index.ts:291–351](../tools/framework/commands/lifecycle/restore/index.ts#L291)).
2. `performRestore()` останавливает gateway, перемещает текущие данные aside, распаковывает архив, проверяет layout, импортирует privacy history и создаёт нужные subdirectories ([restore/index.ts:430–488](../tools/framework/commands/lifecycle/restore/index.ts#L430)). Его `catch` умеет восстановить старое состояние только для ошибок **внутри этого блока** ([restore/index.ts:489–492](../tools/framework/commands/lifecycle/restore/index.ts#L489)).
3. После успешного act phase `restoreArchive()` отдельно вызывает `reportRestoreOutcome()` — за пределами указанного `try/catch` ([restore/index.ts:551–564](../tools/framework/commands/lifecycle/restore/index.ts#L551)).
4. Первое действие report phase — `await runningRecipeStacks(ctx)` ([restore/index.ts:498–505](../tools/framework/commands/lifecycle/restore/index.ts#L498)). Эта функция для валидного recipe вызывает новый `recipeStack().isRunning()` ([recipe/index.ts:81–96](../tools/framework/commands/management/recipe/index.ts#L81)).
5. Новый `verifyOwnership()` проверяет legacy project через `docker ps --all` и при любом его контейнере, даже остановленном, бросает cutover exception ([side-stack.ts:64–74, 122–124](../tools/framework/runtime/docker/side-stack.ts#L64)). Это предсказуемое условие существовало **до** остановки gateway и до перемещения данных.
6. Report phase не ловит это исключение: выполнение не доходит ни до нормального `no-start` outcome ([restore/index.ts:517–520](../tools/framework/commands/lifecycle/restore/index.ts#L517)), ни до preflight secrets и `runtime.start()`/health ([restore/index.ts:523–548](../tools/framework/commands/lifecycle/restore/index.ts#L523)). В `push` исключение также прерывает установку sidecar secrets и окончательный start, потому что всё это находится после `await restoreArchive(..., {noStart:true})` ([state.ts:602–639](../tools/framework/commands/lifecycle/state.ts#L602)).

**Механизм и последствия.** **[INFERENCE: статический вывод]** Команда сообщает ownership/cutover error, но к этому времени data directory уже заменён архивом, предыдущий tree перемещён aside, а gateway остановлен. Автоматическое возвращение прежних данных/работающего gateway из `rollbackRestore()` не вызывается, поскольку act phase уже успешно завершилась. Это не безопасный отказ «ничего не изменено» и не штатный успешный `started:false` outcome. Для `push` восстановленные данные также уже на месте, но его secrets/start steps не выполняются. Потеря старого tree не утверждается: aside copy остаётся; P2 — незавершённый supported restore и незапланированный downtime при заранее обнаружимом policy refusal.

Ошибка не зависит от R22-01: достаточно одного deployment и своего корректного legacy project, без namespace collision, concurrency или недоступного Docker. При verifiably foreign containers в новом namespace действует аналогичная поздняя refusal-ветвь, но это дополнительный input того же механизма, не отдельная находка.

**Граница прежнего evidence.** Recipe identity regression действительно проверяет foreign/legacy refusal и zero mutations для прямых stack operations/discovery ([recipe-identity.check.ts:77–101](../tools/checks/integration/recipe/recipe-identity.check.ts#L77)). Она **не вызывает restore** и потому не доказывает отсутствие мутации gateway/data до discovery. Существующий restore regression проверяет ancestry refusal до stop и компенсацию extraction failure ([restore.check.ts:99–141](../tools/checks/runtime/service/restore.check.ts#L99)), но эти ошибки возникают до act либо внутри его compensation scope. Переданный настоящий recipe smoke раунда 21 также не заявляет restore при pending cutover. Это сопоставление coverage по исходникам/статусу, не новый прогон.

**Разумное исправление.** Обязательный ownership/discovery preflight, способный отказать восстановлению, выполнять под тем же instance lock **до stop/move/extract**. Не снимать guard и не считать его исключение доказанным отсутствием stacks. Для последующих предупреждений можно использовать подтверждённую preflight-инвентаризацию; если потребуется повторная observation, её late failure должна иметь явно определённый outcome/compensation, не случайно прерывать уже заменивший данные restore. Обновить реальный порядок и preview/documentation согласованно; не чинить только JSON error wording.

**Acceptance для фазы исправлений, здесь не выполнен:**

1. Gateway работает, current data содержат A, валидный archive содержит B, valid recipe имеет stopped legacy container. Public `restore ... --force` отказывает с cutover reason **до** gateway stop и data replacement: остаются A и исходное running state, B не распакован. Повторить для foreign ownership в текущем namespace.
2. Тот же refusal через `push` и `restore --no-start`: current bytes/running state сохраняются, snapshot secrets не устанавливаются, старые recipe containers/volumes не трогаются. `--no-start` не должен разрешать policy refusal после уже выполненного replace.
3. После подтверждённого operator cutover restore успешно восстанавливает B и выполняет предусмотренный start/health; явный `--no-start` сохраняет обычный truthful outcome. Не превращать ownership failure в пустой sidecar list.
4. Existing ancestry/layout/extraction compensation и missing-secrets outcomes сохраняются. Проверка должна наблюдать bytes и running state/порядок мутации, а не только наличие текста cutover в error.

**Отличие от прежних findings.** Не повтор dry-run writes R10/R12, symlink ancestry или неверного `started:true` R16. Здесь execute path, новый deterministic ownership refusal, уже заменённый data tree и исключение **после** защищённой act phase. Safe refusal прямого recipe lifecycle из раунда 21 остаётся корректным; найден другой caller с неправильной sequencing boundary.

## Correctness закрытий раунда 21

«Закрыт» ниже означает: прежний конкретный механизм устранён в прочитанном коде. Это не fresh dynamic certification.

| Закрытие | Текущая статическая оценка |
| --- | --- |
| R21-01: recipe identity игнорировала gateway override | Закрыт для исходного same-basename сценария: `recipeProjectName()` использует `composeProjectName()`, `recipeStack()` един для lifecycle и valid/broken-manifest discovery ([recipe.ts:117–129](../tools/framework/service/recipe.ts#L117), [recipe/index.ts:81–96](../tools/framework/commands/management/recipe/index.ts#L81)). Distinct `team-a` / `team-b` с recipe `cache` больше не дают общий basename project. R22-01 выявляет другое допустимое разбиение компонентов, не возвращение к старому builder. |
| Foreign/stopped/legacy ownership | Guard перечисляет stopped containers, сравнивает project/working-directory/config-file labels и не создаёт автоматический alias legacy namespace ([side-stack.ts:64–102](../tools/framework/runtime/docker/side-stack.ts#L64)). Install проверяет ownership до app-owned preparation ([actions.ts:433–439](../tools/framework/commands/management/recipe/actions.ts#L433)). Прямое refusal без adoption корректно; R22-02 касается поздней интеграции этого guard в restore. |
| Safe operator cutover | Документация требует inspect labels/mounts, backup, explicit old-project down **без volumes**, отдельно предупреждает, что Compose-managed volume data не мигрируют от переименования ([recipes.md:29–62](guide/recipes.md#L29)). Не засчитывается как новый defect необходимость ручного подтверждения неоднозначного legacy ownership. |
| R21-02: потерян CLI literal binding | Закрыт: CLI передаёт исходные atoms в preparation и command runner, больше не раскладывает inline option в два неоднозначных token ([cli.ts:109–132](../tools/framework/entry/cli.ts#L109)). Shared parser берёт inline value непосредственно, сохраняя missing-value refusal для следующей объявленной опции ([arguments.ts:138–177](../tools/framework/core/arguments.ts#L138)). |
| MCP literal binding и passthrough | `toArgv()` кодирует string options inline, variadic child arguments отделяет bare `--` ([schema.ts:276–302](../tools/framework/integration/mcp/schema.ts#L276)). `cli`/`exec` снимают только собственный leading boundary, `host` отделяет свои flags от child command ([commands/interface/cli.ts:11–18](../tools/framework/commands/interface/cli.ts#L11), [exec.ts:14–20](../tools/framework/commands/interface/exec.ts#L14), [host/index.ts:34–59](../tools/framework/commands/interface/host/index.ts#L34)). |
| Affected raw option readers | `accept`/`apply` и `set diff` используют parsed values ([accept.ts:362–375](../tools/framework/commands/orchestration/accept.ts#L362), [apply.ts:247–256](../tools/framework/commands/orchestration/apply.ts#L247), [set-diff.ts:306–325](../tools/framework/commands/sets/set-diff.ts#L306)). Ordered profile selection понимает inline `--profile` ([state.ts:293–312](../tools/framework/commands/lifecycle/state.ts#L293)); recipe tail и foreign-lock host readers учитывают inline binding и boundary ([lifecycle.ts:324–333](../tools/framework/commands/lifecycle/lifecycle.ts#L324), [instance-lock.ts:227–232](../tools/framework/runtime/lock/instance-lock.ts#L227)). Новый parser-specific workaround для `--tail` не введён. |
| Readiness query budget | Исправлена причина: начавшаяся service-state query ограничена `max(deadline, graceEndsAt)`, не более коротким остатком observation window; неблагоприятный ответ ещё проверяется после await, failure/timeout остаются отказами до `afterStart` ([actions.ts:136–185, 450–462](../tools/framework/commands/management/recipe/actions.ts#L136)). Существующие source regressions сохраняют stopped-service, grace flip и hung-probe сценарии ([recipe-readiness.check.ts:328–398](../tools/checks/integration/agent/recipe-readiness.check.ts#L328)). |

**Сопоставление с ранее сообщённым verification.** [session-tasks21:19–34](session-tasks-2026-09-30-round-21.md#L19) сообщает настоящий Windows gate → WslTransport → Docker logs и настоящий control-MCP JSON-RPC для literal patterns; настоящий Compose smoke двух roots с same basename проверил actual A/B data, контейнеры, status/logs, reinstall/remove/volumes, own backup quiesce/resume, broken manifest, legacy refusal/cutover и default workflow. Это controlled service, не upstream OpenClaw certification. Эти результаты не подменены проверкой argv arrays или неравенства project strings.

[session-tasks21:36–41](session-tasks-2026-09-30-round-21.md#L36) фиксирует первоначальные **181 из 183 выполненных check-файлов, 6 capability-пропусков**, затем исправление двух отказов и **адресный повтор 4 файлов**, typecheck/Oxlint; ранний build/pack записан на [строках 11–17](session-tasks-2026-09-30-round-21.md#L11). Во время этого статического review основной исполнитель передал новое evidence и дополнил [session-tasks21:43–46](session-tasks-2026-09-30-round-21.md#L43): на codebase `2fe4682` свежий `npm run check -- --jobs 1` завершился exit 0 — **183 check-файла passed, 6 capability-пропусков** (GNU userland — 2, Linux host — 3, SSH loopback — 1); чистый Linux node:24 runner отдельно прошёл **10 scoped recipe/MCP dispatch/readiness check-файлов**, typecheck/Oxlint. Это сообщённый **полный passing-after**, не сумма адресных повторов и не запуск reviewer. Исходники при дополнении не менялись. Удаление incidental argv-copy assertion и regrouping MCP checks не объявляются bugs или заменой поведенческого доказательства; общий passing результат сам по себе не покрывает новые конкретные inputs R22-01/R22-02.

## Framework в целом: удобство, полнота инструментов и качество

Обзор не ограничен diff раунда 21. Пройдены следующие operator/consumer границы; оценка относится к прочитанным путям, не к каждому файлу repository.

| Область | Что проверено статически и оценка |
| --- | --- |
| Source / installed entry, help и grammar | Full installed root выбирается до loading app, command help — до Context; shared parser сохраняет literal values и отказывает неизвестным/repeated options ([bin.ts:28–75](../tools/framework/entry/bin.ts#L28), [cli.ts:84–106](../tools/framework/entry/cli.ts#L84), [arguments.ts:103–195](../tools/framework/core/arguments.ts#L103)). Shell completion строится из declared framework commands/flag/action sets, без target initialization ([completion.ts:45–74, 233–255](../tools/framework/integration/completion.ts#L45)). Это не заявлено проверкой каждой пользовательской shell configuration. |
| CLI / MCP surface и operator safety | Schema, validation, confirmation и capture используют общие declarations; help доступен отдельно; structured machine output отделён от progress; успешные и failed ответы маскируются, deliberate secret export выделен явно ([schema.ts:202–274](../tools/framework/integration/mcp/schema.ts#L202), [server.ts:73–119, 266–340](../tools/framework/integration/mcp/server.ts#L266)). Command queue не блокирует ping/list/cancellation; running cancellation не обещает отмену мутации ([server.ts:383–484](../tools/framework/integration/mcp/server.ts#L383)). |
| Protocol transport | Live MCP relay имеет отдельный byte-pipe mode, finite input не смешивается с ним, stderr отдельный, child closure/EOF очищают stdin relay; Windows non-TTY наследование не возвращено ([exec.ts:140–176, 199–269](../tools/framework/runtime/transport/exec.ts#L140)). Прежний R20-01 не заявлен вновь. |
| Context / target coordinates | `.env` и app-computed defaults объединяются одним builder; apply после своих env writers refreshes Context и останавливает остаток плана при изменении target coordinates ([context.ts:45–60, 141–164](../tools/framework/core/context.ts#L45), [apply.ts:194–233](../tools/framework/commands/orchestration/apply.ts#L194)). Platform matrix/WSL ACL boundary явно описаны ([requirements.md:14–35, 60–83](guide/requirements.md#L14)); их ограничения не изображаются найденными багами. |
| Inspect / doctor / plan / apply | Public config/egress очищаются; unreachable сохраняется как finding; doctor добавляет security gate; failed live CLI read блокирует apply до steps; после работы есть повторная inspection ([gather.ts:57–96, 369–389](../tools/framework/commands/orchestration/inspect/gather.ts#L57), [apply.ts:360–398](../tools/framework/commands/orchestration/apply.ts#L360)). Это полезный observe → plan → enact → observe loop, а не набор несвязанных команд. |
| Recipes / hooks / readiness | Есть каталог, import/new, lifecycle, logs, verify/onboard/diagnose, readiness и paired backup quiesce/resume; failed/hung hooks не выдаются за успешную consistency ([actions.ts:411–496](../tools/framework/commands/management/recipe/actions.ts#L411), [recipe/lifecycle.ts:81–143](../tools/framework/commands/management/recipe/lifecycle.ts#L81)). Оставшиеся defects — составная identity и boundary restore-discovery, R22-01/R22-02. |
| Backup / pull / restore | Archive сначала private staging, content/privacy verification до publication; компенсация gateway/recipe failures сохраняет исходную причину ([backup/index.ts:370–385, 437–530](../tools/framework/commands/lifecycle/backup/index.ts#L370)). Pull переносит archive и secrets/template sidecars отдельными стадиями ([state.ts:384–427](../tools/framework/commands/lifecycle/state.ts#L384)). Restore ancestry/layout/aside/act compensation есть, но новый обязательный refusal стоит после этой области — R22-02. |
| Upgrade / pin / inventory | Новый image проверяется до durable pin, post-recreation exception ведёт к компенсации с отдельным previous digest ([lifecycle.ts:498–580](../tools/framework/commands/lifecycle/lifecycle.ts#L498)); inventory parsers сохраняют unknown, writer не заменяет lock при incomplete inventory ([extensions.ts:46–86](../tools/framework/commands/management/extensions.ts#L46), [lock.ts:298–320](../tools/framework/commands/management/lock.ts#L298)). R19-01/02/03 не возвращены. |
| Secrets / sharing / rollback | Repo-env recreate подтверждает фактические values по именам, без печати; rollback публикует config private writer; документированный offsite hook передаёт base64 и проверяет SHA-256 записанных bytes ([secrets.ts:149–188](../tools/framework/commands/management/secrets.ts#L149), [rollback.ts:288–296, 333–343](../tools/framework/commands/orchestration/rollback.ts#L288), [data-and-backups.md:224–265](guide/data-and-backups.md#L224)). Живые credentials не использовались. |
| Sets / trial / acceptance | Artifact source удерживается для planning и steps, control markers проверяются под lock; failed live secrets read не подменяется stale store при trial; receipts связываются с runtime до/после и security gate ([apply.ts:247–255, 305–331](../tools/framework/commands/orchestration/apply.ts#L247), [set-try.ts:161–187, 264–306](../tools/framework/commands/sets/set-try.ts#L161), [accept.ts:439–485](../tools/framework/commands/orchestration/accept.ts#L439)). Model-turn approval остаётся явным, пропуски не называются pass ([accept.ts:399–409](../tools/framework/commands/orchestration/accept.ts#L399)). |
| Remote deployment | Private recipe source roots/portable content отказывают до передачи; framework/config/recipes доставляются раздельно и через guarded destination paths ([deploy/refusals.ts:17–98](../tools/framework/commands/management/deploy/refusals.ts#L17), [deploy/sync.ts:35–123](../tools/framework/commands/management/deploy/sync.ts#L35)). SSH host и rsync здесь не запускались; прежние destructive-boundary находки не переобъявлены. |
| Monitoring / scheduler / incident | Scheduler identity — physical execution-root digest, legacy cron migration — exact own invocation, account flock — весь read/filter/write; installed Windows action несёт project root ([schedule.ts:33–52, 132–148, 181–226, 300–314](../tools/framework/commands/operate/schedule.ts#L33)). Bootstrap guard предшествует target identity queries при schedule apply ([backup/install.ts:76–95](../tools/framework/commands/lifecycle/backup/install.ts#L76), [watch/install.ts:110–130](../tools/framework/commands/operate/watch/install.ts#L110)). SSH scheduled state отделён от operator state; alert cycle удерживает local history lock; failed evidence preservation не останавливает incident token rotation ([watch/state.ts:17–107](../tools/framework/commands/operate/watch/state.ts#L17), [watch/check.ts:259–311](../tools/framework/commands/operate/watch/check.ts#L259), [incident/index.ts:268–306, 362–387](../tools/framework/commands/operate/incident/index.ts#L268)). |
| Installed distribution / extension model | Public package exports app/mounts/commands/private-config; builder исключает dist/node_modules из source traversal, выпускает JS/declaration specifiers и resources; hook runtime выбирает shipped `.js` loader в compiled mode ([package.json:27–68](../tools/framework/package.json#L27), [build-framework-package.ts:23–59, 103–126](../tools/build-framework-package.ts#L23), [hook-runtime.ts:49–60](../tools/framework/commands/management/recipe/hook-runtime.ts#L49)). Package не собирался/не устанавливался в этом review. |

**Удобство и полнота.** Основные operator намерения имеют штатные пути: подготовка/запуск, observation и drift repair, secrets/recovery, архивы/восстановление/upgrade, recipe lifecycle и agents/sets, monitoring/scheduling, deploy и incident response. README связывает эти действия с командами ([README.md:68–90](../README.md#L68)); declarations дают ordering/side-effect contract и MCP зеркалирование. Новой системы orchestration или дополнительных команд ради количества не требуется. Приоритетное повышение удобства в этом раунде — сделать уже обещанные workflows работоспособными: разные namespaces не должны неожиданно требовать operator cutover между независимыми recipes, а refusal восстановления не должен приходить после replacement live data.

**Качество и «пахнущий код».** В доказанных случаях smell имеет поведенческую причину: сериализация domain identity без сохранения границ и mandatory failure-capable read в функции, названной report, после выхода из compensation scope. Это не замечания к naming/line count сами по себе: показаны реальный адресат guard и порядок stop/move/extract/failure. Правильное место исправления — общий identity builder и restore transaction boundary. Стилистика, wording, размер функций, argv-copy preferences и capability gaps не засчитаны P3. Guard/private publication/shared argument patterns полезны; их не следует снимать ради обхода отказов.

## Пределы и итог

- Это новый **статический** обзор ключевых framework/operator/CLI/MCP/dataflow границ и correctness закрытий21, не proof каждого файла, каждой платформы или всех upstream releases.
- Новые сценарии не запускались. Exact strings и sequencing приведены как **[INFERENCE: статический вывод]**; их частота в реальных пользовательских deployments неизвестна. Динамический acceptance относится к фазе исправлений.
- Никакие checks/services/build/lint/formatters/smoke не запускались. Docker/WSL/SSH, scheduler и webhooks в этом раунде не использовались; прежнее verification не выдано за новое.
- Исходные R21-01/R21-02 и readiness-budget mechanism закрыты по прочитанным ветвям и согласуются с переданным evidence. Новые integration/identity corners не отменяют выполненные исправления scheduler, stdio relay, literal binding или ownership guard.
- **P0 = 0, P1 = 0, P2 = 2, P3 = 0.** До отсутствия всех P0–P3 review-fix loop ещё не завершён: остаются **R22-01** и **R22-02**. Код, tests и существующие документы не менялись; локальный коммит содержит только этот отчёт.
