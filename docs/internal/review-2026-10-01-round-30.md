# Ревью ClawForge, раунд 30 — после фиксов раунда 29

Дата: 2026-10-01. База: `main` @ 650edf9. Предыдущий: раунд 29
(`docs/internal/review-2026-09-30-round-29.md`, R29-01…R29-09 закрыты коммитами 1f79381,
abae3fa, 85e22b1, 2aafab3 и 650edf9). Сами фиксы раунда 29 повторного ревью ещё не проходили —
это первое.

Запрос: независимое ревью по фактам — ошибки, неточности, удобство, недостающие инструменты,
пахнущий код.

Метод: разбор `git diff 6446755..650edf9` (51 файл: `entry/bin.ts`, `entry/delegate.ts`,
`entry/root.ts`, `integration/gate.ts`, `core/arguments.ts`, `core/io/log.ts`, `core/io/size.ts`,
`help-render.ts`, `mcp/schema.ts`, `schedule.ts`, `watch/*`, `backup/*`, `expose/*`, `sets/*`,
`recipe/arguments.ts`, `lock.ts`, `process-identity.ts`, `tools/clawforge.ts`, руководство и
проверки к ним). Пробы — свежий `dist/` этой ревизии (`npm run build`). Роль системной команды,
как в раундах 28–29, играла копия собранного пакета в `apps/.r30/g/node_modules/@clawforge/framework`
(`classifyCopy` считает её `global`), запуск `node …/dist/entry/bin.js` из игнорируемых каталогов
под `apps/`: установленное приложение `apps/.r30/app1` (инициализировано через `--project-root`),
второе установленное с длинным путём (предел `/tr`), развёртывания чекаута `apps/r30c` и
`apps/r30d` (`./clawforge new-app`), пустые `apps/emptyx`, `apps/.hid`, `apps/Bad Name`, непустая
`apps/nonempty` без `app.ts`, подпапки `apps/.r30/out1`, `apps/`, `docs/`, поддельный чекаут
`apps/.r30/fake` с установленным (`myapp`) и чекаутным (`stray`, относительный импорт
`tools/framework/`) `app.ts`. Команды: `help`/без аргументов/опечатки, `init`, `init --local`
(в корне и подпапке обоих видов развёртывания), `version --verbose|--json`, `status`, `doctor`,
`plan`, `secrets`, `lock` и `lock --check` (текст, `--json`, MCP `tools/call`), `backup install` и
`watch install` с 25 и 7 значениями `--interval` (включая пустое и без значения), `backup list`,
`backup prune-replaced`, флаги под «чужими» действиями у `backup`/`watch`/`expose`/`set`/`recipe`,
`destroy` (пробный), `expose tailscale|status`, `set build|validate|forget`, `recipe new --with-hooks`,
`completion bash|zsh|pwsh|fish` (`bash -n` и вызов `_clawforge_complete` с заданными
`COMP_WORDS`), MCP (`initialize`, `tools/list` для обоих видов, скан описаний аргументов). Загрузка
хуков рецептов — собственным `importHookModule` фреймворка из временного скрипта: в развёртывании
чекаута и в установленном приложении в порядке глобального пакета (`resolveFrameworkFromSelf()`,
затем хук). Мутационные пробы проверок (с откатом): строка `backup` в `commands.md` без `--hot` и
лишний флаг в объявлении `lock` против `docs-commands`; подмена среза `watch status` в реестре
против `foundation/core/arguments`. Прогнаны проверки по затронутым фиксам: `foundation/cli`,
`foundation/core/arguments`, `runtime/schedule`, `watch/install`, `backup/install`,
`security/expose`, `release/release/lock`, `docs-commands` — 19 файлов прошли, 1 пропущен
(`linux-host`). Статически — хуки рецептов и `hook-graph.ts`, `set validate`/`set-manifest.ts`,
`recover-env`, `secrets --apply`, допуски и таймауты в коде и проверках, неиспользуемые экспорты
(скрипт по `tools/`), повторы помощников, лимиты раскладки. Вывод, сделанный рассуждением, а не
воспроизведением, помечен «по коду». Каталоги проб удалены.

Не проверялось: живой `bootstrap`/`up`/`recipe verify` (цель не трогалась; `recipe verify` требует
блокировки подготовленного инстанса, поэтому загрузка хуков проверена напрямую через
`importHookModule`), Linux-хост, ssh-цель (ветка crontab — по коду), macOS. `cmd.exe`, PowerShell
и `zsh` не запускались: скрипт `completion pwsh` разобран по коду, `schtasks /create` не
выполнялся (только напечатанные строки). `system-install.check.ts` (ставит пакет во временный
префикс вне рабочего дерева) и полный `npm run check` не запускались.

