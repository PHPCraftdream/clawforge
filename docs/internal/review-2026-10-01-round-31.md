# Ревью ClawForge, раунд 31 — после фиксов раунда 30

Дата: 2026-10-01. База: `main` @ 6c43b01. Предыдущий: раунд 30
(`docs/internal/review-2026-10-01-round-30.md`, R30-01…R30-08 закрыты коммитами 7480bda,
573e6a1, 42ecba6, 141212b, 23b5ae0, 88c1f6b и 6c43b01). Сами фиксы раунда 30 повторного ревью
ещё не проходили — это первое.

Запрос: независимое ревью по фактам — ошибки, неточности, удобство, недостающие инструменты,
пахнущий код.

Метод: разбор `git diff 650edf9..HEAD` (45 файлов: `entry/bin.ts`, `entry/delegate.ts`,
`tools/clawforge.ts`, `recipe/hook-graph.ts`, `recipe/hook-loader.ts`, `integration/gate.ts`,
`core/arguments.ts`, `integration/completion.ts`, `mcp/schema.ts`, `schedule.ts`, `backup/*`,
`sets/*`, `process-identity.ts`, `archive/profile.ts`, `destroy.ts`, руководство, CHANGELOG и
проверки к ним). Пробы — свежий `dist/` этой ревизии (`npm run build`); роль системной команды,
как в раундах 28–30, играла копия собранного пакета в
`apps/.r31/g/node_modules/@clawforge/framework` (`version --verbose` → `source: global`), запуск
`node …/dist/entry/bin.js` из игнорируемых каталогов под `apps/`: установленное приложение
`apps/.r31/app1` (`init` через `--project-root`), развёртывания чекаута `apps/r31c`, `apps/r31d`
(`./clawforge new-app`) и `apps/r31e` — то же, но `app.ts` переписан на импорты
`@clawforge/framework/app|mounts|commands` (вторая половина R30-01), подпапка `docs/`, пустые
`apps/.hidr31`, `apps/Bad R31`, `apps/emptyr31`. Команды: `help` (в приложении, вне его, в корне
чекаута с двумя развёртываниями, в подпапке), `<command> --help|-h`, `<command> <action> --help`,
опечатки, `init`, `init --local`, `version` (все флаги), `status`, `doctor`, `lock --check`
(текст и `--json`), `plan`, `secrets`, `backup list|create|--dry-run|lst|crate|--keep`,
`backup install` с 9 значениями `--interval`, `watch install|status`, `destroy` (пробный),
`expose status|statsu`, `set build|validate|diff|receipts|try|forget` с флагами чужих действий,
`set build` и `set validate --set` на собранном артефакте (фиктивный `@sha256`), `recipe
list|new --with-hooks|lst`. Загрузка хуков рецептов — собственным `importHookModule` фреймворка:
в чекауте 9 спецификаторов (`…/private-config?x=1`, `…#frag`, `…/../../package.json`, `…/./app`,
голый пакет, `@clawforge/frameworkX/app`, внутренний `…/core/env.ts`, динамический `import()`,
неэкспортируемое имя), в установленном приложении — из `dist` глобальной копии после
`resolveFrameworkFromSelf()`. MCP: `initialize` + `tools/list` обоих видов, скан всех описаний
аргументов. Автодополнение: `bash -n`, вызов `_clawforge_complete` с заданными `COMP_WORDS`
(13 строк), тексты zsh и pwsh. Граф импортов `tools/framework` (скрипт: статические импорты без
`import type`, компоненты сильной связности) и загрузка каждого модуля из циклов первым импортом
в отдельном процессе. `npm pack --dry-run` пакета. `upgrade` — на заглушке рантайма из
`upgrade.check.ts`. Мутационные пробы проверок (каждая откачена, `git status` после — чистый):
убран вызов `resolveFrameworkFromSources()` в `tools/clawforge.ts`; `START_TIME_TOLERANCE_MS =
2_000`; `restoreData = true` при любой ошибке здоровья в `upgrade`; повтор мутации R30-04
(`watch status` ← срез `install`). Прогнаны проверки: `hook-framework-import`, `foundation/cli`,
`foundation/core/arguments`, `cycle-lock`, `compose-sweep`, `connection-facts/upgrade`.
Статически — `upgrade` и откат, `incident` (ротация токена), сборка и проверка наборов,
упаковка, руководство против поведения, лимиты раскладки, допуски в проверках. Вывод, сделанный
рассуждением, а не воспроизведением, помечен «по коду». Каталоги проб удалены.

Не проверялось: живой `bootstrap`/`up`/`upgrade`/`recipe verify` — цель не менялась (`status`,
`doctor`, `lock --check`, `plan`, `secrets`, `backup list`, `expose status` и пробный `destroy`
только читали WSL-цель); `upgrade` против настоящего Docker — только на заглушке, формат
`RepoDigests` — по коду. Linux-хост, ssh-цель, macOS. PowerShell, `cmd.exe` и `zsh` не
запускались (среда ревью запрещает PowerShell): скрипт `completion pwsh` разобран по тексту.
`system-install.check.ts` и полный `npm run check` не запускались.

