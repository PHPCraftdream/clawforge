# Ревью ClawForge, раунд 28 — после фиксов раунда 27

Дата: 2026-09-30. База: `main` @ 5a7576c (шесть коммитов после d5ee523, который в локальных
ссылках равен `origin/main`; CI для них не смотрелся). Предыдущий: раунд 27
(`docs/internal/review-2026-09-30-round-27.md`, R27-01…R27-09 закрыты коммитами
8637571…5a7576c). Сами фиксы раунда 27 повторного ревью ещё не проходили — это первое.

Запрос: независимое ревью по фактам — ошибки, неточности, удобство, недостающие инструменты,
пахнущий код.

Метод: разбор `git diff 6e63d60..5a7576c` (27 файлов: вход `entry/` — `bin.ts`, `delegate.ts`,
`root.ts`; шлюз `tools/clawforge.ts`; `infoRaw`; `init`; справка вне приложения; `destroy`;
`lock --check`; `sudoFor`) и проверок к ним. Пробы — свежий `dist/` этой ревизии
(`npm run build`). Роль системной команды играла копия собранного пакета в
`apps/.r28/g/node_modules/@clawforge/framework` (вне приложения и вне `tools/`, поэтому
`classifyCopy` считает её `global`, как настоящую установку), запуск
`node …/dist/entry/bin.js` из игнорируемых каталогов под `apps/`: приложение `app1`
(инициализировано через `--project-root`, потому что внутри чекаута `init` теперь запрещён),
развёртывание чекаута `apps/r28c` (`./clawforge new-app`), подпапки, корень чекаута, `docs/`,
пустая `apps/<имя>`. Команды: `help`/`--help`/без аргументов, `init`, `init --local`,
`version --verbose`, `status`, `doctor`, `lock --check` (текст, `--json`, MCP), `plan`,
`secrets`, `backup install`, `watch install`, `destroy` (с флагами и без), `expose status`,
`completion bash|zsh|pwsh|fish`, `control-mcp` (`initialize`, `tools/list`, `tools/call`),
опечатка, `--app` в разных местах. Цель — WSL (`Ubuntu-24.04`), только чтение. Автодополнение
bash проверено вызовом `_clawforge_complete` с заданными `COMP_WORDS`. Статически — MCP-схема
и сервер, генератор автодополнения, планировщик Windows (`schedule.ts`), транспорты,
дубли помощников, лимиты раскладки. Вывод, сделанный рассуждением, а не воспроизведением,
помечен «по коду». Каталоги проб удалены.

Не проверялось: живой `bootstrap`/`up` (цель не трогалась), Linux-хост с локальной целью,
ssh-цель, macOS. `cmd.exe` и PowerShell в среде ревью запускать нельзя — их разбор строки в
R28-02 выведен из правил этих оболочек. Отдельно стоит проверить руками: `Register-ArgumentCompleter
-Native` из `completion pwsh`, по всей видимости, не срабатывает для npm-обёртки `clawforge.ps1`
(для PowerShell это ExternalScript, а не native-команда) — подозрение, не находка. Полный
`npm run check` не запускался.