Шкала: P0 — ломает данные/безопасность; P1 — ломает основное обещание; P2 — неверное
поведение в реальном сценарии; P3 — шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| R30-01 | P2 | `docs/guide/recipes.md:91, 105, 180-189`, `recipe/actions.ts:255`, `recipe/hook-graph.ts:179-195, 257-291`, `entry/delegate.ts:158-170`, `tools/clawforge.ts`, `docs/guide/data-and-backups.md:241` | в развёртывании чекаута хук рецепта не может импортировать `private-config` так, как велит документация: `@clawforge/framework/private-config` (текст руководства и заготовка `recipe new --with-hooks`) — `ERR_MODULE_NOT_FOUND`, пример `#framework/security/privacy/private-config.ts` загрузчик хуков отвергает в любом режиме; `app.ts` чекаута с тем же импортом не грузится; работает только недокументированный относительный путь; воспроизведено |
| R30-02 | P3 | `integration/gate.ts:84-91, 218-219`, `entry/bin.ts:66-71, 126`, `tools/clawforge.ts:275, 296`, `entry/delegate.ts:92-96` | регрессия фикса R29-01: `clawforge list`/`new-app`/`check`/`remove-app` из подпапки чекаута — «unknown command», хотя это команды чекаута (раньше — «запустите из корня»); `./clawforge <command> --help` в корне при нескольких развёртываниях или без них — ошибка, `help <command>` работает; совет «new-app .hid takes over» для имён, которые `new-app` отвергает; для пустой `apps/<имя>` — «add one there», хотя `new-app` её займёт; `version` у чекаутного `app.ts` вне `apps/<имя>` по-прежнему отвергается; воспроизведено |
| R30-03 | P3 | `schedule.ts:106-118`, `backup/install.ts:57, 82`, `watch/install.ts:81-83, 98`, `backup/index.ts:141-142` | единая грамматика `--interval` сделала голое число минутами и для `backup install`: `--interval 6` (естественная опечатка «6h») — остановка шлюза каждые 6 минут, ротация `OC_BACKUP_KEEP=10` за час стирает суточную историю архивов; раньше отвергалось; пустое значение — у `backup` молча `1d`, у `watch` отказ; «--interval 45m: --interval has…»; воспроизведено |
| R30-04 | P3 | `openclawCommands.sets.ts:15-22`, `sets/set.ts:33-40, 168, 185`, `watch/check.ts:38`, `checks/foundation/core/arguments.check.ts:416-488` | фикс R29-04 неполон для `set`: `build`/`validate`/`forget` делят один срез, поэтому автодополнение, `--help` и MCP предлагают `set build --set` (отказ «no meaning for build»), `--kind`/`--break-lock` под `build`/`validate` (молча игнорируются), справка противоречит себе («With forget: … (build, validate, forget)»); новая проверка сравнивает реестр сам с собой, реальные диспетчеры не вызывает — подмена среза `watch status` проходит её; воспроизведено |
| R30-05 | P3 | `core/arguments.ts:85-87`, `backup/index.ts:602-608`, `integration/completion.ts:46-62`, `mcp/schema.ts:196-198`, `arguments.check.ts:479` | «действие» `create` у `backup` есть в сообщениях и справке, но не в разборе: `backup list --hot` → «applies to `create`», `backup create` → «unknown argument: create»; `backup --keep 3` и `backup lst` — «unknown argument» без названия действия и подсказки; флаги создания архива не предлагает ни одно автодополнение, в pwsh это регрессия 2aafab3; воспроизведено (pwsh — по коду) |
| R30-06 | P3 | `integration/mcp/schema.ts:157, 169-180, 193-199` | 11 описаний аргументов в `tools/list` обрываются на полуслове: `watch.interval` «a bare number is», `backup.interval` «a bare number of», `backup.action` «… or uninstall instead of», `set.keep`, `watch.apply` и др. — у `--interval` пропала единица голого числа; обрезка до 60 символов идёт раньше, чем снимается «With x:»; воспроизведено |
| R30-07 | P3 | `sets/set.ts:88`, `sets/set-manifest.ts:66-84`, `set/ownership/validate.ts:106-114`, `openclawCommands.sets.ts:44` | `set validate` по рабочему дереву без закреплённого образа умирает в сборке манифеста, а не сообщает `SET_IMAGE_UNPINNED` вместе с остальными находками; `--json` не даёт JSON; совет «Run clawforge lock» до первого `bootstrap` ведёт в отказ `lock`; воспроизведено |
| R30-08 | P3 | `init.ts:322`, `scaffold.ts:119`, `lock.ts:324`, `destroy.ts:127-133`, `schedule.ts:9, 142, 320-322`, `service/recipe.ts:31`, `process-identity.ts:79-83`, `monitoring-and-access.md:165-166`, `CHANGELOG.md:27, 43-45` | гигиена и точность текстов: «snapshots go to the data directory» (они в `OC_SNAPSHOT_DIR`), `LOCK_MISSING` под заголовком «differences:», размер в `destroy` — сырые KiB, вторая копия `regexEscape` мимо аудита, мёртвый и неверный `defaultRecipesDir`, устаревшая шапка `schedule.ts`, «`1d` daily at midnight» верно только для cron, допуск 15 с не закреплён проверкой, CHANGELOG переоценивает фиксы |

