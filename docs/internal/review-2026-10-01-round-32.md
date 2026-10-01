# Ревью ClawForge, раунд 32 — после фиксов раунда 31

Дата: 2026-10-01. База: `main` @ f883353. Предыдущий: раунд 31
(`docs/internal/review-2026-10-01-round-31.md`, R31-01…R31-09 закрыты коммитами 668aecb,
b7ca6ca, 9da16a8 и f883353). Сами фиксы раунда 31 повторного ревью ещё не проходили — это
первое.

Запрос: независимое ревью по фактам — ошибки, неточности, удобство, недостающие инструменты,
пахнущий код.

Метод: разбор `git diff 5aea3fc..HEAD` (43 файла: `instance/upgrade.ts`, `operate/schedule.ts`,
`sets/set*.ts`, `set/artifacts/install.ts`, `set/ownership/validate.ts`, `core/arguments.ts`,
`core/env.ts`, `integration/{gate,completion}.ts`, `integration/mcp/schema.ts`, `entry/*`,
проверки, руководство, CHANGELOG). Пробы — свежий `dist/` этой ревизии (`npm run build`); роль
системной команды, как в раундах 28–31, играла копия собранного пакета в
`apps/.r32/g/node_modules/@clawforge/framework` (`version --verbose` → `source: global`), запуск
`node …/dist/entry/bin.js` из игнорируемых каталогов под `apps/`: установленное приложение
`apps/.r32/app1` (`init` через `--project-root`), развёртывания чекаута `apps/r32c`, `apps/r32d`
(`./clawforge new-app`), пустой `apps/.r32/empty`, подпапка `docs/`. Чтобы не трогать WSL и
Docker, у всех трёх развёртываний цель переключена на `OC_TARGET_LOCATION=ssh` с
неразрешимым хостом `r32-unreachable.invalid` — команды, которым нужна цель, честно падают на
`TARGET_UNREACHABLE`. Свежие входы (не повторяющие раунды 28–31): `--help` всех 45 команд;
35 путей отказа (пропущенное значение, неверное значение, чужое действие, неизвестные имена);
`<команда> --zzz` по 37 командам; 21 вывод `--json` с недоступной целью; `set
build|validate|diff|try|receipts|forget` и `plan --set` на дереве с тремя неполными рецептами
(`delta` — пустой каталог, `eps` — только `.env`, `gamma` — только `verify.ts`) и на двух
артефактах; `backup|watch install --interval` с 13 значениями. MCP: `initialize` + `tools/list`
обоих видов, скан всех 210 описаний аргументов, `tools/call set` (дерево и артефакт),
`backup list`, `help backup`. Автодополнение: `bash -n`, вызов `_clawforge_complete` с 14
строками `COMP_WORDS`; PowerShell запускать нельзя — блок `Register-ArgumentCompleter` из
`completion pwsh` переписан построчно на JS и прогнан на 12 строках (скрипт пробы; таблицы
команд, флагов и действий он берёт из самого сгенерированного скрипта). `upgrade` — настоящая функция `upgrade()`
фреймворка на заглушке рантайма (модель `.Config.Image`: Compose берёт `image:
${OPENCLAW_IMAGE}`), плюс `connectionFactDiffs()` из `recover-env/facts.ts` — два сценария.
Скрипты: граф статических импортов `tools/framework` (170 модулей, 853 ребра, компоненты
сильной связности), неиспользуемые экспорты, длины файлов и размеры каталогов, баланс скобок в
описаниях MCP; `npm pack --dry-run`. Мутационные пробы проверок (каждая откачена, `git status`
после — чистый): срез `status` у `watch` (два варианта), `restoreData = true` при любой ошибке
здоровья в `upgrade`, вызов `resolveFrameworkFromSources()` в `tools/clawforge.ts`. Прогнаны
проверки: `foundation/core/arguments` (2 файла), `foundation/cli` (7), `connection-facts/upgrade`,
`hook-framework-import`. Статически — откат `upgrade`, проверка артефактов, `incident`,
`recover-env`, `expose`, ротация бэкапов, упаковка, руководство против поведения, раскладка,
циклы импорта, мёртвый код, дубли помощников, допуски по времени в проверках. Вывод, сделанный
рассуждением, а не воспроизведением, помечен «по коду». Каталоги проб удалены.

Не проверялось: живой `bootstrap`/`up`/`upgrade`/`recipe verify` — цель не трогалась вообще;
решение Compose пересоздать контейнер при другой строке `image:` (хеш конфигурации сервиса) —
по документации Compose, не запуском. PowerShell, `cmd.exe` и `zsh` не запускались (pwsh —
построчная модель, см. выше). Linux-хост, настоящая ssh-цель, macOS. `system-install.check.ts`
и полный `npm run check` не запускались. `secrets`, `provision-agent`, внутренности
`restore` — только выборочно, статически.

