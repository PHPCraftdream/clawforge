# Ревью ClawForge, раунд 29 — после фиксов раунда 28

Дата: 2026-09-30. База: `main` @ f620c8a. Предыдущий: раунд 28
(`docs/internal/review-2026-09-30-round-28.md`, R28-01…R28-10 закрыты коммитами 6b45b22,
cdbb016, 123fb75, f620c8a и 635c2cd). Сами фиксы раунда 28 повторного ревью ещё не проходили —
это первое.

Запрос: независимое ревью по фактам — ошибки, неточности, удобство, недостающие инструменты,
пахнущий код.

Метод: разбор `git diff 3c1992c..f620c8a` (32 файла: `entry/bin.ts`, `entry/delegate.ts`,
`entry/root.ts`, `integration/deployment/names.ts`, `scaffold.ts`, `gate.ts`, `list.ts`,
`completion.ts`, `mcp/project.ts`, `lock.ts`, `extensions.ts`, `openclaw-cli.ts`, `schedule.ts`,
`transport/wsl.ts`, `destroy.ts`, `core/env.ts`, `core/paths.ts` и проверки к ним). Пробы — свежий
`dist/` этой ревизии (`npm run build`). Роль системной команды, как в раунде 28, играла копия
собранного пакета в `apps/.r29/g/node_modules/@clawforge/framework` (вне приложения и вне
`tools/`, `classifyCopy` считает её `global`), запуск `node …/dist/entry/bin.js` из игнорируемых
каталогов под `apps/`: установленное приложение `apps/.r29/app1` (инициализировано через
`--project-root`), развёртывание чекаута `apps/r29c` (`./clawforge new-app`), пустая папка
`apps/.r29/out1`, `APPS/r29c` и `APPS/R29C`, `apps/emptydir`, непустая `apps/r29x` без `app.ts`,
установленное приложение под поддельным признаком чекаута `apps/.r29/fake/myapp` (см. R29-02).
Команды: `help`/без аргументов/опечатки, `init`, `init --local` (в корне и в подпапке),
`version --verbose`, `status`, `doctor`, `lock --check` (текст, `--json`, MCP), `lock`, `plan`,
`secrets`, `backup install`, `watch install` (с разными `--interval`), `destroy` (пробный),
`expose status`, `expose tailscale`, `watch status`, `recipe list`, `set validate`, флаги под
«чужими» действиями, `completion bash|zsh|pwsh|fish`, MCP (`initialize`, `tools/list`,
`tools/call lock`) — для `r29c` так, как его запускает клиент по `.mcp.json`. Цель — WSL
(`Ubuntu-24.04`), только чтение. Автодополнение bash: `bash -n` и вызов `_clawforge_complete` с
заданными `COMP_WORDS`. Хеш прежнего загрузчика MCP посчитан по тексту `project.ts` на 3c1992c.
Предел `schtasks /tr` проверен вызовом `schtasks /create /s <неразрешимый хост> …` — задача не
создаётся ни при каком исходе. Статически — объявления аргументов и автодополнение, ветка
Windows в `schedule.ts`, `expose`, `incident`, `watch`, сверка `docs/guide/commands.md` с
объявлениями (скрипт по `openclawCommands`), повторы помощников, лимиты раскладки. Вывод,
сделанный рассуждением, а не воспроизведением, помечен «по коду». Каталоги проб удалены.

Не проверялось: живой `bootstrap`/`up` (цель не трогалась), Linux-хост, ssh-цель, macOS.
`cmd.exe` и PowerShell в среде ревью запускать нельзя, `zsh` нет: разбор скрипта `completion pwsh`
и поведение `#compdef` + `bashcompinit` при первом Tab в zsh не проверены (подозрение раунда 28
про `Register-ArgumentCompleter -Native` и npm-обёртку `clawforge.ps1` тоже остаётся
непроверенным). `system-install.check.ts` (ставит пакет во временный префикс вне рабочего
дерева) и полный `npm run check` не запускались. Отказ R29-02 воспроизведён на поддельном
признаке чекаута (два файла), а не на настоящей глобальной установке вне чекаута.