P0 и P1 нет.

## 2. Подробно

### R30-01 (P2). Хуки рецептов в развёртывании чекаута не импортируют `private-config`

Три `verify.ts` в `apps/r30c/recipes/<имя>/` (развёртывание чекаута из `./clawforge new-app`),
загружены собственным `importHookModule` фреймворка (`recipe/hook-runtime.ts`) — тем, через что
идут `recipe verify`/`onboard`/`install`:

```
hk-hash  import … from "#framework/security/privacy/private-config.ts"   (пример recipes.md:189)
  → cannot resolve package import from <checkout>/apps/r30c/recipes/hk-hash/verify.ts:
    no package.json scope inside the recipe directory <checkout>/apps/r30c/recipes/hk-hash
hk-bare  import … from "@clawforge/framework/private-config"            (recipes.md:91, 105; заготовка --with-hooks)
  → ERR_MODULE_NOT_FOUND Cannot find package '@clawforge/framework' imported from <…>/hk-bare/verify.ts
hk-rel   import … from "../../../../tools/framework/security/privacy/private-config.ts"
  → loaded, verify() -> {"ok":true}
```

Тот же `hk-bare` в установленном `apps/.r30/app1`, в порядке глобального пакета
(`resolveFrameworkFromSelf()`, затем `importHookModule`), загружается. `app.ts` развёртывания
чекаута `r30d` с импортом из примера внешней копии (`data-and-backups.md:241`):
`./clawforge --app r30d doctor` → «cannot load deployment "r30d": Cannot find package
'@clawforge/framework'».

- В чекауте `@clawforge/framework` не разрешает никто: корневой пакет называется
  `clawforge-framework-repository`, рабочих областей нет, в корневом `node_modules` пакета нет, а
  хук самоссылки `resolveFrameworkFromSelf` (`delegate.ts:158-170`) ставит только `entry/bin.ts`,
  не `tools/clawforge.ts`.
- `#framework/*` — карта импортов корневого `package.json` репозитория разработки
  (`package.json:9`). Загрузчик хуков намеренно разрешает `#…` только через `package.json` внутри
  каталога рецепта (`hook-graph.ts:257-291`, `packageScopeFileWithin` `:179-195`) и остальное
  отвергает до исполнения. Пример «A prepare hook that uses them» (`recipes.md:180-189`) не
  загружается ни в одном режиме (в установленном — по коду: граница поиска `package.json` та же,
  каталог рецепта).
- `recipe new --with-hooks` пишет заготовку с `@clawforge/framework/private-config`
  (`actions.ts:255`) независимо от режима, `recipe-new.check.ts:96` закрепляет этот текст. Хуки
  фикстуры с `#framework/…` (`recipe-private-snapshot/fixture-recipe/*/prepare.ts`) проверка
  импортирует напрямую через `import()` (`snapshot.check.ts:248-257`), в обход загрузчика;
  `loader-isolation.check.ts:38-49` проверяет голый импорт только с пакетом-заглушкой в
  собственном `node_modules` рецепта. Поэтому отказ не видит ни одна проверка.

Режим чекаута — основной в README (быстрый старт через `./clawforge new-app`), и `deploy` зеркалит
то же дерево на сервер. Единственная рабочая форма — относительный путь в `tools/framework/` —
нигде не описана.

Предложение: в `tools/clawforge.ts` регистрировать тот же хук разрешения, что
`resolveFrameworkFromSelf`, отображая `@clawforge/framework/<экспорт>` на исходники чекаута
(таблица по `exports` из `tools/framework/package.json`: `./app` → `core/app.ts`,
`./private-config` → `security/privacy/private-config.ts`, …); пример в `recipes.md:180-189`
перевести на публичный спецификатор. Проверка: `importHookModule` раскомментированной заготовки
`--with-hooks` в развёртывании чекаута и в установленном приложении.