Шкала: P0 — ломает данные/безопасность; P1 — ломает основное обещание; P2 — неверное
поведение в реальном сценарии; P3 — шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| R28-01 | P2 | `tools/clawforge.ts:263-271`, `integration/gate.ts:175`, `integration/list.ts:135`, `integration/deployment/scaffold.ts:90-94` | любой каталог в `apps/` считается развёртыванием: пустая `apps/<имя>` (её оставляет отказ `init` в чекауте из R27-05) ломает `./clawforge help`/`status` в корне (код 1, «cannot load deployment»), а совет `new-app <имя>` отказывает — «already exists»; `.r28` попадает в «several deployments», `list` и автодополнение; воспроизведено |
| R28-02 | P2 | `commands/operate/schedule.ts:342-347, 421`, `runtime/transport/wsl.ts:126` | напечатанную строку `schtasks /create … /tr "wsl.exe … -lc \"cd -- '…' && …\"" /f` нельзя вставить ни в одну оболочку Windows: Git Bash превращает `/create`, `/f` в пути (воспроизведено), `cmd.exe` режет её по `&&` и создаёт задачу, которая только делает `cd`, PowerShell 5.1 не разбирает `&&` (по коду); `--apply` верен |
| R28-03 | P3 | `entry/delegate.ts:83` | `basename(parent) === "apps"` чувствительно к регистру: из `APPS\r28c` на Windows передачи шлюзу нет, глобальный пакет грузит `app.ts` чекаута с его исходниками — две копии фреймворка: `status` код 1 вместо 0, `backup install` — «no deployment selected — the entry point must call useDeployment()»; воспроизведено |
| R28-04 | P3 | `commands/management/lock.ts:308-311, 320-322` | фикс R27-07 только для текста: `--json` и MCP-инструмент `lock` по-прежнему кончаются «3 difference(s) from the lock», считая непрочитанные списки; у текста нет строки `==>`; на ни разу не поднятом — «instance is not running» и `nextAction: up`, который отказывает; воспроизведено |
| R28-05 | P3 | `tools/clawforge.ts:305`, `mcp-launch.mjs` развёртываний чекаута | MCP развёртывания чекаута советует `./clawforge --app r28c up`, а клиент открыт в `apps/r28c` (так велит `new-app`), где `./clawforge` нет; R27-08 поправил только установленный загрузчик; воспроизведено |
| R28-06 | P3 | `integration/gate.ts:72-93`, `entry/bin.ts:48-53, 99-108` | остатки R27-03: `clawforge` без аргументов вне приложения — ошибка без списка команд (в приложении — справка); `help int` — «"int" is a deployment command»; в чекауте справка предлагает `clawforge init`, который там запрещён; `init --local` из подпапки — отказ «would nest»; воспроизведено |
| R28-07 | P3 | `entry/bin.ts:56, 106` | совет после отказа в чекауте — `'./clawforge' new-app <name>` в кавычках: в `cmd`/PowerShell не работает, а `clawforge new-app <name>` из корня чекаута работает (передача шлюзу); про оставшуюся пустую папку ни слова; воспроизведено |
| R28-08 | P3 | `integration/completion.ts:78, 107, 145-146`, `entry/bin.ts` | значения `--app` в автодополнении — `./clawforge list --json` без `--no-status` (на каждый Tab опрос цели каждого развёртывания) и только из корня чекаута: в `apps/r28c` пусто, в корне — `.r28 r28c`; скрипт зависит от места генерации, а регистрируется на оба имени; в установленном приложении `--app app1` — «unknown command: --app»; воспроизведено |
| R28-09 | P3 | `checks/integration/apps/invocation-hints.check.ts:63-77`, `checks/runtime/convergence/lock-home.check.ts` | проверки R27-01 держат только примитив `infoRaw`: ни одна не гоняет `backup install`/`watch install`/`deploy`/`schtasks` под нестандартным префиксом — откат любого места вызова на `info` останется зелёным; у `sudoFor` не проверена ветка «три отказа подряд»; по коду |
| R28-10 | P3 | `entry/bin.ts:82-83`, `instance/destroy.ts:142, 147`, `deployment/init.ts:253`, `entry/root.ts:5, 43` | текст и гигиена: жёсткий перенос посреди фразы в справке `init`; пробный `destroy` — «would remove … (absent)» и тут же «nothing to remove»; `packageDirectory` дублирует `frameworkPackage`, `isWithin` — проверку в `classifyCopy`; `entry/root.ts` тянет командный модуль `lock.ts` |

P0 и P1 нет.

## 2. Подробно

### R28-01 (P2). Любой каталог в `apps/` — «развёртывание»

R27-05 запретил `init` внутри чекаута. Естественный путь пользователя с глобальной командой:

```
$ mkdir apps/r28new && cd apps/r28new && clawforge init
error: <checkout> is a ClawForge checkout — init would write an installed-style deployment it
cannot load; create one from its root with: './clawforge' new-app <name>        (код 1)
$ cd ../.. && ./clawforge new-app r28new
error: <checkout>\apps\r28new already exists                                    (код 1)
```