Шкала: P0 — ломает данные/безопасность; P1 — ломает основное обещание; P2 — неверное
поведение в реальном сценарии; P3 — шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| R32-01 | P2 | `commands/lifecycle/instance/upgrade.ts:160, 168, 254, 260`, `runtime/docker/compose-operations.ts:263-270`, `docker-compose.yml:31`, `commands/operate/recover-env/facts.ts:56-66`, `commands/orchestration/plan.ts:163-175`, `docs/guide/data-and-backups.md:359-362`, `docs/guide/commands.md:65`, `CHANGELOG.md:17-21` | фикс R31-01 неполон: откат пересоздаёт шлюз на `RepoDigests[0]` (`repo@sha256:A`, без тега), а в `.env` возвращает `repo:tag@sha256:A` — контейнер и `.env` расходятся: `inspect`/`doctor` дают `ENV_STALE` по `OPENCLAW_IMAGE`, `plan` советует `recover-env --adopt-runtime`, который запишет ровно тот бестеговый пин R31-01, следующий `up`/`apply` пересоздаёт шлюз; «indistinguishable from before» в руководстве и CHANGELOG неверно; воспроизведено на заглушке |
| R32-02 | P2 | `integration/completion.ts:233-258`, `checks/foundation/core/arguments/action-arguments.check.ts:101-103`, `CHANGELOG.md:50-52` | регрессия 9da16a8 в PowerShell: дополнение с набранным префиксом больше не работает — `clawforge sta<Tab>`, `clawforge --ap<Tab>`, `clawforge backup l<Tab>`, `watch in<Tab>` не дают ничего (раньше — команды и действия); `clawforge --app r32c backup <Tab>` не предлагает действий; после `backup --hot ` предлагаются слова действий, которые `backup` отвергнет; проверка ищет подстроки и не видит; по коду (построчная модель скрипта) |
| R32-03 | P2 | `commands/sets/set-manifest.ts:71-76, 83-87`, `service/inspection.ts:290-296`, `commands/lifecycle/bootstrap/index.ts:137-171`, `CHANGELOG.md:26-28` | совет «Run ./clawforge bootstrap» (фикс R31-04, и `nextAction` у `SET_IMAGE_UNPINNED`) дан и для уже развёрнутого экземпляра: ветка «lock записан для другого образа» бывает только после `bootstrap`, а `bootstrap` на живом экземпляре заново разрешает тег, закрепляет свежий digest и пересоздаёт шлюз — смена образа без бэкапа, `doctor --lint` и отката `upgrade`; «the digest that was proven» — ложь; совет воспроизведён, последствия — по коду |
| R32-04 | P3 | `integration/mcp/schema.ts:171-181`, `core/arguments.ts:110-121`, `tools/clawforge.ts:95`, `openclawCommands.management.ts:88, 109, 151`, `lifecycle/restore/index.ts:57`, `core/io/help-render.ts:50` | описания MCP и `--help`: `set.json` в `tools/list` — «Emit the manifest and its id as JSON (build, validate, diff, receipts, try)», то есть R31-03 в MCP не исправлен (проверка закрепляет именно это); `set.name` — «Set name; The object's name (build, validate, forget)» без привязки к действиям; `cli.args`/`exec.args` обрезаны внутри JSON-примера (`e.g. ["config"`), `check.jobs` — с незакрытой скобкой, `host.root` — «Request root. On target/local»; в `set --help` области повторены дважды; запас `tools/list` чекаута — 778 байт; воспроизведено |
| R32-05 | P3 | `set/artifacts/install.ts:327-329, 432-446`, `commands/sets/set.ts:113-118`, `set/ownership/validate.ts:124-131`, `commands/sets/set-try.ts:214-224`, `service/inspection.ts:250-282`, `CHANGELOG.md:28-34` | проверка артефакта после R31-04: на блокирующих находках `set validate --set` не печатает ни `blocking:`, ни JSON (stdout пуст), в MCP `structuredContent.problems: []`, `result: ""`; в тексте только коды, без рецептов, коды не схлопнуты; `set diff` (только чтение) отказывает на таком артефакте; дерево и артефакт расходятся (3 блокирующих против 1: пустой рецепт и рецепт из одних приватных файлов в артефакте не видны); `nextAction` всех `SET_*` — та же `set validate`; вторая проверка в `set try` мертва; воспроизведено |
| R32-06 | P3 | `commands/lifecycle/instance/upgrade.ts:57-59, 220`, `openclawCommands.lifecycle.ts:289-291, 299-300`, `docs/guide/commands.md:65` | `upgrade --image repo@sha256:…` (задокументировано: «used as-is») при успехе закрепляет бестеговый `repo@sha256:…` — канал теряется, следующий простой `upgrade --dry-run` отказывает; справка утверждает, что успех закрепляет `repo:tag@sha256:…`, а бестеговый пин бывает только «from before pins kept one»; воспроизведено на заглушке |
| R32-07 | P3 | `commands/interface/groups/openclawCommands.lifecycle.ts:173-177` | `backup --help` (и MCP `help backup`): подробный текст по-прежнему обещает «30m, 6h, 1d or a bare number of minutes (as `watch install`)» — устарело с R30-03 (573e6a1), противоречит строке `--interval` выше и поведению (`--interval 90` → отказ); R30 и R31 это пропустили; воспроизведено |
| R32-08 | P3 | `commands/lifecycle/instance/logs.ts:25-26`, `commands/lifecycle/smoke/index.ts:242-243`, `commands/management/credentials/provider.ts:52-59`, `entry/cli.ts:104-107`, `commands/operate/expose/ssh.ts:14, 26`, `commands/operate/incident/index.ts:368-372, 442-445` | пути отказа: `logs`, `smoke`, `configure-provider` идут на цель до разбора аргументов (`logs --tail abc`, `logs --zzz` → ошибка ssh; `configure-provider` разбирает аргументы уже под замком экземпляра); `recover-env --zzz` без подсказки `--help`; `expose ssh --local-port 99999` печатает рабочую на вид команду (код 0); `incident --dry-run` при недоступной цели — код 0; `--json` при отказе цели: у 8 команд stdout пуст, у 4 — документ; воспроизведено |
| R32-09 | P3 | `integration/completion.ts:52-55, 82`, `entry/bin.ts`, `integration/gate.ts:92-126` | находимость: автодополнение не знает `help <команда>`, `completion <оболочка>`, значения позиционных и опций с `choices` (`host <context>`, `--profile`, `--kind`, `--client`) — на месте значения предлагает флаги; вне папки приложения установленная команда отказывает в `status --help`/`help status` (код 1), хотя объявления встроены и корень чекаута отвечает справкой; в подпапке чекаута `help status` тоже отказ; воспроизведено |
| R32-10 | P3 | `checks/foundation/core/arguments/arguments.check.ts:440-448`, `action-arguments.check.ts:101-103, 113-153, 191-200, 221-236`, `checks/integration/agent/recipe-hook-freshness/hook-framework-import.check.ts:96-127`, `checks/sets/lifecycle/set-module-load.check.ts:1-26` | проверки: мутация `watch` `status: [...WATCH_CHECK_ARGUMENTS, ...WATCH_INSTALL_ARGUMENTS]` проходит все 9 файлов (сверка реестра с самим собой осталась, «drive the real dispatcher» проверяет только парсер); pwsh проверяется подстроками (R32-02 прошёл); «независимый оракул» MCP повторяет регулярку реализации; ожидание для `set.json` закрепляет дефект; проба шлюза пишет в настоящий `apps/r31gateprobe` с фиксированным именем (чужой каталог перезапишет и удалит, при убитом прогоне остаётся «развёртыванием»); `set-module-load` говорит о трёх циклах — их два, общей проверки циклов нет; воспроизведено |
| R32-11 | P3 | `CHANGELOG.md:13, 32-34, 41, 45-46, 52`, `checks/runtime/connection-facts/upgrade.check.ts:197-199`, `core/env.ts:146-158`, `commands/lifecycle/restore/index.ts:189-212`, `runtime/datadir.ts:194-227`, `commands/sets/set-try-env.ts:19-21` | гигиена: пять пунктов CHANGELOG переоценивают фиксы (см. R32-02, R32-04, R32-05, R32-10); проверка отката зовётся «byte-for-byte», а сравнивает разобранное значение (`upsertEnvLine` переводит CRLF в LF, снимает кавычки и комментарий строки, при отсутствии ключа дописывает значение по умолчанию); два почти одинаковых обхода предков каталога данных с разными деталями (`restore` vs `datadir`); `unpackForTry` — псевдоним без смысла; по коду |