### R30-02 (P3). Команды чекаута вне развёртывания: регрессия R29-01 и соседние отказы

1. Фикс R29-01 научил `helpWithoutDeployment` (`gate.ts:84-91`) отвечать «unknown command» на
   любое первое слово, которого нет среди команд развёртывания и шлюза установленного режима.
   Но в подпапке чекаута команды шлюза чекаута — настоящие, просто запускаются из корня:

   ```
   $ cd <checkout>/apps && clawforge list
   error: unknown command: list
       run clawforge help to list every command                                     (код 1)
   $ cd <checkout>/docs && clawforge new-app x
   error: unknown command: new-app                                                  (код 1)
   ```

   Так же `check` и `remove-app` (из `apps/.r30/out1`). До 1f79381 (по коду: для всего, кроме
   `help`, функция возвращала `undefined`) здесь печаталось «no app.ts … this is a ClawForge
   checkout — run clawforge from its root». Отказ `init` в той же папке сам советует «from its
   root run: clawforge new-app <name>» — набранная в этой же папке команда отвечает «unknown
   command», а `clawforge help` там показывает только `version` и `completion`.
   `system-install.check.ts` проверяет лишь опечатку `stauts`.
2. В корне чекаута общая справка обещает две формы («Run `./clawforge help <command>` or
   `./clawforge <command> --help`», так же `commands.md:7-9`), но без однозначного развёртывания
   работает только первая (`tools/clawforge.ts:275` ловит лишь `help`/`--help`/`-h` первым словом):

   ```
   (в apps/: r30c, r30d)
   $ ./clawforge help watch     → справка watch                                      (код 0)
   $ ./clawforge watch --help   → error: several deployments (r30c, r30d) — pick one with --app <name> or OC_APP   (код 1)
   (свежий чекаут без развёртываний)
   $ ./clawforge watch --help   → error: deployment "openclaw" not found … create one with: ./clawforge new-app <name>   (код 1)
   ```
3. Совет о повторном использовании (`bin.ts:66-71`) берёт любое имя папки: в пустой `apps/.hid` —
   «new-app .hid takes over this empty directory», в `apps/Bad Name` — «new-app Bad Name takes
   over…» без кавычек; `./clawforge new-app .hid` → «invalid deployment name». Скрытые каталоги
   развёртываниями не считаются с R28-01.
4. `./clawforge --app emptyx status` при ПУСТОЙ `apps/emptyx` → «exists but holds no app.ts — add
   one there, or pick another name» (`gate.ts:218-219`, `tools/clawforge.ts:296`), хотя
   `new-app emptyx` её займёт; «add one there» к тому же мало — нужны ещё `.env` и `config/`.
5. Остаток R29-02: для `app.ts` вида чекаута вне `apps/<имя>` отказ в `delegate.ts:92-96` стоит до
   команд шлюза, и `clawforge version` в `apps/.r30/fake/stray` тоже отвергается, хотя
   `version.ts:1` обещает ответ до разрешения развёртывания.

Предложение: в `bin.ts` при найденном чекауте первое слово из команд его шлюза (`list`,
`new-app`, `remove-app`, `check`) передавать `checkoutGate(checkout)` (им не нужна текущая папка)
или хотя бы отвечать «`list` запускается в корне чекаута: cd <checkout>»; в `tools/clawforge.ts`
`<command> --help|-h` без разрешимого развёртывания обрабатывать как `help <command>`; совет о
повторном использовании — только если имя проходит `safeName`; для пустого каталога в
`missingDeploymentReport` — «new-app <имя> займёт его»; отказ `delegate.ts` — после команд шлюза.

### R30-03 (P3). `backup install`: голое число теперь минуты

```
$ clawforge backup install --interval 6     → … schtasks … /sc MINUTE /mo 6 …           (код 0)
$ clawforge backup install --interval 1     → … /sc MINUTE /mo 1 …                      (код 0)
$ clawforge backup install --interval ""    → … /sc DAILY …                             (код 0, молча 1d)
$ clawforge watch install --interval ""     → error: --interval must be a number of minutes or look like 30m, 6h or 1d … — got ""   (код 1)
$ clawforge backup install --interval 45m   → error: --interval 45m: --interval has no faithful encoding: …
```