Совет ведёт в тупик: папка, созданная пользователем, осталась, и `new-app` с тем же именем
отказывает. Пока она пуста и других развёртываний нет, ломается сам шлюз (проба с
единственной пустой `apps/myapp`):

```
$ ./clawforge help     → error: cannot load deployment "myapp": Cannot find module
                         '…\apps\myapp\app.ts' imported from …\tools\clawforge.ts   (код 1)
$ ./clawforge status   → то же, код 1
```

Та же причина видна и без `init`: скрытый рабочий каталог `apps/.r28` рядом с `apps/r28c`
даёт `./clawforge status` → «several deployments (.r28, r28c)», хотя `new-app r28c` только что
написал «if r28c is the only deployment under apps/, later commands pick it automatically»;
`list` печатает `.r28 — error / no .env — run ./clawforge --app .r28 bootstrap`, а
`./clawforge --app .r28 status` → «invalid deployment name ".r28"»; автодополнение `--app`
предлагает `.r28`.

Причина: `tools/clawforge.ts:263-266` и `list.ts:135` берут все подкаталоги `apps/` без
проверки `app.ts` и имени; `soleDeploymentFallback` (`gate.ts:175`) выбирает такой каталог, и
`safeName` (`tools/clawforge.ts:251`) его уже не видит — он проверял имя по умолчанию до
подмены. `scaffold.ts:90-94` отказывает на любом существующем каталоге, в том числе пустом.

Предложение: один помощник «имена развёртываний» — подкаталоги с `app.ts` и допустимым
`safeName` (скрытые пропускать), им пользуются шлюз, `list`, запасной выбор и автодополнение;
прочие `list` показывает одной строкой «не развёртывание: нет app.ts». `new-app` принимает
существующий пустой каталог (или отказ `init` прямо говорит удалить пустую папку). Проверка:
пустые `apps/x` и `apps/.x` не меняют `help`, `status` и выбор единственного развёртывания.

### R28-02 (P2). Строку `schtasks` нельзя вставить ни в одну оболочку

`backup install` на Windows с WSL-целью (по умолчанию `OC_TARGET_LOCATION=auto` → wsl) печатает
«run it yourself» и строку (проба в `app1`):

```
schtasks /create /tn clawforge-<id>-backup /sc DAILY /tr "wsl.exe -d Ubuntu-24.04 --exec bash -lc \"cd -- '<путь в WSL>/app1' && './clawforge' 'backup'\"" /f
```

`displayCommandLine` экранирует внутренние кавычки как `\"` — это правило CRT для argv, а не
синтаксис оболочки:

- Git Bash: MSYS переписывает аргументы-«пути». Те же аргументы, переданные `node`, приходят
  как `["<каталог Git>/create", "<каталог Git>/tn", …, "<диск>:/"]` —
  воспроизведено; `schtasks` получит мусор.
- `cmd.exe` (по коду): обратная косая черта для `cmd` не экранирует, каждая `"` переключает
  режим кавычек, поэтому после `-lc \"` кавычки закрыты и `&&` делит строку. Первая часть —
  `schtasks … /tr "wsl.exe … -lc \"cd -- '/mnt/…/app1' ` без `/f`: задача создаётся
  («SUCCESS»), её действие — `bash -lc "cd -- '…'"`, резервная копия не делается никогда.
  Вторая часть — `'./clawforge' 'backup'\"" /f` — «is not recognized».
- Windows PowerShell 5.1 (по коду): `&&` вне строки — ошибка разбора, не выполняется ничего.

`--apply` передаёт тот же `/tr` массивом аргументов и создаёт верную задачу — ломается только
напечатанная строка. То же в `watch install` (`/sc MINUTE /mo 5`). `schedule.check.ts:145-150`
сравнивает строку с `displayCommandLine(...)`, но не проверяет, что её разберёт оболочка.

Предложение: внутренняя команда без спецсимволов `cmd` (`& | < > ^ %`) вне кавычек — например
`set -e; cd -- '…'; exec './clawforge' 'backup'` вместо `&&`; подписать строку «для cmd.exe»,
для остальных оболочек отправлять к `--apply`; путь с `%` отвергать, как это делает `cronLine`.
Проверка: напечатанная строка, разобранная по правилам `cmd` и `CommandLineToArgvW`, даёт тот же
`/tr`, что передаёт `--apply`.