P0 и P1 нет.

## 2. Подробно

### R32-01 (P2). Откат `upgrade`: `.env` и контейнер расходятся

Настоящая `upgrade()` на заглушке рантайма; `.env` до запуска — как его оставляют `bootstrap` и
успешный `upgrade`; `doctor --lint` возвращает блокирующую находку (откат):

```
.env до            : OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable@sha256:aaaa…
outcome            : upgrade failed and was rolled back to ghcr.io/openclaw/openclaw@sha256:aaaa…
recreateWithImage  : …:extended-stable@sha256:bbbb…   then   ghcr.io/openclaw/openclaw@sha256:aaaa…
.Config.Image после: ghcr.io/openclaw/openclaw@sha256:aaaa…
.env после         : ghcr.io/openclaw/openclaw:extended-stable@sha256:aaaa…
connectionFactDiffs: [{"name":"OPENCLAW_IMAGE","value":"ghcr.io/openclaw/openclaw@sha256:aaaa…","kind":"diverged"}]
```

- Откат пересоздаёт шлюз на `previousDigest` (`upgrade.ts:160`) — это `identity.digests[0]`
  (`:260`), то есть `RepoDigests[0]`, у Docker всегда `repo@sha256:…` без тега.
  `recreateWithImage` кладёт строку в `OPENCLAW_IMAGE` (`compose-operations.ts:265`), Compose
  — в `image:` (`docker-compose.yml:31`), и она становится `.Config.Image` контейнера. Затем
  `.env` получает `previousReference` (`:168`, `:254`) — с тегом. До обновления контейнер был
  создан `bootstrap`/`up` из того же `.env`, и `.Config.Image` совпадал с ним; после отката —
  нет.
- `OPENCLAW_IMAGE` — один из четырёх «connection facts», которые сверяются именно с
  `.Config.Image` (`recover-env/facts.ts:24-29`, `inspect/drift.ts:126-133`): каждый откат
  оставляет `ENV_STALE` в `inspect`/`doctor`. `plan` (`plan.ts:163-175`) предлагает два
  направления: `recover-env --adopt-runtime` запишет в `.env` значение контейнера — ровно
  бестеговый `repo@sha256:A`, из-за которого был R31-01 (следующий `upgrade` снова откажет);
  `up` пересоздаст шлюз, потому что строка `image:` другая и хеш конфигурации сервиса Compose
  изменился (по коду) — лишний перезапуск; так же сработает любой следующий `compose up`
  (например, `apply`, когда план пересоздаёт шлюз).
- Так же при незакреплённом `.env` (`OPENCLAW_IMAGE=repo:tag`, например после `bootstrap
  --no-pull`): контейнер после отката — `repo@sha256:A`, `.env` — `repo:tag`. Если ключа в
  `.env` нет вовсе, откат дописывает значение по умолчанию из `ctx.settings.image` — файл уже
  не «прежний».
- Руководство (`data-and-backups.md:359-362`), `commands.md:65` и CHANGELOG (`:17-21`)
  обещают «indistinguishable from before».
- Проверка (`upgrade.check.ts:197-215`) этого не видит: заглушка не моделирует `.Config.Image`
  (`recreateWithImage` лишь переключает `runningDigest`), а её `TARGET_DIGEST` — бестеговый,
  тогда как настоящий `resolveImageDigest` возвращает `repo:tag@sha256:…`
  (`image-digest.ts:25`).

Предложение: откатывать на ту же строку, что окажется в `.env`: если
`digestHash(previousReference) === digestHash(previousDigest)`, вызывать
`recreateWithImage(previousReference)`; иначе (незакреплённый тег, другой digest) — на
`previousDigest`, а в `.env` писать `${imageChannel(previousReference)}@<hash>`, когда в канале
есть тег. Надёжнее всего — запомнить до обновления `.Config.Image` работающего контейнера
(`runningConnectionFacts().image`) и вернуть именно его. Проверка: заглушка хранит строку,
полученную `recreateWithImage`, и после отката `connectionFactDiffs({ image }, parseEnv(.env))`
пуст.

### R32-02 (P2). PowerShell: дополнение с префиксом сломано фиксом R31-07