- До 85e22b1 `backup install --interval 6` отвергался («must look like 30m, 6h or 1d — got "6"»).
  Теперь число без единицы — естественная опечатка вместо «6h» или «1d» — молча становится
  минутами. Для `backup` это не безобидно: запланированный простой `backup` при каждом запуске
  останавливает шлюз (поведение по умолчанию), а ротация оставляет `OC_BACKUP_KEEP=10` новейших
  архивов (`backup/index.ts:141-142`): при шаге 6 минут через час от суточной истории ничего не
  останется. Ветка crontab (ssh) печатает «crontab entry (every 6, runs on …)»
  (`backup/install.ts:82`) — без единицы. CHANGELOG (строка 27) пишет «existing values keep
  working» — верно только для `watch`.
- Пустое значение: `backup` берёт умолчание (`install.ts:57`), `watch` отказывает
  (`watch/install.ts:81-83`) — одна грамматика, два ответа.
- Отказ повторяет имя флага: `schedule.ts:115` приставляет «--interval <значение>:» к сообщению
  `cronSchedule`, которое уже начинается с «--interval».
- Ветка crontab `watch install` пишет «every 1440 minute(s)» для `1d` (`watch/install.ts:98`) — не
  в написании флага (по коду: на WSL-цели недостижима).

Предложение: для `backup` голое число отвергать (оставить его только `watch` ради совместимости)
или хотя бы предупреждать, когда интервал × `OC_BACKUP_KEEP` меньше суток; пустое значение —
одинаковый отказ; интервал в обоих сообщениях печатать через `formatInterval`; убрать повтор
префикса.

### R30-04 (P3). Срезы `set` шире действий; проверка дрейфа сравнивает реестр сам с собой

```
$ clawforge set build --set x.tar.gz        → error: --set validates an existing artifact; it has no meaning for build   (код 1)
$ clawforge set validate --kind agent --break-lock --json   → флаги приняты и проигнорированы
$ clawforge set forget --set x --kind agent --name a         → --set молча игнорируется
$ clawforge set --help
  --kind <kind>   With forget: agent, mcp-server, or cron-job (build, validate, forget) [agent|mcp-server|cron-job]
  --break-lock    With forget: take over the instance lock held by another operation (build, validate, forget)
tools/list, set:  "kind": "agent, mcp-server, or cron-job (build, validate, forget)",
                  "set": "Artifact instead of the working tree (build, validate, try, forget)"
bash: set build --<Tab> → --break-foreign-lock --break-lock --help --json --kind --name --set
```

- `SET_ACTION_ARGUMENTS` (`openclawCommands.sets.ts:15-22`) даёт `build`, `validate` и `forget`
  один срез `SET_MAIN_ARGUMENTS` (`set.ts:33-40`), потому что диспетчер разбирает их одним
  вызовом (`set.ts:168`). `scopeByAction` честно выводит «что принимает парсер», но парсер шире
  действий: `build` отвергает `--set` уже после разбора (`set.ts:185`), `forget` игнорирует `--set`
  и `--json`, `build`/`validate` — `--kind`, `--break-lock`, `--break-foreign-lock`. Это ровно класс
  R29-04 («предложено — отвергнуто»), только для `set`.
- Тот же вывод дал противоречивую справку: вступление «With x:» не совпадает с областью. Скрипт
  по объявлениям нашёл три строки: `watch --json` («With check/status:», область check, status,
  test — `watch/check.ts:38`), `set --kind` и `set --break-lock` («With forget:», область build,
  validate, forget).
- Новая проверка (`arguments.check.ts:416-488`) сравнивает `scopeByAction(REGISTRY[cmd])` с
  `parseDeclaredArgs(REGISTRY[cmd][action])` — обе стороны из одного реестра; настоящие
  диспетчеры (`backup/index.ts:602-608`, `watch/index.ts`, `expose/index.ts`, `set.ts`) она не
  вызывает (кроме `recipe` через `validateRecipeArgs`). Мутация: в `watch/index.ts`
  `status: WATCH_CHECK_ARGUMENTS` → `WATCH_INSTALL_ARGUMENTS` (настоящий `watchStatus` по-прежнему
  разбирает `WATCH_CHECK_ARGUMENTS`, `status.ts:39`) — `check foundation/core/arguments` и
  `check foundation/cli` (7 файлов) проходят, хотя автодополнение и справка снова предложили бы
  `watch status --interval`, который отвергается. Откачено. CHANGELOG («a check drives every
  parser with every flag of its command», строка 43) это переоценивает.