Шкала: P0 — ломает данные/безопасность; P1 — ломает основное обещание; P2 — неверное
поведение в реальном сценарии; P3 — шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| R29-01 | P3 | `entry/bin.ts:60-64, 112-121`, `integration/gate.ts:90, 109`, `integration/gate.ts:209-212` | фикс R28-07 не дошёл до вывода: «(in bash also ./clawforge new-app <name>)» печатается как «(in bash also clawforge new-app <name>)» и «run clawforge from its root (in bash also clawforge)» — `localizeHints` переписывает и этот `./clawforge`; «this one can be reused by name» — для любой пустой папки чекаута, не только `apps/<имя>`; `help int` в чекауте советует `init`, который там запрещён; опечатка вне приложения — «no app.ts», а не «unknown command»; воспроизведено |
| R29-02 | P3 | `entry/delegate.ts:90-96`, `entry/bin.ts:75, 109` | регрессия фикса R28-03: отказ «inside the ClawForge checkout … not one of its apps/<name> deployments» решается по месту, а не по тому, что импортирует `app.ts`: установленное приложение внутри дерева чекаута (одна копия фреймворка) больше не запускается глобальной командой — ни `status`, ни `version`, ни `--project-root`; совет «'./clawforge' in <checkout>» выполнить нельзя; воспроизведено |
| R29-03 | P3 | `entry/bin.ts:53, 95-96`, `delegate.ts:84-88` | `init --local` в развёртывании чекаута: в `apps/r29c` — «unknown command: init» (код 1), в `apps/r29c/recipes` — `npm install --no-save "<глобальный пакет>"` (код 0), хотя `app.ts` чекаута импортирует исходники и ставить нечего; воспроизведено |
| R29-04 | P3 | `integration/completion.ts:46-62`, `core/app.ts:49-52`, `backup/index.ts:65-73`, `watch/install.ts:50`, `expose/*.ts`, `sets/*`, `docs/guide/commands.md:91-94` | автодополнение, `--help` и MCP-схема предлагают под действием флаги, которые это действие отвергает: `backup list --hot`, `backup install --dry-run`, `watch status --interval`, `recipe list --volumes`, `expose status --local-port`, `set receipts --to` — «unknown argument»; `actions` объявлены только у `backup` (3 флага) и `recipe` (1); воспроизведено |
| R29-05 | P3 | `watch/install.ts:77-90`, `schedule.ts:85-114`, `docs/guide/data-and-backups.md:172` | `--interval` у `watch install` — голые минуты, у `backup install` — `30m/6h/1d`, при заявленном «mirrors … exactly»: `watch install --interval 10m` → «nearest valid: » с пустой подсказкой, `backup install --interval 45m` советует «30, 60», которые `backup` сам отвергает («got "5"»); воспроизведено |
| R29-06 | P3 | `expose/tailscale.ts:149` | `expose tailscale` печатает «undo with: tailscale serve reset» — ту самую команду, которую модуль, `incident`, его справка и документация называют недопустимой (сносит маршруты чужих сервисов на узле); остаток B6 из обзора 2026-09-28; воспроизведено |
| R29-07 | P3 | `schedule.ts:255-268, 313-338, 355-361, 394-401`, `docs/guide/monitoring-and-access.md:174` | ветка «фреймворк нативно на Windows, node напрямую» недостижима (`local` на Windows отвергается в `createTransport`), но описана в справке и документации и покрыта проверками; предел `schtasks /tr` в 261 символ не учтён — `--apply` умрёт с ошибкой `schtasks`, строка для `cmd` тоже; предел воспроизведён |
| R29-08 | P3 | `docs/guide/commands.md:63, 75, 103-106`, `monitoring-and-access.md:173`, `tools/clawforge.ts:143`, `init.ts:322`, `scaffold.ts:119` | документация и справка отстали: автодополнение «calling `./clawforge list --json`», у `backup` нет `install\|uninstall` и `--interval`, у `mcp-setup` — `--rewrite-launcher`, строка WSL «`wsl.exe -d <distro> -- …`», `new-app` «Refuses if the directory already exists», «secrets and snapshots stay inside this directory» (снимки `pull` лежат в `/srv/<имя>/snapshots`); проверки «документация = объявления» нет |
| R29-09 | P3 | `lock.ts:94`, `set-manifest.ts:100`, `backup/list.ts:29`, `remove.ts:43`, `system-install.check.ts:266-273`, `lock.ts:287-297`, `entry/root.ts:22-23` | гигиена: два одинаковых `recipeNames`, два `humanSize` (KB/MB и KiB/MiB для одних и тех же байтов); проверка пишет `app.ts` в отслеживаемый `docs/`; `LOCK_MISSING` считается «1 difference(s) from the lock», когда блокировки нет вовсе; реэкспорты в `entry/root.ts` только ради шлюза |