### R28-03 (P3). Регистр `apps` на Windows отключает передачу шлюзу

`delegate.ts:83` узнаёт развёртывание чекаута по `basename(parent) === "apps"`. На Windows
файловая система не различает регистр, а `process.cwd()` хранит путь в том виде, в каком его
набрали. Из `APPS/r28c` (тот же каталог) передачи нет, глобальный пакет сам грузит
`apps/r28c/app.ts`, а тот импортирует `../../tools/framework/...` — в процессе две копии
фреймворка, и их состояние расходится:

```
                      apps/r28c                            APPS/r28c
version --verbose     source: checkout                     source: global
status                nothing deployed yet — run            error: /srv/r28c/data does not exist on the
                      clawforge bootstrap (код 0)           target — … never been bootstrapped (код 1)
backup install        печатает инструкции (код 0)          error: no deployment selected — the entry
                                                           point must call useDeployment() (код 1)
```

Механизм (по коду): `NotBootstrapped` из другой копии модуля не проходит `instanceof`, а
`deploymentDir()` второй копии никто не выставлял. Подсказки там же — `./clawforge expose
status` (префикс второй копии).

Предложение: сравнивать без учёта регистра на win32 или брать `realpathSync.native(appRoot)`
до всех проверок. Вдобавок: если `app.ts` лежит внутри чекаута (`findCheckoutRoot(appRoot)`), а
передачи не было, — отказ с понятным текстом вместо загрузки второй копии.

### R28-04 (P3). `lock --check`: фикс R27-07 не дошёл до `--json` и MCP

Текстовый вывод разделён верно, но ветка `jsonOnly || isCaptured()` (`lock.ts:308-311`)
осталась прежней. На ни разу не поднятом `app1`:

```
$ clawforge lock --check --json   → { …, "nextActions": ["clawforge up", "clawforge lock"] }
                                    error: 3 difference(s) from the lock          (код 1)
```

MCP-инструмент `lock` с `check: true` в `apps/r28c` — тот же итог в тексте ответа
(«…\n\n3 difference(s) from the lock»). Агент, ради которого MCP и существует, получает ровно ту
формулировку, которую R27-07 назвал неверной. CHANGELOG честно пишет «The exit code and the
`--json` output are unchanged», но итоговая строка ошибки — не часть JSON-документа, её можно
было поправить, не трогая его.

Попутно:
- у текстового вывода больше нет строки `==>`: он начинается с отступа
  `    could not compare — instance is not running:`;
- экземпляр не «не запущен», а ни разу не поднят (`doctor` рядом говорит `NOT_BOOTSTRAPPED`),
  а `nextAction` для `GATEWAY_DOWN` — `up`, который на таком экземпляре отказывает
  («… never been bootstrapped — run ./clawforge bootstrap»).

Предложение: одна функция итога для обеих веток; для непрочитанных списков на неподнятом
экземпляре — `bootstrap` в `nextAction` и «never bootstrapped» в тексте; заголовок `==>` перед
разделами.

### R28-05 (P3). MCP развёртывания чекаута советует несуществующий `./clawforge`

`new-app` пишет: «open the deployment directory in Claude Code or Codex». Загрузчик
`apps/r28c/mcp-launch.mjs` делает `chdir(apps/r28c)` и запускает шлюз с `--app r28c` без
`CLAWFORGE_INVOKED_AS`, поэтому `tools/clawforge.ts:305` ставит префикс
`./clawforge --app r28c`. Ответ MCP на `lock` с `check: true`:

```
"nextActions": ["./clawforge --app r28c up", "./clawforge --app r28c lock"]
```

В `apps/r28c` файла `clawforge` нет (`new-app` шим не пишет), и агент, выполнив подсказку в
shell, получит «No such file or directory». R27-08 решил ту же задачу только для загрузчика
установленного приложения (`defaultInvocation`).