Предложение: отдельные срезы `SET_BUILD_ARGUMENTS` (name, json), `SET_VALIDATE_ARGUMENTS` (name,
set, json), `SET_FORGET_ARGUMENTS` (kind, name, break-lock, break-foreign-lock), каждый разбирать
в своей ветке; связать реестр с диспетчером (ветка берёт срез из той же таблицы), а в проверке
вызывать настоящую команду с `[action, flag]` на заглушке контекста и требовать лишь «не
`UnknownArgumentError`/не отказ по флагу»; вступления «With x:» убрать из описаний срезов
(суффикс области уже это говорит) или сверять с выведенной областью.

### R30-05 (P3). Голый `backup` как «действие create»

```
$ clawforge backup list --hot          → error: --hot applies to `create`, not `list`
$ clawforge backup create --dry-run    → error: unknown argument: create
$ clawforge backup --keep 3            → error: unknown argument: --keep
$ clawforge backup lst                 → error: unknown argument: lst
bash: backup --<Tab> → --help;  backup --hot --<Tab> → --help;  backup --profile full --<Tab> → --help
```

- `actionLabel(NO_ACTION)` = «create» (`arguments.ts:85-87`) — в ошибках и в `backup --help`
  («(create)»), но такого слова действия нет: диспетчер (`backup/index.ts:602-608`) отдаёт любое
  другое первое слово в `parseDeclaredArgs(BACKUP_ARGUMENTS)` → «unknown argument: create».
  CHANGELOG (строки 44-45) обещает именно «applies to create».
- Разбор создания вызывается без `scope` (`backup/index.ts:608`), поэтому обратное направление
  («--keep applies to prune-replaced, not create») не называется, хотя `commands.md:34-36` обещает
  отказ по имени для флагов действий `backup`; опечатка в действии (`lst`) — «unknown argument» без
  подсказки, тогда как `watch`/`expose`/`set`/`recipe` отвечают `dieUnknownAction` с «did you mean».
- Флаги создания (`--hot`, `--native`, `--profile`, `--share`, `--migrate`, `--with-secrets`,
  `--dry-run`) не предлагает ни одно автодополнение: `specFor` (`completion.ts:46-62`) строит
  списки по действиям только из `choices`, где `NO_ACTION` нет, а ветка `*)` bash даёт лишь
  `--help`. До 2aafab3 эти флаги были без `actions` и попадали в общий список, который pwsh
  подставлял после флага (`$clawforgeFlags[$cmd]`); теперь там `@("--help")` — регрессия (по
  коду, PowerShell не запускался). Проверка пропускает `NO_ACTION` для автодополнения
  (`arguments.check.ts:479`).
- В MCP флаги только для создания не помечены (`schema.ts:196-198`), а описание `action` обрезано
  до «list, prune-replaced, install or uninstall instead of» (R30-06): агент не узнаёт, что без
  действия создаётся архив и что `hot` с `action: list` отвергается.

Предложение: либо принимать `create` как явное слово действия (синоним «без действия»), либо
подписывать «без действия (`backup`)»; разбирать создание со `scope`; неизвестное первое
слово-не-флаг — `dieUnknownAction` с подсказкой; в автодополнении флаги `NO_ACTION` — на месте
действия (вместе со словами действий) и после флага (ветка `*)`, запасной список pwsh); в MCP —
пометка «(no action)».

### R30-06 (P3). Описания аргументов в MCP обрываются на полуслове

Скан `tools/list` развёртывания чекаута (45 инструментов): 11 описаний кончаются служебным словом.

```
watch.interval:   time between checks — a bare number is (install) (value: <interval>)
backup.interval:  how often — 30m, 6h, 1d or a bare number of (install) (value: <interval>)
backup.action:    list, prune-replaced, install or uninstall instead of
watch.apply:      mutate the target's crontab instead (install, uninstall)
set.keep:         leave the throwaway instance running instead of (try)
pull.migrate, accept.set, secrets.init-store, secrets.json, recover-env.adopt-runtime, check.require — так же
```

`shortenDescription` (`schema.ts:169-180`) режет до 60 символов (`SHORT_DESCRIPTION_LIMIT`,
`:157`) по пробелу без многоточия, а вступление «With x:» снимается уже после обрезки
(`schema.ts:199`) и съедает бюджет. Обрезка давняя, но после 85e22b1 у `--interval` обеих команд
пропала именно единица голого числа — то, что изменила новая грамматика (прежнее «minutes between
checks» у `watch` укладывалось целиком). Проверки на тексты схемы нет, только на общий размер:
строка ответа `tools/list` — 31 743 байта из 32 768 у чекаута, 30 485 у установленного
(42 инструмента).