P0, P1 и P2 нет.

## 2. Подробно

### R29-01 (P3). Советы в чекауте: фикс R28-07 не дошёл до вывода

Из пустой папки внутри чекаута (`apps/.r29/out1`), глобальной командой:

```
$ clawforge init
error: <checkout> is a ClawForge checkout — init would write an installed-style deployment it
cannot load; from its root run: clawforge new-app <name> (in bash also clawforge new-app <name>);
new-app accepts an existing empty directory, so this one can be reused by name or removed   (код 1)
$ clawforge statsu
error: no app.ts in <checkout>\apps\.r29\out1
error: this is a ClawForge checkout (<checkout>) — run clawforge from its root (in bash also clawforge)   (код 1)
$ clawforge help int
error: unknown command: int
    did you mean: init                                                                    (код 1)
```

- `bin.ts:63` и `:119` пишут «(in bash also ./clawforge …)», но `reportError` проходит через
  `localizeHints`, а её `HINT` щадит только `./clawforge` в кавычках — голый переписывается в
  `clawforge`. Вариант для bash, ради которого R28-07 и правился, исчез; CHANGELOG утверждает
  обратное («`./clawforge` as the bash form»). Проверки этого не видят:
  `system-install.check.ts:281` ищет «from its root», `:286` — «clawforge new-app <name>», обе
  строки есть и в искажённом тексте.
- «so this one can be reused by name» (`bin.ts:60-64`) печатается для любой пустой папки
  внутри чекаута. `new-app out1` создаст `apps/out1`, а не займёт `apps/.r29/out1`: повторное
  использование возможно только для `apps/<имя>`.
- В чекауте справка убирает `init` из списка (`gate.ts:90`), а подсказка «did you mean»
  (`gate.ts:109`) берёт кандидатов из полного списка команд шлюза — и предлагает `init`.
- Опечатка вне приложения отвечает «no app.ts … run: clawforge init» (или, как выше, про
  чекаут), а не «unknown command: statsu / did you mean: status»: `helpWithoutDeployment` ловит
  только `help <имя>`. Шлюз чекаута на тот же случай отвечает опечаткой
  (`tools/clawforge.ts:291-293`).
- Рядом: `./clawforge --app r29x status` при непустой `apps/r29x` без `app.ts` —
  «deployment "r29x" not found at <checkout>\apps\r29x … or create one with ./clawforge new-app
  <name>», а `new-app r29x` — «already exists» (`gate.ts:209-212`): каталог есть, в нём нет
  `app.ts`, и совет снова ведёт в отказ.

Предложение: строку для bash печатать отдельной строкой без переписывания (писатель ошибок с
`verbatim`, как у `infoRaw`); фразу про повторное использование — только когда `cwd` — это
`<checkout>/apps/<имя>`, и с именем: «`new-app <имя>` займёт эту папку»; в `gate.ts:109` в чекауте
исключать `init` из кандидатов; в `bin.ts` первое слово, которого нет ни среди команд
развёртывания, ни среди команд шлюза, — «unknown command» с подсказкой до «no app.ts»; в
`missingDeploymentReport` отличать «каталог есть, `app.ts` нет». Проверки — на точный текст с
`./clawforge new-app <name>`.

### R29-02 (P3). Отказ «stray checkout app» решается по месту, а не по импорту

R28-03 закрыт двумя изменениями: `canonicalCase` (передача из `APPS/<имя>` работает, см. «Что
хорошо») и отказ в `delegate.ts:90-96`: если в папке есть `app.ts`, выше есть чекаут, а
работающий пакет лежит вне его — ошибка. Второе шире проблемы. Проба: в `apps/.r29/fake`
положены два файла, по которым `findCheckoutRoot` узнаёт чекаут (`tools/clawforge.ts` и
`tools/framework/package.json` с `"name": "@clawforge/framework"`), в `fake/myapp` — копия
установленного `app1` (`app.ts` импортирует `@clawforge/framework/app`):