Блок `Register-ArgumentCompleter` из `completion pwsh` (чекаут), переписанный построчно на JS,
таблицы — из самого скрипта; «было» — та же модель с ветками 5aea3fc (удалённые строки
`git diff 5aea3fc..HEAD -- integration/completion.ts`):

```
"clawforge "                     => --app accept apply … watch            (верно)
"clawforge sta"                  => (nothing)                             (было: status)
"clawforge status"               => (nothing)
"clawforge --ap"                 => (nothing)                             (было: --app)
"clawforge backup "              => --dry-run … --with-secrets create install list prune-replaced uninstall
"clawforge backup l"             => (nothing)                             (было: list)
"clawforge backup --h"           => --help --hot
"clawforge --app r32c backup "   => --dry-run --help --hot … (только флаги, без действий)
"clawforge backup --hot "        => … create install list prune-replaced uninstall
"clawforge status --"            => --help --json
```

- 9da16a8 заменил `if (-not $cmd -or $idx -eq ($rest.Count - 1))` на `if (-not $cmd)`, а
  условие «набирается слово действия» сдвинул с `$idx -eq ($rest.Count - 2)` на
  `$idx -eq ($rest.Count - 1)` (`completion.ts:251`). При курсоре сразу после слова
  `$commandAst.CommandElements` уже содержит это слово, поэтому `$cmd` — недописанное имя
  команды («sta»), а условие `Count - 1` описывает набор самой команды, а не действия. Итог:
  любая команда и любое действие с набранным префиксом не дополняются — основная работа
  автодополнения. Раунд 31 (по коду) отмечал, что именно эти случаи работали.
- Ветка пробела (`:243`) проверяет `$idx -eq 0` — индекс команды, а не позицию курсора: в
  чекауте с `--app <имя>` команда стоит на индексе 2, и `--app r32c backup <Tab>` действий не
  получает; без `--app` слова действий предлагаются и после флагов (`backup --hot <Tab>`), хотя
  `backup --hot list` отказывает («unknown argument»: действие берётся только первым словом,
  `backup/index.ts:597-618`), а bash в той же позиции даёт только флаги создания.
- Проверки (`action-arguments.check.ts:101-103`) ищут подстроки в тексте скрипта, поэтому
  пропустили регрессию. CHANGELOG (`:50-52`) обещает обратное.

Предложение: вернуть ветку «последний токен — сама команда и `$wordToComplete` не пуст» →
список команд (и `--app`), «действие набирается» — `$idx -eq ($rest.Count - 2)`; в ветке пробела
вместо `$idx -eq 0` — `$rest.Count -eq ($idx + 1)`. Проверка: на Windows-раннере CI есть `pwsh`
— загрузить сгенерированный скрипт и звать `TabExpansion2 -inputScript 'clawforge sta'
-cursorColumn 13` и ещё 8–10 строк из таблицы выше, сравнивая `CompletionMatches`.

### R32-03 (P2). `set build` советует `bootstrap` и развёрнутому экземпляру

```
(apps/r32d: OPENCLAW_IMAGE=…:extended-stable, config/deployment.lock.json записан для …:2026.6)
$ ./clawforge --app r32d set build
  error: the lock's digest does not belong to ghcr.io/openclaw/openclaw:extended-stable — it was recorded for
         ghcr.io/openclaw/openclaw:2026.6, and pinning it here would put the previous image's runtime under a
         declaration that no longer names it.
  Run ./clawforge --app r32d bootstrap to record the digest for the image now declared, or set OPENCLAW_IMAGE to a @sha256 reference.
```

- R31-04 предлагал развести случаи: до первого `bootstrap` — `bootstrap`, иначе — закреплённая
  ссылка. Фикс (`set-manifest.ts:75, 86`, и раньше `inspection.ts:290-296` для
  `SET_IMAGE_UNPINNED`) советует `bootstrap` всегда; CHANGELOG (`:26-28`) объясняет выбор только
  случаем «до первого bootstrap».
- Ветка «lock записан для другого образа» (`:71-76`) бывает только у развёрнутого
  экземпляра: `lock` отказывает до первого `bootstrap`. Ветка «тег без lock» — тоже не только
  до развёртывания: `bootstrap --no-pull` тег не закрепляет (`bootstrap/index.ts:137-139`),
  ранние развёртывания тоже.
- `bootstrap` на живом экземпляре с тегом в `OPENCLAW_IMAGE` (по коду, `bootstrap/index.ts:142-171`):
  разрешает тег в реестре заново, закрепляет свежий digest в `.env`, тянет его и делает
  `runtime.start()` — Compose пересоздаёт шлюз на новом образе. Ни бэкапа перед обновлением, ни
  `doctor --lint`, ни отката, ни восстановления при выходе 78 — всего, ради чего существует
  `upgrade`. Фраза «record the digest that was proven» неверна: закрепится не проверенный, а
  только что разрешённый digest.
- Для развёрнутого экземпляра безопасный путь уже есть: `./clawforge lock` записывает digest
  работающего образа (его и примет `requiredImage`), а смену тега делает `./clawforge upgrade
  --image <repo:tag>` (бэкап, проверки, откат, закрепление).

Предложение: lock записан для другого образа — «./clawforge upgrade --image <объявленный тег>
(or ./clawforge lock if the running gateway already runs it)»; тег без lock — назвать оба случая:
«before the first bootstrap: ./clawforge bootstrap pins the digest; on a running instance:
./clawforge lock records the running one». То же для `nextAction` у `SET_IMAGE_UNPINNED`.
Никогда не советовать `bootstrap` как способ сменить образ на живом экземпляре.

### R32-04 (P3). Описания MCP и `--help`: R31-02/R31-03 закрыты не до конца

Скан `tools/list` (45 инструментов чекаута, 42 — установленного приложения), строки — как их
читает клиент:

```
set.json     "Emit the manifest and its id as JSON (build, validate, diff, receipts, try)"
set.name     "Set name; The object's name (build, validate, forget) (value: <name>)"
cli.args     "Arguments passed to OpenClaw's CLI verbatim, e.g. [\"config\""
exec.args    "Command and arguments to run, e.g. [\"curl\", \"-fsS\""
check.jobs   "Concurrent check-file processes (default: OC_CHECK_JOBS (value: <n>)"
host.root    "Request root. On target/local"
restore.json "Emit restored data and actual gateway startup outcome as…"
tools/list:  31 990 байт из 32 768 (чекаут), 30 734 (установленное); запас 778 байт
$ clawforge set --help
  --name <name>  Set name (default: the deployment's name) (build, validate); The object's name (forget) (build, validate, forget)
  --json         Emit the manifest and its id as JSON (build); Emit the findings as JSON (validate); Emit JSON (diff);
                 Emit the receipts as JSON (receipts); Emit the trial report as JSON (try) (build, validate, diff, receipts, try)
```

- `set.json`: составное описание `scopeByAction` (`arguments.ts:113-118`) — «X (build); Y
  (validate); …». `shortenDescription` сначала срезает все скобки (`schema.ts:172`), отчего
  части теряют свои действия, а потом режет по последней границе в 60 символах — после первой
  части. В MCP снова текст `build` «за всех» — ровно жалоба R31-03; CHANGELOG (`:45-46`) говорит
  обратное. `set.name` — та же потеря привязки и «The» после точки с запятой.
- `cli.args`/`exec.args`: граница «,» берётся и внутри JSON-примера (`schema.ts:176` не знает о
  скобках и кавычках) — пример обрывается на `["config"`. R31-02 называл `cli.args` («e.g.»);
  фикс сменил место обрыва, проверка (`action-arguments.check.ts:165`) смотрит только
  `startsWith`.
- `check.jobs`: исходник `(default: OC_CHECK_JOBS, else min(4, cores/2))`; регулярка
  `\s*\([^()]*\)` снимает только внутреннюю пару, внешняя остаётся незакрытой. Это
  команда шлюза, оракул проверки её не обходит.
- `host.root`: «Request root. On target/local» — обрыв на `:`; клиент прочтёт «root только на
  target/local», хотя на `engine` флаг — обязательная половина согласия.
- `restore.json` длиннее бюджета на один символ и теряет «JSON» под «…».
- В `--help` составные строки повторяют область дважды (часть уже несёт свои действия, затем
  `help-render.ts:50` добавляет общий список); у `--from`, `--to`, `--set-id`, `--receipt`,
  `--with-model`, `--keep`, `--interval`, `--apply` остался зачин «With x:» рядом с «(x)».
- Запас `tools/list`: 1 025 байт в R30, 912 в R31, 778 сейчас (прибавили составные описания;
  каждое «…» — 3 байта UTF-8).

Предложение: в схеме сокращать каждую часть составного описания отдельно и оставлять её
действия («set name (build, validate); object name (forget)»), а в `--help` не дописывать общий
список, когда части его уже несут; срезать вложенные скобки до неподвижной точки; не считать
границей знаки внутри `[]`, `()` и кавычек; `cli.args`, `exec.args`, `host.args`, `host.root`,
`check.jobs`, `restore.json` — короткие явные тексты схемы (как `SHARED_SCHEMA_DESCRIPTIONS`;
это и вернёт байты). Проверка — структурные инварианты, а не та же регулярка: скобки и кавычки
сбалансированы, текст без суффиксов — префикс исходника, оборванный на границе вне скобок или
с «…»; ожидание для `set.json` — по действиям.

### R32-05 (P3). Проверка артефакта: находки теряются, дерево и артефакт расходятся

```
(apps/r32c: alpha, beta — полные; delta — пустой каталог; eps — только .env; gamma — только verify.ts)
$ clawforge set validate                → 3 blocking (delta, eps, gamma), «blocking: …», код 1
$ clawforge set build                   → built set r32c (8 file(s)), код 0
$ clawforge set validate --set sets/r32c-bc33….tar.gz
  error: sets/r32c-bc33….tar.gz is not a valid set artifact: artifact set is not coherent: SET_RECIPE_INCOMPLETE   (код 1)
$ clawforge set validate --set sets/r32c-bc33….tar.gz --json        → то же, stdout пуст        (код 1)
$ clawforge set diff sets/r32c-bc33….tar.gz sets/r32c-bda1….tar.gz  → то же                    (код 1)
MCP tools/call set {action: validate, set: …bc33…}:
  isError: true, structuredContent: { problems: [], nextActions: [], result: "" }
MCP tools/call set {action: validate} (дерево):
  problems: [3 × SET_RECIPE_INCOMPLETE …], nextAction: "./clawforge --app r32c set validate"
```

- Блокирующие находки артефакта ловит не `report()` (`set.ts:113-118`), а ворота
  `verifyArtifact` (`install.ts:327-329`), которые бросают до отчёта. Поэтому CHANGELOG (`:32-34`:
  «reports findings through the same path as the tree (blocking findings print as `blocking:`,
  each failing code once…)») верен только для неблокирующих: при блокирующих нет ни `blocking:`,
  ни JSON-документа, ни имён рецептов, а коды в сообщении ворот не схлопнуты (два рецепта вроде
  `gamma` дадут `SET_RECIPE_INCOMPLETE, SET_RECIPE_INCOMPLETE`). Клиент MCP, читающий `structuredContent`,
  видит «ошибка, проблем нет».
- Дерево — 3 блокирующих, артефакт того же дерева — 1: пустой рецепт и рецепт из одних
  приватных файлов (`eps/.env` отсеивает политика переносимого содержимого) в артефакте не
  имеют каталога, и `validate.ts:127-131` их пропускает. Комментарий `validate.ts:218-219`
  («must answer exactly as validating the tree») по-прежнему не выполняется.