Предложение: загрузчик развёртывания чекаута передаёт `CLAWFORGE_INVOKED_AS=../../clawforge`
(шим чекаута находит корень сам), и тогда префикс — `../../clawforge --app r28c`; либо шлюз
строит путь к шиму относительно `process.cwd()`.

### R28-06 (P3). Справка вне приложения — остатки R27-03

```
$ clawforge                 (вне приложения)   → error: no app.ts in … (код 1), списка команд нет
$ clawforge                 (в приложении)     → справка
$ clawforge help int                          → error: "int" is a deployment command: it needs an
                                                app folder … — run: clawforge init   (код 1)
```

- Без аргументов — самое первое, что набирают после установки; внутри приложения это справка,
  снаружи — ошибка. CHANGELOG оставил «every other command» с ошибкой, но пустой вызов —
  не команда.
- `help <имя>` для любого неизвестного имени утверждает, что это команда развёртывания,
  подсказки «did you mean: init» нет. Список команд развёртывания известен без `app.ts`
  (`openclawCommands`), его можно использовать и для проверки, и для подсказки.
- В чекауте (`docs/`, пустая `apps/r28new`) справка перечисляет `init` и заканчивается
  «create one with: clawforge init», `help status` — «run: clawforge init», а сам `init` там
  запрещён (R27-05).
- `clawforge init --local` из подпапки приложения (`app1/recipes`) — «already holds app.ts —
  … init here would nest a second one», хотя `--local` ничего не пишет; документация говорит
  «it works at any time».

Предложение: пустой вызов вне приложения = `help`; неизвестное имя — «unknown command» с
подсказкой по `openclawCommands` + команды шлюза; в чекауте справка говорит «это чекаут:
`clawforge help` в его корне» вместо `init`; `init --local` обходит проверку вложенности.

### R28-07 (P3). Совет после отказа в чекауте

`bin.ts:56`: «create one from its root with: `'./clawforge' new-app <name>`», `bin.ts:106`:
«`'./clawforge'` in its root is the entry». Кавычки нужны, чтобы `localizeHints` не заменил
префикс, но строку получает пользователь глобальной команды, то есть скорее всего `cmd` или
PowerShell (`invocation.ts`: «`./clawforge` does not even run in cmd.exe or PowerShell»). В
PowerShell `'./clawforge' new-app x` — строковый литерал и ошибка разбора, в `cmd` — «is not
recognized». При этом `clawforge new-app r28x` из корня чекаута работает: `checkoutGate(appRoot)`
передаёт вызов шлюзу (воспроизведено, создан `apps/r28x`). Про то, что только что созданную
пустую папку надо убрать (см. R28-01), совет молчит.

Предложение: `${cli("new-app <name>")}` из корня чекаута (и `./clawforge` как второй вариант
для bash); если текущая папка пуста — сказать, что её надо удалить или взять её имя после
правки R28-01.

### R28-08 (P3). Автодополнение `--app`

`completion.ts:78`: `LIST_NAMES_JSON = "$(./clawforge list --json …)"`.

- `list --json` без `--no-status` опрашивает цель каждого развёртывания по очереди
  (`list.ts:140-142`) — на каждый Tab после `--app`. С одним развёртыванием на WSL — 1,74 с
  против 1,56 с с `--no-status`; с ssh-целями это соединения и их тайм-ауты.
- `./clawforge` берётся относительно текущей папки: в корне чекаута значения `.r28 r28c`
  (см. R28-01), в `apps/r28c` — пусто, хотя глобальная команда там `--app` принимает
  (R27-04). Проверено вызовом `_clawforge_complete` с `COMP_WORDS=(clawforge --app "")`.
- Скрипт зависит от места генерации (набор команд шлюза, есть ли `--app`), а `complete -F`
  вешается сразу на `clawforge` и `./clawforge` (`:145-146`). Сгенерированный в чекауте
  предлагает `--app` и в установленных приложениях, где `clawforge --app app1 status` →
  «unknown command: --app» (R27-04 научил принимать своё имя только развёртывания чекаута).

Предложение: `"${COMP_WORDS[0]}" list --json --no-status` с фильтром по реальным развёртываниям;
в установленном приложении `--app <своё имя>` принимать так же, как `withApp`, другое — внятный
отказ.