Шкала: P0 — ломает данные/безопасность; P1 — ломает основное обещание; P2 — неверное
поведение в реальном сценарии; P3 — шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| R31-01 | P2 | `commands/lifecycle/instance/upgrade.ts:67-72, 164, 254, 289-306`, `runtime/docker/container-introspection.ts:135`, `docs/guide/commands.md:65`, `docs/guide/data-and-backups.md:332-335`, `openclawCommands.lifecycle.ts:289-291` | откат неудачного `upgrade` закрепляет в `.env` первый `RepoDigests` — `repo@sha256:…` без тега: канал `OPENCLAW_IMAGE` пропадает, следующий простой `upgrade` (и `--dry-run`) отказывает и объясняет это «старым закреплением, сделанным до того, как upgrade научился хранить тег»; руководство утверждает то же; воспроизведено на заглушке рантайма из `upgrade.check.ts` |
| R31-02 | P3 | `integration/mcp/schema.ts:170-185, 198-208`, `checks/foundation/core/arguments.check.ts:579-594`, `CHANGELOG.md:37-39` | фикс R30-06 неполон: в `tools/list` 8 описаний по-прежнему обрываются на полуслове (`recover-env.adopt-runtime` «merge its», `incident.keep-exposure` «published on every», `backup.apply` «instead of only», `set.keep` «tearing it», `cli.args` «e.g.», `check.filter` «—», `pull.migrate`, `accept.set`), у `secrets.json` срезанное «with» перевернуло смысл («… as JSON — refused»); проверка сверяет обрезку с её же списком слов и не видит опций с областью; запас бюджета `tools/list` — 912 байт; воспроизведено |
| R31-03 | P3 | `core/arguments.ts:95-111`, `commands/sets/set.ts:37-62, 175-190`, `set-try.ts:99`, `set-diff.ts:314`, `set-receipts.ts:18`, `watch/check.ts:38`, `watch/index.ts:20-26`, `watch/status.ts:39` | фикс R30-04 неполон: при слиянии срезов побеждает первое описание — `set --help` и MCP называют `--name` у `forget` «Set name (default: the deployment's name)», `--json` у `validate`/`diff`/`receipts`/`try` — «Emit the manifest and its id»; `watch --json` всё ещё «With check/status:» при области (check, status, test); `set try|diff|receipts` с чужим флагом — «unknown argument» без имени действия; мутация R30-04 снова проходит проверку; воспроизведено |
| R31-04 | P3 | `sets/set-manifest.ts:71-87`, `set/ownership/validate.ts:117-119, 212-214`, `set/artifacts/install.ts:324, 433`, `sets/set.ts:99-107, 136-144` | `set build` без закреплённого образа всё ещё советует `lock` (R30-07 исправил только `validate`); проверка артефакта пропускает полноту рецептов (`checkFiles: false`), хотя артефакт распакован и `recipesDir()` указывает в него: дерево — «9 blocking», `set build` того же дерева проходит, `set validate --set` на его артефакте — «is coherent»; `validate --set` печатает «installing from …», блокирующие находки выводятся как `warning:`; воспроизведено |
| R31-05 | P3 | `commands/operate/schedule.ts:108-125`, `CHANGELOG.md:62-67` | отказ `backup install` на голое число подсказывает значения, которые сам же отвергает (`1440` → «1440m or 1440h», `90` → «90m or 90h», `0` → «0m or 0h»), вопреки обещанию R29-05 «never a value the command itself rejects»; общий отказ для `backup` начинается с «must be a number of minutes», хотя число без единицы `backup` отвергает; воспроизведено |
| R31-06 | P3 | `integration/gate.ts:85-117, 127-139`, `tools/clawforge.ts:281`, `entry/bin.ts:81` | хвосты R30-02: `<command> <action> --help` в корне чекаута при нескольких развёртываниях или без них — «several deployments» (`watch install --help`, `backup install --help`, `set build --help`), хотя `help watch install` работает; `help list`/`help new-app` в подпапке чекаута — «unknown command»; строка `cd <чекаут>` без кавычек; причина отказа `init` в чекауте («installed-style deployment it cannot load») после R30-01 неверна; остаток `<command> -h` сам по себе не важен; воспроизведено |
| R31-07 | P3 | `integration/completion.ts:104-107, 228-238` | `backup --<Tab>` и `backup --h<Tab>` — первая и самая частая позиция — дают только `--help`: фикс R30-05 добавил флаги создания лишь после первого флага (bash/zsh — воспроизведено); в pwsh на этой позиции — только слова действий, а после пробела (`clawforge backup <Tab>`, `clawforge status <Tab>`) скрипт предлагает имена команд — по коду |
| R31-08 | P3 | `checks/integration/agent/recipe-hook-freshness/hook-framework-import.check.ts:87-91`, `checks/runtime/watch/check/cycle-lock.check.ts:91-102`, `checks/runtime/connection-facts/upgrade.check.ts:150-161`, `checks/sets/lifecycle/set-module-load.check.ts:11-21` | проверки, которые не различают: без вызова `resolveFrameworkFromSources()` `app.ts` чекаута с публичным спецификатором не грузится, а 8 файлов проверок проходят; `START_TIME_TOLERANCE_MS = 2_000` проходит «закрепление» 15 с; сценарий `health-fail` в `upgrade` падает ещё в бэкапе, мутация «восстанавливать бэкап при любой ошибке здоровья» проходит; `set-module-load` собирает `file:///` руками и покрывает только `sets/*`, а циклов импорта ещё два; воспроизведено |
| R31-09 | P3 | `CHANGELOG.md:30-31, 35-37, 43, 57-67`, `system-install.check.ts:244`, `help-groups.check.ts:63`, `entry/delegate.ts:16`, `recipe/hook-graph.ts:247-269`, `integration/gate.ts:121-123`, `core/arguments.ts:86-89`, `sets/set.ts:108-122` | гигиена: 88c1f6b вернул в CHANGELOG устаревший пункт R29 (оборванное предложение и «the bare number is new for backup»), «a reused pid starts minutes after» осталось, три пункта переоценивают фиксы; метка «status -h» у проверки `--help`; копия `regexEscape` в проверке мимо аудита; `entry/` берёт карту экспортов пакета из модуля хуков рецептов, она и `CHECKOUT_GATE_COMMANDS` — вторые копии без обратной сверки; `actionLabel` стал тождеством; мёртвые ветки в `validateAction` |

P0 и P1 нет.

## 2. Подробно

### R31-01 (P2). Откат `upgrade` стирает тег канала из `OPENCLAW_IMAGE`

Заглушка рантайма из `upgrade.check.ts` (сценарий `doctor-fail` — откат после блокирующей
находки `doctor --lint`), но `.env` до запуска закреплён так, как его оставляют `bootstrap` и
успешный `upgrade`:

```
OPENCLAW_IMAGE before: ghcr.io/openclaw/openclaw:extended-stable@sha256:pinned…
$ upgrade  → upgrade failed and was rolled back to ghcr.io/openclaw/openclaw@sha256:previous…: openclaw doctor --lint reported blocking finding(s): …
OPENCLAW_IMAGE after : ghcr.io/openclaw/openclaw@sha256:previous…
$ upgrade  → OPENCLAW_IMAGE is "ghcr.io/openclaw/openclaw@sha256:previous…" — a digest with no tag alongside it,
             so the channel it was pulled from is unknown and cannot be re-resolved (an older pin, from before
             upgrade could keep the tag). Name the channel explicitly: ./clawforge upgrade --image <repo:tag>.
```

- `previousDigest` — это `identity.digests[0]` (`upgrade.ts:254`, под замком —
  `current.digests[0]`, `:289-306`), то есть `RepoDigests` образа
  (`container-introspection.ts:135`). У Docker `RepoDigests` всегда вида `repo@sha256:…`, без тега.
- `rollbackUpgrade` после подтверждённого отката вызывает `pinImageReference(previousDigest)`
  (`:164`) и переписывает `.env`, хотя неудачное обновление `.env` не трогало: новое значение
  пишется только при успехе (`:215`). Успешный путь сохраняет канал (`repo:tag@sha256:…`,
  `image-digest.ts:25`), откат — нет.
- Следующий `upgrade` без `--image` упирается в `channelHasTag` (`:67-72`) и отказывает; тот же
  отказ у `upgrade --dry-run` (по коду: цель разрешается до ветки `--dry-run`), так что и вопрос
  «есть ли обновление» перестаёт работать. Повторная
  попытка после неудачного обновления — ровно тот момент, когда оператор вернётся, и сообщение
  называет неверную причину.
- Справка и руководство обещают, что закрепление без тега бывает только «from before pins kept
  one» (`openclawCommands.lifecycle.ts:289-291`, `commands.md:65`, `data-and-backups.md:332-335`).
- Если образ известен Docker под несколькими репозиториями (зеркало реестра), `RepoDigests[0]`
  может назвать другой реестр — откат переключит `.env` на него (по коду).
- Проверки этого не видят: сценарии Docker-свидетеля в `upgrade.check.ts` начинают с
  `OPENCLAW_IMAGE=PREVIOUS_DIGEST` без тега (`:234`), поэтому «durable pin stays A» совпадает с тем,
  что пишет откат.

Предложение: при откате не закреплять заново, а вернуть строку `OPENCLAW_IMAGE` из `preparedEnv`
(именно она была проверена до обновления), либо закреплять `${imageChannel(declared)}@<hash>`,
когда в объявленном образе был тег. Проверка: откат из `repo:tag@sha256:A` оставляет `.env`
побайтно прежним, а следующий `upgrade --dry-run` не отказывает.

### R31-02 (P3). Описания MCP: обрезка всё ещё рвёт фразы и меняет смысл

Скан `tools/list` развёртывания чекаута (45 инструментов) после фикса 23b5ae0:

```
recover-env.adopt-runtime:  Take the running container as authoritative: merge its
incident.keep-exposure:     Proceed even though the gateway is published on every
backup.apply:               Actually apply the action instead of only (prune-replaced, install, uninstall)
set.keep:                   leave the throwaway instance running instead of tearing it (try)
pull.migrate:               Migrate profile — accepted so backup and pull share
accept.set:                 Check this verified artifact's declarations and save (value: <artifact>)
cli.args:                   Arguments passed to OpenClaw's CLI verbatim, e.g.
check.filter:               Only run checks whose relative path contains this text —
secrets.json:               Emit the default read-only report as JSON — refused
```

- Пять из них (`adopt-runtime`, `set.keep`, `pull.migrate`, `accept.set`, `secrets.json`) были в
  списке R30-06. Фикс снимает с конца только 20 служебных слов (`schema.ts:182-183`); «its»,
  «every», «only», «it», «e.g.», тире и обрыв посреди глагольной группы он не видит.
- `secrets.json`: исходный текст — «… as JSON (names/state/where-found only, never values) —
  refused with --template/--print-template/--init-store/--apply/--dump». До фикса было «— refused
  with» (обрыв, но видно, что дальше условие), теперь «— refused»: агент прочтёт, что `json`
  отвергается сам по себе. Снятие предлога унесло условие. `incident.keep-exposure` потерял
  «interface».
- `backup.action` теперь «list, prune-replaced, install, uninstall or create»: что без `action`
  создаётся архив, не сказано нигде в схеме, а флаги создания помечены просто «(create)». Комментарий
  `schema.ts:201-203` («is labelled as such, so a client knows `hot` without an `action` still
  means a create») этому не соответствует.
- Проверка (`arguments.check.ts:583`) использует тот же список слов, что и реализация, — она может
  подтвердить только саму себя. К тому же `bare` снимает лишь последнюю скобку (`:590`), и у опции
  с областью и значением (`watch.interval`, `backup.keep`, `set.set`) проверяется строка вида
  «… (install)», которая никогда не совпадёт.
- Строка ответа `tools/list` чекаута — 31 856 байт из 32 768 (в R30 было 31 743, прибавили
  суффиксы «(create)»): запас 912 байт, `mcp-mirror.check.ts` упадёт после пары новых флагов.

Предложение: не резать посреди предложения вообще — брать текст до последней границы (`,`, `—`,
`;`, `(`) в пределах 60 символов, иначе ставить «…»; этим девяти аргументам дать короткие явные
описания схемы (как `SHARED_SCHEMA_DESCRIPTIONS`; это и экономит байты), `backup.action` —
«…; omit to create a backup». Проверка: короткий текст — префикс исходного, обрезанный на
границе или с «…»; суффиксы области и значения отделять по структуре, а не регулярным выражением.

### R31-03 (P3). `set` и `watch`: описания срезов и дрейф-проверка

```
$ ./clawforge --app r31c set --help
  --name <name>   Set name (default: the deployment's name) (build, validate, forget)
  --json          Emit the manifest and its id as JSON (build, validate, diff, receipts, try)
tools/list:  set.name: "Set name (build, validate, forget) (value: <name>)"
             set.json: "Emit the manifest and its id as JSON (build, validate, diff, receipts, try)"
$ ./clawforge watch --help
  --json          With check/status: emit JSON instead of text (check, status, test)
$ ./clawforge --app r31c set validate --kind agent   → error: --kind applies to `forget`, not `validate`
$ ./clawforge --app r31c set try --kind agent        → error: unknown argument: --kind
$ ./clawforge --app r31c set receipts --set x        → error: unknown argument: --set
$ ./clawforge --app r31c set diff --kind agent       → error: unknown argument: --kind
```

- `scopeByAction` оставляет первое объявление имени (`arguments.ts:97`), а срезы `set` теперь
  описывают одно имя по-разному: `--name` — «Set name (default: …)» у `build`/`validate` и «The
  object's name» у `forget` (`set.ts:37-53`); у `--json` пять вариантов, причём `receipts` и `try`
  несут старый общий текст «the manifest and its id, or the findings». Для `forget` `--name` —
  обязательное имя удаляемого объекта, а справка и MCP называют его именем набора; до 23b5ae0 там
  было «with forget, the object's name».
- `watch --json` (`watch/check.ts:38`) — ровно строка из R30-04; фикс тронул только `set`.
- `try`, `diff`, `receipts` разбирают свои срезы без `scope` (`set-try.ts:99`, `set-diff.ts:314`,
  `set-receipts.ts:18`), диспетчер отдаёт их раньше разбора с областью (`set.ts:175-190`). CHANGELOG
  (`:30`) обещает «a flag of another action is refused naming that action».
- Мутация R30-04 повторена: `watch/index.ts:24` `status: WATCH_INSTALL_ARGUMENTS` —
  `check foundation/core/arguments foundation/cli` (8 файлов) проходят, хотя автодополнение и
  справка снова предложили бы `watch status --interval`, а настоящий `watchStatus` разбирает
  `WATCH_CHECK_ARGUMENTS` напрямую (`watch/status.ts:39`). Настоящие разборщики проверка дёргает
  только у `set` (7 точечных случаев), `backup` (5) и `recipe` (через `validateRecipeArgs`); у
  `watch` и `expose` она по-прежнему сверяет реестр с самим собой. CHANGELOG (`:30-31`, «the drift check drives the real dispatcher, not the registry
  against itself») верен лишь для `set`. Откачено.

Предложение: при слиянии срезов требовать одинаковое описание у одного имени (или выводить
описание по действиям: «--name: set name (build, validate); object name (forget)»); убрать «With
check/status:» у `watch --json`; `try`/`diff`/`receipts` разбирать с той же областью; в `watch` и
`expose` брать срез из таблицы `*_ACTION_ARGUMENTS`, а проверку вести через `openclawCommands.<cmd>.run`
на заглушке, как уже сделано для `set`.

### R31-04 (P3). `set build` и проверка артефакта расходятся с проверкой дерева

```
(apps/r31c: в recipes/ девять каталогов только с verify.ts; OPENCLAW_IMAGE — сначала тег)
$ ./clawforge --app r31c set build
  error: no image digest to pin the set to — …:extended-stable is a tag, …
  Run ./clawforge --app r31c lock to record the digest that was proven, or set OPENCLAW_IMAGE to a @sha256 reference.
(OPENCLAW_IMAGE — фиктивный repo:tag@sha256:0…01)
$ ./clawforge --app r31c set validate
  ==> set r31c: 9 blocking, 0 warning(s)
  warning: SET_RECIPE_INCOMPLETE  recipe "hk-x" is neither an MCP recipe (server.ts) nor a service (recipe.json)   (×9)
  error: 9 blocking finding(s): SET_RECIPE_INCOMPLETE, SET_RECIPE_INCOMPLETE, … (код повторён 9 раз)
$ ./clawforge --app r31c set build                           → built set r31c …, артефакт записан
$ ./clawforge --app r31c set validate --set apps/r31c/sets/r31c-<id>.tar.gz
  ==> installing from apps/r31c/sets/r31c-<id>.tar.gz
  ==> set r31c (<id>) is coherent and its artifact contents match                                  (код 0)
```

- Совет `set build` (`set-manifest.ts:83-87`, и при чужом `reference` в блокировке — `:71-76`) всё
  ещё ведёт в `lock`, который до первого `bootstrap` отказывает (R30-07). Фикс сменил только
  `nextAction` у `SET_IMAGE_UNPINNED` (`inspection.ts:290-296`): для одного и того же состояния
  `validate` советует `bootstrap`, `build` — `lock`.
- Проверка артефакта — `validateSet(manifest, { checkFiles: false })` внутри `withSetSource(staging,
  …)` (`install.ts:324`). Артефакт к этому моменту распакован, и `recipesDir()` указывает в
  `staging`, так что довод `validate.ts:117-118` («a built artifact carries files as checksums, not
  paths on this machine») здесь не действует (по коду), а проверки полноты (`recipe.json`,
  `server.ts`, `agent/config.json`) пропускаются. Комментарий `validate.ts:212-214` («validating a
  built artifact must answer exactly as validating the tree it came from») не выполняется.
  `unpackArtifactVerified` — ворота и для `apply --set`, `plan`, `rollback --previous-set`,
  `set try`, `set diff`, `accept --set`: неполный рецепт проходит в установку. `set build` находки
  `validate` не проверяет (это задача `validate`), так что находки полноты после сборки больше нигде
  не всплывают.
- `validate --set` печатает «installing from …» — общая строка `withUnpackedArtifact`
  (`install.ts:433`), и проверка выглядит как установка.
- Текстовый вывод `validate` печатает каждую находку через `warn()` (`set.ts:138`): блокирующие —
  с префиксом `warning:` под заголовком «9 blocking» (`doctor` пишет `blocking:`); итог повторяет код
  столько раз, сколько находок. Ветка артефакта отдаёт `problems: []` (`set.ts:102`), предупреждения
  артефакта теряются.

Предложение: совет `set build` — тот же, что у `validate` (до первого `bootstrap` — `bootstrap`,
он закрепит digest; иначе — `OPENCLAW_IMAGE=<repo:tag@sha256:…>`); в `unpackArtifactVerified` —
`checkFiles: true` (файлы в `staging`) или полнота по ключам `manifest.files`; глагол в строке
`withUnpackedArtifact` — от вызывающего; `blocking:` для блокирующих, коды в итоге без повторов;
предупреждения артефакта — в `problems`.

### R31-05 (P3). `backup install`: подсказки к голому числу

```
$ clawforge backup install --interval 1440  → error: --interval needs an explicit unit — 1440m for minutes or 1440h for hours; a bare number is minutes only for watch install — got "1440"
$ clawforge backup install --interval 90    → … — 90m for minutes or 90h for hours; …
$ clawforge backup install --interval 24    → … — 24m for minutes or 24h for hours; …
$ clawforge backup install --interval 0     → … — 0m for minutes or 0h for hours; …
$ clawforge backup install --interval abc   → error: --interval must be a number of minutes or look like 30m, 6h or 1d (minutes, hours or days) — got "abc"
$ clawforge backup install --interval ""    → то же, got ""
```

- Подсказка собирается приписыванием единиц к числу (`schedule.ts:116`) без проверки: `1440m` и
  `1440h` команда отвергает (минуты должны делить 60, часы — сутки), а нужное `1d` не названо;
  `90m`/`90h`, `0m`/`0h`, `24m` — тоже отказы. CHANGELOG (`:65-67`) обещает «never a value the
  command itself rejects».
- Для `backup` общий отказ (`:110`, `:112`) начинается с «must be a number of minutes», а число
  минут — ровно то, что `backup` отвергнет следующим шагом.

Предложение: оба варианта пропускать через `cronSchedule` и называть только принятые, для числа
минут — ближайшие допустимые в том же написании (`1440` → `1d`, `90` → `1h, 2h`); при
`bareMinutes: false` общий текст — «must look like 30m, 6h or 1d».

### R31-06 (P3). Справка в чекауте: остатки R30-02

```
(корень чекаута, apps/: r31c, r31d)
$ ./clawforge watch --help            → справка watch                                      (код 0)
$ ./clawforge watch install --help    → error: several deployments (r31c, r31d) — pick one with --app <name> or OC_APP   (код 1)
$ ./clawforge backup install --help   → то же                                              (код 1)
$ ./clawforge set build --help        → то же                                              (код 1)
$ ./clawforge help watch install      → справка watch                                      (код 0)
(docs/, системная команда)
$ clawforge list        → error: no app.ts in <чекаут>/docs
                          error: list is a checkout command — run it from the checkout root:
                          error:     cd <чекаут>
$ clawforge help list   → error: unknown command: list                                     (код 1)
$ clawforge help new-app → error: unknown command: new-app                                 (код 1)
(пустая apps/emptyr31)
$ clawforge init        → … init would write an installed-style deployment it cannot load; … new-app emptyr31 takes over this empty directory, or remove it
(apps/r31e — app.ts с импортами @clawforge/framework/app|mounts|commands)
$ ./clawforge --app r31e lock --check → загружается, обычный отчёт; list показывает r31e
```

1. `isDeploymentHelpRequest` (`gate.ts:137-138`, вызов — `tools/clawforge.ts:281`) требует ровно два
   слова. У команд с действиями естественная форма — `<command> <action> --help`, и внутри
   развёртывания `requestsHelp` (`entry/cli.ts:34-37`) находит `--help` в любом месте; так же не
   работает `<command> --json --help`.
2. `help <команда чекаута>` в подпапке: `helpWithoutDeployment` (`gate.ts:85-89, 117`) не знает
   `CHECKOUT_GATE_COMMANDS` — регрессия R30-02 исправлена для `list`, но не для `help list`.
3. Строка `cd ${checkout}` (`gate.ts:131`) без кавычек: путь с пробелом ломается в любой оболочке,
   а Windows-путь с обратными косыми Git Bash, куда подсказку скорее всего вставят, читает как
   экранирование.
4. `bin.ts:81`: «init would write an installed-style deployment it cannot load». После 42ecba6 шлюз
   чекаута загружает такой `app.ts` в `apps/<имя>` (`r31e` выше). Отказ по-прежнему разумен
   (`new-app` пишет форму чекаута, `init` — свой `./clawforge`, `package.json` и MCP-запускатель для
   установленного пакета), но названная причина неверна.
5. Остаток R30-02 `<command> -h`: `requestsHelp` принимает только `--help`, поэтому `-h` после
   команды не справка нигде — с выбранным развёртыванием `watch -h` → «unknown action: -h»,
   `backup -h` → «unknown argument: -h»; в корне с несколькими развёртываниями — «several
   deployments». Поведение согласовано с остальным CLI, отдельной правки не требует, пока `-h` не
   станет синонимом `--help` везде (тогда — и в `isDeploymentHelpRequest`).

Предложение: `isDeploymentHelpRequest` = «первое слово — команда развёртывания и
`requestsHelp(argv)`»; в подпапке чекаута `help <команда чекаута>` — те же строки «run it from the
checkout root» (или её справка из объявлений шлюза); путь в `cd` — в кавычках, либо отдельной
строкой «checkout root: <путь>»; причину отказа `init` переписать.

### R31-07 (P3). Автодополнение `backup` на первой позиции

```
bash, скрипт `clawforge completion bash` установленного приложения (COMP_WORDS → COMPREPLY):
clawforge backup --          => --help
clawforge backup --h         => --help
clawforge backup --hot --    => --dry-run --help --hot --migrate --native --profile --share --with-secrets
clawforge backup create --   => --dry-run --help --hot --migrate --native --profile --share --with-secrets
```

- `bashCaseArm` (`completion.ts:104-105`) на позиции сразу после команды отдаёт только слова
  действий и `--help`; `action.fallback` из 23b5ae0 работает лишь в ветке `*)` — после первого
  слова. Поэтому первый флаг после `backup` (`--hot`, `--dry-run`, `--profile`) не предлагается, а
  `--h<Tab>` дописывает `--help`. zsh использует ту же функцию через `bashcompinit` (тот же текст в
  сгенерированном скрипте). CHANGELOG (`:35-36`): «completion offers the create flags when no action
  word was typed».
- pwsh (`completion.ts:230-233`): на позиции действия — только `$clawforgeActions[$cmd].Keys`,
  `backup --h<Tab>` не даёт ничего.
- pwsh, по коду: когда курсор стоит после пробела, в `$commandAst.CommandElements` нет пустого
  элемента, а скрипт считает дописываемым последний токен (`$idx -eq ($rest.Count - 1)`). Поэтому
  `clawforge backup <Tab>` и `clawforge status <Tab>` получают список команд, а не действия и флаги;
  с набранным префиксом (`backup l<Tab>`, `status --<Tab>`) — верно. Обычный приём — сравнить
  `$cursorPosition` с концом последнего элемента или проверить `$wordToComplete -eq ""`.
- Проверка R30-05 (`arguments.check.ts`) утверждает запасной список только в ветке `*)` и в таблице
  pwsh, первую позицию не смотрит.

Предложение: для необязательного позиционного `action` на первой позиции отдавать `values +
fallback` (bash/zsh) и `Keys + $clawforgeFlags[$cmd]` (pwsh); в pwsh при пустом
`$wordToComplete` считать курсор новым токеном. Проверка: `COMP_WORDS=(clawforge backup --h)`
предлагает `--hot`.

### R31-08 (P3). Проверки, которые не различают

| Мутация (откачена) | Проверки | Итог |
|---|---|---|
| `tools/clawforge.ts`: вызов `resolveFrameworkFromSources()` закомментирован | `hook-framework-import`, `foundation/cli` (8 файлов) | прошли; при этом `./clawforge --app r31e lock --check` → «cannot load deployment "r31e": Cannot find package '@clawforge/framework'» |
| `process-identity.ts`: `START_TIME_TOLERANCE_MS = 2_000` (значение до R29-04) | `cycle-lock`, `compose-sweep` | прошли |
| `upgrade.ts:203`: `restoreData = true` при любой ошибке здоровья | `connection-facts/upgrade` | прошла |

1. `hook-framework-import.check.ts:87-91` проверяет только `typeof resolveFrameworkFromSources ===
   "function"`. Ни одна проверка не грузит через шлюз чекаута `apps/<имя>/app.ts` с
   `@clawforge/framework/*` — половина R30-01 про `app.ts` не защищена.
2. `cycle-lock.check.ts:91-102` строит смещения от самой константы (`START_TIME_TOLERANCE_MS ± 2000`)
   и пройдёт при любом её значении; в 88c1f6b это названо «start-time tolerance pinned». Сам
   компромисс 15 с приемлем: вызывающие — блокировка цикла `watch` (`watch/state.ts:41`) и уборка
   compose-env (`compose-operations.ts:39`), блокировка инстанса живёт на пульсе (`lock-claim.ts` не
   вызывает `localLiveness`). Цена — pid, переиспользованный в пределах 15 с от старта прежнего
   владельца, считается живым, и каждый цикл `watch` получает «watch cycle busy», пока тот процесс
   жив; у блокировки `watch` нет ключа «забрать», `watch status` о ней молчит, руководство
   (`monitoring-and-access.md:73-77`) пишет только «fail closed». Плановые циклы на WSL-цели идут в
   pid-пространстве Linux (pid растут подряд), так что это касается в основном ручных запусков из
   Windows.
3. `upgrade.check.ts:150-161`: в сценарии `health-fail` заглушка `waitForHealth` бросает всегда, и
   первым падает перезапуск после предварительного бэкапа («backup completed but compensation
   failed»); `recreateWithImage` не вызывается ни разу. Утверждения «rolls back to the previous
   digest» и «never restores the backup» выполняются впустую. Сценарий `doctor-fail` до отката
   доходит, но отсутствие восстановления не проверяет.
4. `set-module-load.check.ts:17` собирает URL руками: `` `file:///${file.replaceAll("\\", "/")}` ``.
   `#` в пути чекаута становится фрагментом (у `new URL("file:///…/c#/x.ts")` путь обрывается на
   `/c`), `%` — неверная escape-последовательность, на POSIX получается `file:////…` (работает лишь
   потому, что `//` = `/`); есть `pathToFileURL`. Покрыты только `sets/*`, а скрипт по
   `tools/framework` (170 модулей) нашёл ещё два цикла: `commands/lifecycle/state.ts` ↔
   `commands/management/secrets.ts` ↔ `commands/lifecycle/restore/index.ts` и
   `set/artifacts/install.ts` ↔ `provision-agent/{index,reconcile}.ts` ↔ `orchestration/accept.ts` ↔
   `orchestration/inspect/{gather,live,declared}.ts`. Все 10 модулей сейчас грузятся первым импортом
   (проверено), через циклы ходят только функции, но класс ошибки R30 (константа, прочитанная при
   загрузке) появится там без единой проверки.

Предложение: проверка шлюза чекаута — временный `apps/<имя>` с `app.ts` на публичном спецификаторе
и `./clawforge --app <имя> list`/`lock --check` (или прямой вызов `resolveFrameworkFromSources()` и
`import()` такого `app.ts`); допуск — абсолютными числами (10 с — alive, 20 с — dead); в заглушке
`upgrade` ронять здоровье только после `recreateWithImage` и проверять, что он был вызван;
`set-module-load` — через `pathToFileURL` и по всем модулям, входящим в циклы (или общая проверка
циклов статических импортов со списком разрешённых).

### R31-09 (P3). Гигиена и точность текстов

- `CHANGELOG.md:57-67`: 88c1f6b вставил обратно пункт R29 про `--interval`. Первый пункт обрывается
  на «The refusal names nearest valid values in that», второй продолжает его и утверждает
  противоположное текущему поведению: «a bare number is minutes … (the bare number is new for
  `backup`, which used to refuse it …)».
- `CHANGELOG.md:43`: «a reused pid starts minutes after the original» — R30-08 нашёл это неверным
  для Windows; комментарий в коде (`process-identity.ts:79-84`) исправлен, CHANGELOG — нет.
- `CHANGELOG.md:30-31, 35-36, 37`: «the drift check drives the real dispatcher», «completion offers
  the create flags when no action word was typed», «No MCP … description ends mid-phrase» — см.
  R31-03, R31-07, R31-02.
- `system-install.check.ts:244`: метка «status -h works the same way» у вызова `status --help`.
- `help-groups.check.ts:63` — дословная копия `regexEscape`; аудит единственного определения
  (`layout.check.ts:85-93`) смотрит только `tools/framework`, а проверки могут импортировать
  `#framework/core/io/log.ts`.
- `entry/delegate.ts:16` импортирует `checkoutFrameworkSource` из
  `commands/management/recipe/hook-graph.ts`: карта экспортов пакета — факт упаковки — живёт в
  модуле хуков рецептов и тянется в слой `entry/`. Таблица (`hook-graph.ts:253-258`) — вторая копия
  `exports` из `tools/framework/package.json`; проверка (`hook-framework-import.check.ts:74-85`)
  сверяет одно направление — лишняя запись в таблице пройдёт. Так же `CHECKOUT_GATE_COMMANDS`
  (`gate.ts:121-123`) повторяет руками команды шлюза из `tools/clawforge.ts`; новая команда шлюза в
  подпапке снова станет «unknown command», и ничто это не сверяет.
- `core/arguments.ts:86-89`: после `NO_ACTION = "create"` `actionLabel` возвращает аргумент как есть,
  но `formatActions` и `schema.ts` по-прежнему ходят через него.
- `sets/set.ts:108-122`: после раннего `return` для артефакта (`:99-107`) `fromArtifact` всегда
  ложно — ветка `readManifestFromArtifact`, `checkFiles: !fromArtifact` и `source: fromArtifact ? …`
  мёртвые.

Предложение: убрать устаревший пункт и дописать оборванное предложение; поправить строку про pid и
три переоценки; метку проверки; импорт `regexEscape` в проверке (или аудит и по `tools/checks`);
карту экспортов — в отдельный модуль, читающий `exports` из `package.json`, а список команд шлюза
чекаута — из объявлений `tools/clawforge.ts` (или проверка равенства); удалить `actionLabel` и
мёртвые ветки.

## 3. Что хорошо

- R30-01: загрузчик хуков отображает ровно четыре публичных экспорта. `…/../../package.json`,
  `…/./app`, внутренний `…/core/env.ts`, голый `@clawforge/framework` и `@clawforge/frameworkX` —
  `ERR_MODULE_NOT_FOUND`; `?x=1` и `#frag` отбрасываются и ведут на тот же исходник, выхода за
  пакет нет (мелкое расхождение: установленный пакет `?x=1` отвергает как
  `ERR_PACKAGE_PATH_NOT_EXPORTED`). Путь установленного пакета инертен: `checkoutFrameworkSource` из
  `dist` возвращает `undefined`, в `npm pack --dry-run` (349 файлов, 626 КБ) нет ни одного `.ts`, кроме
  `.d.ts`; хук с `private-config` в установленном приложении грузится через самоссылку. `app.ts`
  чекаута на публичном спецификаторе (`r31e`) грузится, `list` его читает.
- R30-02: `list`/`new-app` из `docs/` — «checkout command — run it from the checkout root»; `watch
  --help` в корне с двумя развёртываниями — справка; совет о повторном использовании — только для
  `emptyr31`, не для `.hidr31` и `Bad R31`; `--app emptyr31 status` — «new-app emptyr31 takes it over».
- R30-03: голое число у `backup install` и пустое значение у обеих команд отвергаются, префикс
  `--interval` не повторяется; `45m` → «nearest valid: 30m, 1h».
- R30-04/R30-05: `set build --set`, `set validate --kind`, `set forget --json`, `backup list --hot`,
  `backup --keep 3` называют своё действие; `set bild`, `backup lst`, `backup crate` — did-you-mean;
  `backup create --dry-run` разбирается как голый `backup`.
- R30-07: `set validate` на теге — `SET_IMAGE_UNPINNED` вместе с остальным, `--json` печатает
  документ, код 1, совет `bootstrap`.
- R30-08: `lock --check` без файла блокировки не пишет `LOCK_MISSING` под «differences:»;
  `destroy` — через `humanSize`; единственный `regexEscape` ведёт себя как прежние копии (тот же
  класс символов, та же замена — `` String.raw`\$&` `` и `"\\$&"` дают одну строку; имена к тому же
  проходят `safeName`); `defaultRecipesDir` удалён.
- `incident` (ротация токена): `reconcile()` перечитывает `.env` в момент вызова
  (`reconcileSettings`), новый токен попадает в контейнер (по коду).
- Лимиты раскладки соблюдены: самый длинный файл — 672 строки (`recipe.check.ts`), в
  `tools/framework` ближе всех `backup/index.ts` (654) и `restore/index.ts` (651); каталогов с
  исходниками больше 7 записей нет.
- Холодный старт `control-mcp` с `tools/list` — около 0,55 с (чекаут) и 0,42 с (установленный).

## 4. Порядок работ

1. R31-01 — откат `upgrade` не должен переписывать `OPENCLAW_IMAGE`; руководство и справка — заодно.
2. R31-04 — полнота рецептов при проверке артефакта (ворота `apply --set`) и совет `set build`.
3. R31-02, R31-03 — тексты MCP и `--help`, пока бюджет `tools/list` не кончился.
4. R31-06, R31-07 — формы справки в чекауте и автодополнение первой позиции.
5. R31-05 — подсказки `--interval`.
6. R31-08 — проверки, которые различают, и проверка циклов импорта.
7. R31-09 — CHANGELOG и гигиена.