```
$ clawforge status                 (в fake/myapp)
error: <…>\fake\myapp is inside the ClawForge checkout <…>\fake but is not one of its apps/<name>
deployments — run it with the checkout's own entry: './clawforge' in <…>\fake     (код 1)
$ clawforge version --verbose      → то же, код 1
$ clawforge --project-root <…>\fake\myapp status   → то же, код 1
```

Тот же `app1` в `apps/.r29/app1` работает: ближайший чекаут там — рабочее дерево, внутри
которого лежит и копия пакета, так что `isWithin` проходит. Настоящая глобальная установка
лежит вне любого чекаута, и для неё отказ сработает на любом установленном приложении внутри
дерева чекаута (так раунды 27–28 и строили пробы).

- Такому приложению вторая копия не грозит: его импорты разрешает `resolveFrameworkFromSelf` в
  работающий пакет. Вторая копия появлялась у приложения вида чекаута (`../../tools/framework/…`),
  попавшего мимо передачи, — а этот случай уже закрыт `canonicalCase`. До f620c8a такое
  приложение работало (по коду: отказа не было, загрузка шла через `resolveFrameworkFromSelf`).
- Отказ стоит в `bin.ts:75` до команд шлюза (`bin.ts:109`), поэтому отвергаются и `version`,
  `help`, `completion`, хотя `version.ts:1` обещает ответ «before any deployment is resolved».
  С `--project-root` отказ тоже срабатывает — запланированный запуск такого приложения молча
  перестанет работать (вывод cron уходит в `/dev/null`).
- Совет невыполним: шлюз чекаута запускает только `apps/<имя>` через `--app` и этого приложения
  не видит; `'./clawforge'` в кавычках — та форма, что R28-07 признал неработающей в `cmd` и
  PowerShell.

Предложение: отказывать, только если `app.ts` действительно тянет исходники чекаута (импорт
относительного `tools/framework/…`, как в шаблоне `new-app`), либо если канонический путь — это
`<checkout>/apps/<имя>` в другом написании; команды шлюза отвечать до отказа; совет — «перенесите
в `apps/<имя>` (`new-app`) или за пределы чекаута». Проверка: установленное приложение под
признаком чекаута запускается, приложение вида чекаута вне `apps/<имя>` получает отказ.

### R29-03 (P3). `init --local` в развёртывании чекаута

```
$ cd apps/r29c && clawforge init --local
error: unknown command: init
    run clawforge help to list every command                                        (код 1)
$ cd apps/r29c/recipes && clawforge init --local
    editor types: run  npm install --no-save "<каталог глобального пакета>"
      (not on the registry yet; once it is: npm install --save-dev @clawforge/framework)  (код 0)
```

Механизм: `localTypesOnly` (`bin.ts:53`) ставится для любого предка с `app.ts`. Из корня
развёртывания `delegate.ts` передаёт вызов шлюзу чекаута, где `init` нет. Из подпапки передачи
нет (`delegate.ts:86` ищет `app.ts` в самой папке), запрет `init` в чекауте не срабатывает
(`bin.ts:59` требует `ancestor === undefined`), и `bin.ts:95-96` печатает строку глобального
пакета. Развёртыванию чекаута она не нужна: `app.ts` импортирует `../../tools/framework/…`,
редактор это уже разрешает. Выполненная в `recipes/` строка (по коду: npm ищет ближайший
`package.json`) поставит ссылку на глобальный пакет в `node_modules` корня чекаута.

Предложение: если предок лежит в `<checkout>/apps/<имя>`, `init --local` отвечает одинаково из
корня и из подпапки: «развёртывание чекаута берёт фреймворк из исходников чекаута; для типов
ничего ставить не нужно (достаточно `npm ci` в корне)», код 0.

### R29-04 (P3). Автодополнение и справка предлагают флаги, которые действие отвергает

Скрипт bash, сгенерированный в приложении:

```
backup list <Tab>   → --break-foreign-lock --break-lock --dry-run --help --hot --json --migrate
                      --native --profile --share --with-secrets
watch status <Tab>  → --apply --break-foreign-lock --break-lock --help --interval --json
$ clawforge backup list --hot             → error: unknown argument: --hot
$ clawforge backup install --dry-run      → error: unknown argument: --dry-run
$ clawforge backup list --break-lock      → error: unknown argument: --break-lock
$ clawforge watch status --interval 5     → error: unknown argument: --interval
$ clawforge recipe list --volumes         → error: --volumes does not apply to recipe list — expected --json
$ clawforge expose status --local-port 9  → error: unknown argument: --local-port
$ clawforge set receipts --to x           → error: unknown argument: --to
```

`completion.ts:46-62` кладёт под каждое действие все флаги без `actions` — по смыслу
`core/app.ts:49-52` это «общие». Но `actions` объявлены только у `backup` (`--apply`, `--keep`,
`--interval`) и `recipe` (`--dry-run`); у `watch`, `expose`, `set` — ни у одного флага, хотя
модули уже держат срезы по действиям (`EXPOSE_SSH_ARGUMENTS`, `WATCH_INSTALL_ARGUMENTS` …).
Флаги создания архива у `backup` (`backup/index.ts:65-73`) пометить нельзя вовсе: «без действия»
не входит в `choices`. Та же декларация питает `backup --help` (в Usage `--hot`, `--dry-run` и
прочие стоят без оговорки) и MCP-схему (`schema.ts:195` дописывает действия только при
`actions`). `docs/guide/commands.md:91-94` обещает «which flags apply under which action» для
`backup`/`recipe`/`watch`/`expose`/`set`.

Предложение: выводить `actions` из уже существующих срезов аргументов каждого действия;
для «без действия» — отдельная пометка (например, пустая строка в `actions`). Недостающая
проверка: для каждой команды с `action` каждый флаг, который автодополнение предлагает под
действием X, принимает парсер X.

### R29-05 (P3). Два словаря `--interval`

```
$ clawforge watch install --interval 10m
error: --interval has no faithful encoding: minutes must divide 60 (1,2,3,4,5,6,10,12,15,20,30),
hours must divide a day (1,2,3,4,6,8,12,24) — nearest valid:                        (код 1)
$ clawforge backup install --interval 5
error: --interval must look like 30m, 6h or 1d (minutes, hours or days) — got "5"
$ clawforge backup install --interval 45m
error: --interval 45m: --interval has no faithful encoding: … — nearest valid: 30, 60
```

- `watch install` берёт голое число минут (`watch/install.ts:77-90`: `Number("10m")` → `NaN`,
  `nearestValidIntervals(NaN)` пуст — отсюда пустая подсказка), `backup install` — строку
  длительности (`parseIntervalToMinutes`, `schedule.ts:102-114`). Документация
  (`data-and-backups.md:172`) говорит, что `backup install` «mirrors `watch install` … exactly».
- Сообщение `cronSchedule` одно на обоих: у `backup` подсказка «30, 60» дана в минутах, которые
  сам `backup` отвергает; у `watch` «hours must divide a day (1,2,…)» читается так, будто
  `--interval 2` — два часа, а это две минуты.

Предложение: один разборщик для обоих — `30m/6h/1d` и голое число как минуты (для совместимости
`watch`); ближайшие значения — в словаре флага (`30m, 1h`); нечисло — «ожидается число минут или
30m/6h/1d».

### R29-06 (P3). `expose tailscale` советует `tailscale serve reset`

```
$ clawforge expose tailscale
==> tailscale serve (tailnet-only)
    …
    undo with: tailscale serve reset (run on the target)
```

`tailscale.ts:112-114` в том же файле: «never `tailscale serve reset`, which would wipe every
other mapping on the target too»; так же говорят шапка `incident/index.ts`, его справка
(`openclawCommands.management.ts:596`) и `monitoring-and-access.md:253`. Обзор 2026-09-28 (B6)
убрал `reset` из `incident`, а совет пользователю остался: на общем узле он снимет tailnet-доступ
к чужим сервисам.