### R28-09 (P3). Проверки фиксов R27 держат меньше, чем кажется (по коду)

- `invocation-hints.check.ts:63-77` проверяет, что `infoRaw` печатает строку как есть, а `info`
  её переписал бы. Места вызова (`backup/install.ts:83`, `watch/install.ts:117`,
  `schedule.ts:409, 421`, `deploy/index.ts:66`, `deploy/sync.ts:141, 157`) не проверяет никто:
  `setInvocation` вызывает только этот файл, а под префиксом по умолчанию `info` и `infoRaw`
  совпадают. Откат любого из семи мест на `info` — зелёный набор.
- `lock-home.check.ts`: «сбой один раз, потом ответ» проверен и различает старый и новый код,
  ветка «три отказа подряд = каталог, куда нельзя войти» — нет.

Предложение: одна проверка на команду — `backupInstall`/`watchInstall` (заглушка транспорта) и
`printSchedulingInstructions` под `setInvocation("clawforge")`: напечатанная строка равна
установленной/переданной; для `sudoFor` — `exists`, бросающий всегда.

### R28-10 (P3). Тексты и гигиена

- `bin.ts:82-83`: в `details` у `init` перевод строки посреди фразы («`init --local` in an
  already\ninitialised directory…») — `help init` и MCP-справка печатают оборванную строку.
- `destroy.ts:142, 147`: на неподнятом развёртывании пробный
  `destroy --backups --snapshots` печатает «would remove /srv/app1/backups (OC_BACKUP_DIR,
  absent)», а следом «dry run — nothing to remove». Отсутствующий каталог лучше показывать
  как «absent — nothing to remove», без «would remove».
- `init.ts:253` `packageDirectory()` повторяет `lock.ts:91` `frameworkPackage()` (те же два
  кандидата, та же проверка `name`); `root.ts:43` `isWithin` повторяет проверку в
  `version.ts:43-44`.
- `entry/root.ts:5` импортирует командный модуль `commands/management/lock.ts` ради чтения
  `package.json` — вход зависит от команды. Место `frameworkPackage` — рядом с `frameworkRoot`.

## 3. Что хорошо

- `--app` при передаче из `apps/<имя>` работает во всех формах: `--app r28c`, `--app=r28c`,
  чужое имя — понятная ошибка, пустое — «--app needs a deployment name», после команды —
  «--app must come before the command». Из `apps/r28c/recipes` развёртывание находится,
  подсказки без `--app`.
- Строки для другой оболочки печатаются как есть: `backup install`/`watch install` на WSL-цели
  показывают `'./clawforge'` в кавычках и под глобальной командой.
- `init` пишет имя папки: справка «app1 — self-hosted OpenClaw instance», `serverInfo` —
  `app1-control` и `r28c-control`.
- `init --local` в инициализированной папке — строка `npm install --no-save "<каталог
  пакета>"`, код 0, файлы не тронуты; обычный `init` там по-прежнему отказывает.
- Пробный `destroy` на неподнятом развёртывании не зовёт sudo, код 0.
- `help`, `--help`, `help init` вне приложения работают, код 0; `init` в чекауте отказывает, не
  написав ни файла.
- `tools/list`: 30 442 байта у установленного приложения, 31 700 у развёртывания чекаута —
  под бюджетом 32 768, который держит `mcp-mirror.check.ts`.
- Лимиты раскладки соблюдены: самый длинный файл — 672 строки, каталоги с исходниками — не
  больше 7 записей.

## 4. Порядок работ

1. R28-01, R28-07 — тупик после отказа `init` в чекауте и развёртывания из пустых каталогов.
2. R28-02 — строка планировщика, которая в `cmd` тихо создаёт пустую задачу.
3. R28-04, R28-05 — ответы агенту: итог `lock --check` в MCP, подсказки развёртывания чекаута.
4. R28-03 — регистр `apps` на Windows.
5. R28-06, R28-08 — справка вне приложения, автодополнение `--app`.
6. R28-09, R28-10 — проверки и тексты, по мере касания кода.