- `set diff` — только чтение, но ворота те же: «что изменилось между сломанной и хорошей
  сборкой» спросить нельзя. По коду: артефакт, установленный до этой версии с таким рецептом
  (дерево его флагало, но `build` собирал), теперь не пройдёт и `rollback --previous-set`.
- `nextAction` всех `SET_*` — «./clawforge set validate» (`inspection.ts:250-282`): внутри самой
  `set validate` совет ведёт в ту же команду.
- `set-try.ts:214-224` после `unpackForTry` (те же ворота с `checkFiles: true`) ещё раз зовёт
  `validateSet(…, { checkFiles: false })` — подмножество уже пройденной проверки, ветка `die`
  недостижима.

Предложение: разделить ворота на целостность (бросает) и смысл (возвращает находки);
`validate --set` и `set diff` берут только целостность и печатают находки через `report()`,
установка (`apply --set`, `rollback --previous-set`, `plan --set`, `set try`, `accept --set`) —
обе части, с кодами без повторов и именами рецептов в тексте. Дерево и артефакт привести к
одному ответу о рецепте без переносимых файлов. `nextAction` для `SET_RECIPE_INCOMPLETE` —
конкретная правка («add recipe.json or server.ts to recipes/<имя>, or remove the directory»).
Убрать вторую проверку в `set try`.

### R32-06 (P3). `upgrade --image repo@sha256:…` теряет канал

Настоящая `upgrade()` на той же заглушке, `.env` — `…:extended-stable@sha256:aaaa…`:

```
$ upgrade --image ghcr.io/openclaw/openclaw@sha256:bbbb…   → успех
.env после        : OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw@sha256:bbbb…
$ upgrade --dry-run → OPENCLAW_IMAGE is "ghcr.io/openclaw/openclaw@sha256:bbbb…" — a digest with no tag alongside it,
                      so the channel it was pulled from is unknown and cannot be re-resolved. Name the channel explicitly: …
```

- Явный digest берётся как есть (`upgrade.ts:57-59`) и как есть закрепляется (`:220`). Справка
  (`openclawCommands.lifecycle.ts:289-291, 299-300`) и `commands.md:65` говорят, что успех
  закрепляет `repo:tag@sha256:…`, а бестеговый пин бывает только «from before pins kept one» —
  его производит текущая версия.

Предложение: если репозиторий явного digest совпадает с репозиторием текущего канала,
закреплять `${imageChannel(previousReference)}@<hash>` (канал сохраняется); иначе — честно
написать в справке, что явный digest заменяет канал и следующему `upgrade` нужен `--image
<repo:tag>`.

### R32-07 (P3). `backup --help` обещает голое число минут

```
$ clawforge backup --help
  --interval <interval>  With install: how often (default 1d) — 30m, 6h or 1d, explicit unit required (a bare number is minutes only for watch install); …
  …
  install / uninstall — … every --interval (default 1d) — 30m, 6h, 1d or a bare number of minutes (as `watch install`); …
$ clawforge backup install --interval 90  → error: --interval needs an explicit unit — nearest valid: 1h, 2h; …
```

`openclawCommands.lifecycle.ts:175` — текст из 85e22b1 (R29-05, «одна грамматика»), который
R30-03 (573e6a1) поведением отменил, а текст не тронул; R30 и R31 его не заметили. Тот же текст
отдаёт MCP-инструмент `help`.

Предложение: «30m, 6h or 1d — an explicit unit is required (a bare number is minutes only for
watch install)»; проверка: текст подробностей и строка аргумента говорят об одной грамматике
(например, в подробностях `backup` нет «bare number of minutes»).

### R32-08 (P3). Пути отказа: порядок проверок, коды, JSON

```
$ clawforge logs --tail abc          → error: ssh:r32-unreachable.invalid is unreachable — …   (а не «--tail takes a number»)
$ clawforge logs --zzz               → то же;  smoke --zzz, configure-provider --zzz, configure-provider --provider → то же
$ clawforge status --zzz             → error: unknown argument: --zzz / run clawforge status --help …   (так 31 команда из 37)
$ clawforge recover-env --zzz        → error: unknown argument: --zzz        (без строки про --help)
$ clawforge expose ssh --local-port 99999 → ssh -N -L 99999:127.0.0.1:27234 … / once open: http://127.0.0.1:99999   (код 0)
$ clawforge incident --dry-run       → contain failed unexpectedly: ssh:… unreachable — rotate proceeds regardless; … (код 0)
--json при недоступной цели: status, doctor, watch check, bootstrap --check — документ;
  lock --check, secrets, backup list, smoke, upgrade --dry-run, mcp-creds, expose status, recover-env --dry-run — stdout пуст
```

- `logs` (`logs.ts:25-26`) и `smoke` (`smoke/index.ts:242-243`) зовут `requireBootstrapped`
  раньше `parseDeclaredArgs`; `configure-provider` (`provider.ts:52-59`) — `requireBootstrapped`,
  затем `guarded`, и только под замком экземпляра `parseArgs`. Опечатка стоит похода на цель (на
  WSL — секунды, по MCP — на каждый вызов), при занятом замке отвечает «lock held», а не «unknown
  argument», при недоступной цели — ошибкой транспорта.
- `recover-env` разбирается вне `runApp` (`cli.ts:104-107`), его `UnknownArgumentError` проходит
  мимо `reportUnknownArgument`.
- `expose/ssh.ts:14`: `PORT = /^[1-9][0-9]*$/` без верхней границы.
- `incident --dry-run` (`incident/index.ts:442-445`) не требует цели, и при недоступной цели
  «план» из заметок об отказах возвращает код 0, хотя модуль сам пишет, что такой план «worth
  nothing» (`:436-437`).
- Половина команд с `--json` при отказе цели не печатает документ: `jq` в скрипте получает
  пустой ввод. Контракта «JSON и при ошибке» руководство не даёт, но `upgrade --json` его уже
  держит (`{ok:false, problems}`), как и `status`/`doctor`.