Предложение: печатать снятие одного маршрута — `tailscaleServeOffCommand` по
`tailscaleGatewayRoutes`, если маршрут уже есть, иначе `tailscale serve --https=443 off` с
оговоркой «сверьте порт с `tailscale serve status`», как в `incident`.

### R29-07 (P3). Ветка планировщика Windows: мёртвый путь и предел `/tr`

- `createTransport` отвергает `local` не на Linux (`transport.ts:78-80, 92-95`); на Windows
  транспорт — `wsl` или `ssh`, а для `ssh` `schedulingSupport` (`schedule.ts:255-268`) выбирает
  crontab. Значит, `printSchedulingInstructions` на Windows получает только WSL, и
  `windowsNodeInvocation` (`:326-338`), `installedEntryScript`/`runningEntry` (`:313-321`), ветка
  `windowsScheduledAction` (`:394-401`) и причина «Windows has no crontab or systemd…» (`:267`)
  в работе недостижимы (по коду). При этом справка `watch`
  (`openclawCommands.management.ts:549`) и `monitoring-and-access.md:174` описывают «framework
  running natively on Windows, node invoked directly», а `schedule.check.ts` проверяет эту ветку —
  конфигурацию, которую `requirements.md` называет отвергнутой.
- `schtasks` не принимает `/tr` длиннее 261 символа. Проверено без создания задач:
  `schtasks /create /s <неразрешимый хост> … /tr <262 символа>` → «ERROR: Value for '/tr' option
  cannot be more than 261 character(s).» до обращения к хосту, 258 символов → «The network path
  was not found». Постоянная часть действия WSL — 94 символа (`watch check`, установленное
  приложение), 110 (чекаут, `--app` с именем из 5 символов): путь цели длиннее ~167/151 символа
  — и `--apply` умирает с ошибкой `schtasks` без совета, напечатанная строка для `cmd` тоже. У
  пробы путь 92 символа, `/tr` — 186. Для обычных путей `/mnt/<диск>/Users/<имя>/…` риск мал.

Предложение: убрать нативную ветку и её проверки (или честно пометить как недостижимую) и
поправить справку/документацию; в `schtasksCreateCommand` проверять длину `/tr` и при
превышении говорить об этом (обёртка `.cmd` в `state/` или `schtasks /create /xml`).

### R29-08 (P3). Документация и справка отстали от кода

- `commands.md:103-106`: значения `--app` — «by calling `./clawforge list --json`»; после
  cdbb016 это `"${COMP_WORDS[0]}" list --json --no-status` (`completion.ts:79-80`) и то же в
  PowerShell.
- `commands.md:63`: у `backup` в синопсисе `[<list|prune-replaced>]` — нет `install|uninstall`
  и `--interval`; `commands.md:75`: у `mcp-setup` нет `--rewrite-launcher` (он описан в
  `deploy-and-mcp.md:378`). Скрипт, сверивший флаги и действия всех `openclawCommands` с
  колонкой синопсиса, других расхождений не нашёл — проверка «документация = объявления»
  окупилась бы сразу, её нет.
- `monitoring-and-access.md:173` и справка `watch` (`openclawCommands.management.ts:548`):
  «`wsl.exe -d <distro> -- …`»; печатается `wsl.exe -d <distro> --exec bash -lc "set -e; cd -- '…';
  exec …"`.
- `tools/clawforge.ts:143`: справка `new-app` — «Refuses if the directory already exists»; после
  f620c8a пустой каталог принимается.
- `init.ts:322`, `scaffold.ts:119`: «secrets and snapshots stay inside this directory». Снимки
  `pull` пишутся в `OC_SNAPSHOT_DIR=/srv/<имя>/snapshots` на цели (`deployment-template.ts:44`;
  комментарий в `.env`: «Deliberately NOT inside the repository»). Верно только «у каждого
  развёртывания свои».

Предложение: поправить тексты; добавить проверку, что синопсис `commands.md` называет все
действия и флаги объявления (как сделал скрипт ревью).

### R29-09 (P3). Гигиена