Предложение: снимать «With x:» до обрезки; резать по границе фразы (—, «,», «;») или ставить «…»;
ключевым аргументам — короткие явные описания схемы, как `SHARED_SCHEMA_DESCRIPTIONS`
(`interval` → «30m/6h/1d or minutes», `backup.action` → «…; omit to create a backup»); проверка:
ни одно описание не кончается предлогом, артиклем или «is».

### R30-07 (P3). `set validate` до закрепления образа

```
(свежее установленное приложение: OPENCLAW_IMAGE — тег, блокировки нет)
$ clawforge set validate          → error: no image digest to pin the set to — …:extended-stable is a tag, …
                                    Run clawforge lock to record the digest that was proven, or set OPENCLAW_IMAGE to a @sha256 reference.   (код 1)
$ clawforge set validate --json   → то же, JSON нет                                        (код 1)
$ clawforge lock                  → error: lock not written: openclaw plugins list not read: this deployment has never been bootstrapped; …   (код 1)
```

- Проверка рабочего дерева строит манифест через `collectManifest` (`set.ts:88`), который умирает
  в `requiredImage` (`set-manifest.ts:66-84`) раньше `validateSet`. Собственная проверка
  валидатора `SET_IMAGE_UNPINNED` (`validate.ts:106-114`) для рабочего дерева поэтому
  недостижима, и ни одна другая находка (полнота рецептов, ссылки агентов и MCP, покрытие
  секретов) не видна, пока образ не закреплён. Справка обещает «validate checks a whole set with
  no running instance» (`openclawCommands.sets.ts:44`), `--json` — `{valid, problems}`.
- Совет ведёт в отказ: до первого `bootstrap` `lock` не пишется (инвентарь не прочитан).
  Остаётся править `OPENCLAW_IMAGE` вручную.

Предложение: в `validate` собирать манифест с незакреплённым образом (тег в `requires.image`) и
дать `checkImagePinned` сообщить `SET_IMAGE_UNPINNED` (блокирующая) вместе с остальным, в том
числе в `--json`; жёсткий отказ оставить только `build`; совет до первого `bootstrap` — «bootstrap
сам закрепит digest, или задайте `OPENCLAW_IMAGE=<repo:tag@sha256:…>`».

### R30-08 (P3). Гигиена и точность текстов

- `init.ts:322`, `scaffold.ts:119`: фикс R29-08 оставил неточность — «(snapshots go to the data
  directory on the target)». Снимки лежат в `OC_SNAPSHOT_DIR` (по умолчанию
  `/srv/<имя>/snapshots`, рядом с `OC_DATA_DIR=/srv/<имя>/data`, отдельный флаг
  `destroy --snapshots`).
- `lock.ts:324`: текстовый `lock --check` без файла блокировки печатает `LOCK_MISSING` под
  заголовком «differences:», а итог (фикс R29-09) говорит «no lock file to compare against» и
  разницей его не считает.
- `destroy.ts:127-133`: размер в пробном прогоне — сырые «<n> KiB» из `du -sk`, мимо общего
  `humanSize` (`size.ts`): каталог в 5 ГБ показан семизначным числом KiB. Объединение R29-09 его
  пропустило.
- `schedule.ts:142`: `literal` — вторая копия `regexEscape` (`log.ts:52-54`); аудит
  `SINGLE_DEFINITION` в `layout.check.ts` ищет только `function regexEscape(`, стрелочная копия
  проходит.
- `service/recipe.ts:31`: экспорт `defaultRecipesDir = resolve(monorepoRoot, "recipes")` нигде в
  `tools/` не используется (скрипт по экспортам нашёл только его) и называет каталог, который не
  является умолчанием (умолчание — `recipes/` развёртывания).
- `schedule.ts:9`: шапка «Windows has no crontab/systemd: schedulingSupport() says so» — после
  85e22b1 `schedulingSupport` о Windows не говорит ничего (только WSL). Других висячих ссылок на
  `windowsNodeInvocation`/`installedEntryScript` нет.
- `process-identity.ts:79-83`: утверждение «a reused pid starts minutes, not seconds, after the
  original» неверно для Windows, где pid переиспользуются быстро. Сам компромисс 15 с разумен
  (вызывающие — блокировка цикла `watch/state.ts:41` и уборка `compose-operations.ts:39`; ни одна
  проверка не опиралась на 2 с: `cycle-lock.check.ts` берёт разрыв в 26 лет,
  `compose-sweep.check.ts` — настоящее время старта), но граница проверкой не закреплена
  (заглушка пробы: 14 с — alive, 16 с — dead).
- `monitoring-and-access.md:165-166`: «`1d` daily at midnight» верно для cron (`0 0 * * *`);
  строка `schtasks` — `/sc DAILY` (и `/sc HOURLY`) без `/st` (`schedule.ts:320-322`), такая задача
  стартует от времени создания (по коду и справке `schtasks`).