Предложение: разбор аргументов — первым делом во всех трёх командах; `recover-env` — через тот
же `reportUnknownArgument`; порт ≤ 65535; `incident --dry-run` при недоступной цели — ненулевой
код или явное «plan incomplete»; для `--json` — одно правило: при отказе печатать
`{ok:false, problems:[…]}` (или записать в руководство, что `--json` — только для успеха).

### R32-09 (P3). Находимость: автодополнение и справка вне приложения

```
bash, скрипт `clawforge completion bash` установленного приложения (COMP_WORDS → COMPREPLY):
clawforge help             => --help
clawforge help ba          => (пусто)
clawforge completion       => --help
clawforge host             => --confirm-root --help --root
clawforge backup --profile => --dry-run --help --hot --migrate --native --profile --share --with-secrets
clawforge set forget --kind => --break-foreign-lock --break-lock --help --kind --name
clawforge mcp-setup --client => --client --help --json --rewrite-launcher
(вне приложения, установленная команда)
$ clawforge status --help  → error: no app.ts in <каталог> / … run: clawforge init          (код 1)
$ clawforge help status    → error: "status" is a deployment command: it needs an app folder …  (код 1)
(docs/ чекаута)            $ clawforge help status → тот же отказ; в корне чекаута — справка
```

- Генератор знает только позиционный `action` с `choices` (`completion.ts:52-55`); `help`
  объявлен с одним `--help` (`:82`). Поэтому самые естественные места — `help <Tab>`,
  `completion <Tab>`, `host <Tab>`, значения `--profile`/`--kind`/`--client` — не дополняются, а
  на месте значения опции предлагаются флаги (флаг на месте значения команда отвергнет). zsh —
  тот же скрипт через `bashcompinit`.
- Корень чекаута после R30-02 отвечает на `<команда> --help` и `help <команда>` из
  `openclawCommands`, без развёртывания; установленная команда вне папки приложения и подпапка
  чекаута — отказывают, хотя объявления те же и встроены. Довод R30-02 («the second form the
  general help itself promises») применим и здесь: прочитать `help bootstrap` до `init` нельзя.

Предложение: в модель автодополнения — имена команд для `help`, оболочки для `completion`,
`choices` позиционных и опций (по `prev`); справку команд развёртывания вне приложения строить
из `openclawCommands`, как в корне чекаута, с пометкой «runs inside an app folder».

### R32-10 (P3). Проверки, которые не различают, и проба в настоящем `apps/`

| Мутация (откачена) | Проверки | Итог |
|---|---|---|
| `watch/index.ts`: `status: WATCH_INSTALL_ARGUMENTS` (мутация R31-03) | `foundation/core/arguments` | упала одна: точная строка `watch.json` (область стала `(check, test)`) — случайно |
| `watch/index.ts`: `status: [...WATCH_CHECK_ARGUMENTS, ...WATCH_INSTALL_ARGUMENTS]` | `foundation/core/arguments`, `foundation/cli` (9 файлов) | прошли; `watch --help`, автодополнение и MCP при этом предлагают `watch status --interval`, настоящий парсер отвергает |
| `upgrade.ts:208`: `restoreData = true` | `connection-facts/upgrade` | упала («a non-migration failure never restores the backup») — R31-08 исправлен |
| `tools/clawforge.ts:52`: вызов `resolveFrameworkFromSources()` закомментирован | `hook-framework-import` | упала — проба шлюза различает |

1. `arguments.check.ts:440-448`: «настоящий парсер» для `backup`, `watch`, `expose`, `set` — это
   `parseDeclaredArgs(slice, …)` над срезом из того же реестра; только `recipe` идёт через свой
   `validateRecipeArgs`. Новый блок `action-arguments.check.ts:221-236` («The drift check must
   drive the real dispatcher») зовёт `openclawCommands.watch.run`, но утверждает лишь отказ
   парсера и ничего не сравнивает с объявлением. Предложение R31-03 (срез из таблицы в самом
   `watchStatus`, сравнение через `run` на заглушке) не выполнено.
2. pwsh проверяется подстроками скрипта (`action-arguments.check.ts:101-103`) — R32-02 прошёл
   зелёным.
3. «Независимый оракул» описаний (`:113-153`) срезает скобки той же регуляркой и режет по тем
   же границам, что `schema.ts:172-176`: незакрытая скобка и обрыв внутри `[…]` для него — норма.
   Ожидание `:196-200` называется «not one action's claim for all» и закрепляет как раз текст
   одного действия (R32-04).
4. Проба шлюза (`hook-framework-import.check.ts:96-127`) создаёт `apps/r31gateprobe` в настоящем
   чекауте: каталог с таким именем (если есть) будет перезаписан и в `finally` удалён целиком
   (`mkdir` с `recursive` не отказывает); при убитом прогоне (Ctrl+C, сторож 15 минут в
   `kit/spawn.ts:18, 49`) каталог остаётся, а `list` показывает его как развёртывание —
   проверено руками на `apps/r32gate`: `r32gate — error / no .env`, и выбор единственного
   развёртывания по умолчанию ломается («several deployments»). Утверждение только
   отрицательное (в выводе нет «cannot load deployment»): сбой запуска или тайм-аут дадут
   пустой вывод и зелёный результат. Пересечения с другими проверками нет — файл помечен
   `check:exclusive`, и маркер соблюдается.
5. `set-module-load.check.ts:3-5, 15`: «Three cycles exist today», первый — «set actions». Скрипт
   по графу статических импортов (170 модулей, 853 ребра) находит две компоненты: `state.ts` ↔
   `secrets.ts` ↔ `restore/index.ts` и семь модулей `install.ts` ↔ `provision-agent` ↔
   `accept.ts` ↔ `inspect/{gather,live,declared}.ts`; цикл `sets/*` разорван в 6c43b01. Список
   ручной: новый цикл проверка не заметит. CHANGELOG (`:13`) повторяет «three known import
   cycles».