- `lock.ts:94-99` и `set-manifest.ts:100-105` — одинаковые `recipeNames` (второй даже ссылается
  на первый: «Same rule as the lock's recipeNames»).
- `humanSize` дважды: `backup/list.ts:29` (делит на 1024, пишет KB/MB) и `remove.ts:43` (KiB/MiB) —
  одни и те же байты у двух команд подписаны по-разному.
- `system-install.check.ts:266-273` создаёт `docs/<имя>-stray/app.ts` в отслеживаемом `docs/` и
  удаляет в `finally`; прерванный прогон оставит неотслеживаемый `app.ts` в документации, который
  подхватит `git add -A`. Место под игнорируемым `apps/.<имя>/…` проверяет то же самое.
- `lock --check` без файла блокировки: «1 difference(s) from the lock» — `LOCK_MISSING` не
  разница с блокировкой, её нет (`lock.ts:287-297`, так же закреплено в `lock.check.ts`). Точнее —
  «no lock to compare against».
- `entry/root.ts:22-23` реэкспортирует `findCheckoutRoot` и `isWithin` только ради `bin.ts` и
  `tools/clawforge.ts:20`; шлюз чекаута ради `isWithin` грузит модуль входа установленного
  режима (`classifyCopy`, `frameworkPackage`). Импортировать из `core/paths.ts` и `delegate.ts`.

## 3. Что хорошо

- R28-01: при `apps/emptydir` и `apps/.r29` рядом с `apps/r29c` `./clawforge status` выбирает
  `r29c` (код 0); `list` показывает «emptydir — error / not a deployment: no app.ts»,
  `list --json` и автодополнение `--app` дают только `r29c`; `new-app emptydir` занимает пустой
  каталог, непустой (`apps/r29x` с `config/`) по-прежнему отвергается.
- R28-02: в строке `schtasks` нет `&&` (`set -e; cd -- '…'; exec …`), она подписана «для
  cmd.exe»; `set -e` останавливает задачу при неудачном `cd`, а не запускает `./clawforge` в
  домашнем каталоге.
- R28-03: из `APPS/r29c` и `APPS/R29C` — `source: checkout`, `status` с кодом 0.
- R28-04: текст, `--json` и MCP-инструмент `lock` кончаются одной строкой «1 difference(s) from
  the lock; 2 inventory read(s) could not be compared (instance never bootstrapped)»; причина —
  `NOT_BOOTSTRAPPED` с `clawforge bootstrap`, заголовок `==>` вернулся.
- R28-05: MCP развёртывания чекаута, запущенный как клиент по `.mcp.json`, отвечает
  `../../clawforge --app r29c bootstrap`; новый хеш в `RETIRED_LAUNCHERS` равен sha256 загрузчика
  на 3c1992c (посчитано).
- R28-06: `clawforge` без аргументов вне приложения — справка, код 0; `help int` — «unknown
  command» с подсказкой; `init --local` в подпапке установленного приложения печатает строку npm.
- R28-08: скрипт bash проходит `bash -n`; `_clawforge_complete` для `./clawforge --app ""` в
  корне чекаута даёт `r29c`, скрытые и пустые каталоги отфильтрованы.
- R28-09: проверка `sudoFor` считает ровно три вызова `exists` — откат на одну попытку её
  покраснит.
- R28-10: пробный `destroy --backups --snapshots` — «absent — nothing to remove»; справка `init`
  без обрыва.
- `tools/list`: 31 734 байта у развёртывания чекаута (45 инструментов), 30 476 у установленного
  (42) — под бюджетом 32 768 из `mcp-mirror.check.ts`, но запас около 1 КБ.
- Лимиты раскладки соблюдены: самый длинный файл — 673 строки, каталоги с исходниками — не
  больше 7 записей.

## 4. Порядок работ

1. R29-02 — отказ по месту вместо отказа по импорту; блокирует даже `version` и запланированные
   запуски.
2. R29-01, R29-03 — советы и `init --local` в чекауте; вернуть вариант для bash и проверку на
   точный текст.
3. R29-06 — совет `tailscale serve reset`.
4. R29-04, R29-05 — объявления `actions` и один словарь `--interval`; проверка «предложенный флаг
   принимается действием».
5. R29-07 — мёртвая ветка планировщика и длина `/tr`.
6. R29-08, R29-09 — тексты, документация, проверка «документация = объявления», гигиена.