- `CHANGELOG.md:27, 43-45`: «existing values keep working», «a check drives every parser», «refused
  as "applies to create"» — см. R30-03, R30-04, R30-05.

Предложение: поправить тексты; `destroy` — через `humanSize` (KiB × 1024); в `schedule.ts`
импортировать `regexEscape`, аудит — искать тело выражения, а не имя функции; удалить
`defaultRecipesDir`; проверка границы `START_TIME_TOLERANCE_MS`; `/st 00:00` для `DAILY`/`HOURLY`
(или оговорка в руководстве).

## 3. Что хорошо

- R29-01: из пустой `apps/.r30/out1` отказ `init` печатает «(in bash also ./clawforge new-app
  <name>)» дословно, фраза о повторном использовании есть только для `apps/<имя>`
  (`new-app emptyx takes over this empty directory`); `help int` в чекауте — «unknown command» без
  `init`; опечатка `statsu` вне приложения — «unknown command / did you mean: status»;
  `--app nonempty` — «exists but holds no app.ts».
- R29-02: установленный `app.ts` под поддельным признаком чекаута (`fake/myapp`) снова работает —
  `version --verbose` (`source: global`), `status` с кодом 0; чекаутный `fake/stray` получает
  отказ с выполнимым советом («move it into apps/<name> (new-app), or switch its imports to
  @clawforge/framework»).
- R29-03: `init --local` в `apps/r30c` и `apps/r30c/recipes` — «nothing to install (npm ci in the
  checkout root is enough)», код 0; в установленном `app1` и его `recipes/` — строка npm.
- R29-04: `backup list --hot`, `backup install --dry-run`, `backup list --break-lock`,
  `backup uninstall --interval` называют действие; автодополнение `backup list`, `watch status`,
  `expose status`, `recipe install` предлагает ровно принимаемое.
- R29-05: 25 значений у `backup install` (`5`, `5m`, `10m`, `2h`, `1d`, `60`, `120m`, `24h`,
  `1440`, ` 5` и отказы `45m`, `90`, `90m`, `5h`, `2d`, `0`, `07`, `-5`, `1.5`, `1h30m`, `30s`,
  `0x1e`, `1e1`, `abc`) и 7 у `watch install` (`10m`, `3h`, `1d` приняты, `45m` — отказ) —
  разборщик один, ближайшие значения в написании флага и всегда непустые; `--interval` без
  значения — «needs a value» у обеих.
- R29-06: печатается «undo with: tailscale serve --https=443 off … removes only this route»;
  `no-serve-reset.check.ts` сканирует исходники и руководство.
- R29-07: действие в 296 символов — отказ с числом, пределом и советом, строки `schtasks` нет, код
  1; при 186 символах строка печатается. `bash -n` на скрипте автодополнения проходит.
- R29-08: `docs-commands.check.ts` действительно различает: удаление `--hot` из строки `backup` и
  лишний флаг в объявлении `lock` дали FAIL с понятным списком («backup: --hot declared, not
  documented», «lock: --zzz-new declared, not documented»); после отката — зелёная.
- R29-09: один `recipeNames` (`service/recipe.ts`), один `humanSize` (KiB/MiB) у `backup list`,
  `remove-app` и плана `restore`; итог `lock --check` — «no lock file to compare against; 2
  inventory read(s) could not be compared (instance never bootstrapped)», одинаково в тексте,
  `--json` и MCP.
- Лимиты раскладки соблюдены: самый длинный файл — 672 строки
  (`checks/integration/agent/recipe.check.ts`), каталоги с исходниками — не больше 7 записей.
- Холодный старт `control-mcp` чекаута с `tools/list` — около 0,8 с, запас к 5-секундным
  таймаутам MCP-проверок шестикратный.

## 4. Порядок работ

1. R30-01 — разрешение `@clawforge/framework` в чекауте и пример в `recipes.md`; проверка через
   настоящий загрузчик хуков.
2. R30-03 — голое число в `backup install`, пока расписание с шагом в минуты не попало на живой
   инстанс.
3. R30-02 — регрессия «unknown command» для команд чекаута и `<command> --help` без развёртывания.
4. R30-04, R30-05 — срезы `set`, «действие» `create` у `backup`, флаги создания в автодополнении;
   проверка через настоящие диспетчеры.
5. R30-06 — описания аргументов в MCP.
6. R30-07 — `set validate` без закреплённого образа.
7. R30-08 — тексты и гигиена.