Предложение: сравнение «объявлено = принимает» вести через `openclawCommands.<cmd>.run` на
заглушке для каждого действия и флага (как уже для `set`); pwsh — через `TabExpansion2` на
Windows-раннере (R32-02); для описаний — структурные инварианты (R32-04); пробе шлюза —
уникальное имя, отказ при существующем каталоге, положительное утверждение («unknown command:
status» — приложение загрузилось); `set-module-load` — вычислять компоненты графа при запуске и
грузить каждый их модуль первым (или сверять ручной список с вычисленным).

### R32-11 (P3). Гигиена и точность текстов

- CHANGELOG: `:13` («all three known import cycles» — их два), `:32-34` (`set validate --set` и
  блокирующие находки — R32-05), `:41` («no schema line ends mid-phrase» — R32-04), `:45-46`
  (описания по действиям — в MCP нет, R32-04), `:52` (pwsh — R32-02).
- `upgrade.check.ts:197-199`: «restores OPENCLAW_IMAGE byte-for-byte», а утверждение сравнивает
  `parseEnv(…).OPENCLAW_IMAGE`. Побайтно и не выйдет: `pinImageReference` идёт через
  `upsertEnvLine` (`core/env.ts:146-158`), который переводит весь файл из CRLF в LF, пишет
  значение без кавычек и теряет комментарий в строке ключа; при отсутствии ключа (`?? ctx.settings.image`,
  `upgrade.ts:254`) откат дописывает значение по умолчанию.
- Два обхода предков каталога данных: `verifyDataDirAncestry` + `physicalPath`
  (`restore/index.ts:189-212`) и `assertCanonicalAncestry` + `physicalPath` (`datadir.ts:194-227`).
  Детали уже разошлись: версия `restore` не отказывает на пустом выводе `readlink -f` при коде 0
  и не ловит исключение `exists()`, версия `datadir` не берёт префикс `sudo`. Логика, от которой
  зависит безопасность, живёт в двух копиях.
- `set-try-env.ts:19-21`: `unpackForTry` — псевдоним `unpackArtifactVerified` без собственного
  смысла.
- Раскладка в пределах: самый длинный файл — `recipe.check.ts` (672 строки), в
  `tools/framework` — `backup/index.ts` (655), `restore/index.ts` (652),
  `openclawCommands.management.ts` (644), `state.ts` (644); каталогов с исходниками больше 7
  записей нет.

Предложение: поправить пять пунктов CHANGELOG и заголовок проверки; один помощник «обойти
предков и сравнить с `readlink -f`» для `restore` и `datadir` (с `sudo`-префиксом как
параметром); убрать псевдоним.

## 3. Что хорошо

- R31-01, основной симптом: после отката следующий `upgrade --dry-run` разрешает канал
  (проверка это держит), отказ на бестеговом пине больше не винит «старые версии».
- R31-05: `backup install --interval` — `1440` → `1d`, `90` → `1h, 2h`, `0` → `1m`, `25` →
  `20m, 30m`, `100000` и `2880` → `1d`; общий отказ для `backup` — «must look like 30m, 6h or 1d
  (an explicit unit is required)»; `60m` принимается.
- R31-06: в корне чекаута с двумя развёртываниями `watch install --help` — справка (код 0),
  `exec -- ls --help` — честное «several deployments»; из `docs/` `help list`/`help check` —
  «run it from the checkout root» с путём в кавычках; текст отказа `init` верен.
- R31-03, диспетчер: `set try --kind`, `set diff --name`, `set receipts --keep`, `set forget
  --json` называют действие, которому флаг принадлежит.
- R31-07, bash: `backup --h` → `--help --hot`, `backup <Tab>` — действия и флаги создания,
  `watch <Tab>` — только слова и `--help`.
- R31-08: мутация `restoreData = true` и удаление `resolveFrameworkFromSources()` теперь
  роняют проверки; допуск времени старта — абсолютные 14/16 с; аудит единственного
  определения `regexEscape`/`shellQuote` идёт и по `tools/checks`.
- Упаковка: `npm pack --dry-run` — 349 файлов, ни одного `.ts`, кроме `.d.ts`; у всех четырёх
  экспортов есть `.js` и `.d.ts`; в `dist/` нет ни одного `#src/`; таблица
  `FRAMEWORK_EXPORT_SOURCES` сверяется с `exports` в обе стороны.
- Мёртвого кода почти нет: из экспортов `tools/framework` ни на что не ссылаются только два
  словарных типа (`PathSpace`, `SetEntity`).
- `set validate` по дереву: `blocking:` вместо `warning:`, код в итоге один раз, `--json` —
  документ и код 1; в MCP `problems` заполнены.
- Холодный старт `control-mcp` до ответа `tools/list` — 347 мс (установленное), 529 мс
  (чекаут); все 45 `--help` — код 0, 0,3–0,4 с.

## 4. Порядок работ

1. R32-03 — убрать совет `bootstrap` для развёрнутого экземпляра (`lock` / `upgrade --image`).
2. R32-01 — откат на ту же строку образа, что окажется в `.env`; заглушка с `.Config.Image`.
3. R32-02 — вернуть pwsh-дополнение с префиксом; проверка через `TabExpansion2` на Windows CI.
4. R32-05 — ворота артефакта: целостность отдельно от смысла, находки — через `report()`.
5. R32-04 — описания схемы по действиям и без обрывов внутри скобок, пока бюджет `tools/list`
   не кончился.
6. R32-06, R32-07 — тексты справки `upgrade` и `backup`.
7. R32-08, R32-09 — порядок разбора аргументов, JSON при отказе, автодополнение значений и
   справка вне приложения.
8. R32-10 — проверки, которые различают; проба шлюза без риска для настоящего `apps/`.
9. R32-11 — CHANGELOG и гигиена.
