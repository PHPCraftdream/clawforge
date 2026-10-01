# Ревью ClawForge, раунд 33 — после фиксов раунда 32

Дата: 2026-10-01. База: `main` @ 720a530. Предыдущий: раунд 32
(`docs/internal/review-2026-10-01-round-32.md`, R32-01…R32-11 закрыты коммитами 239bad4,
cce0a92, 4eae8b5, bc4015a и 720a530). Сами фиксы раунда 32 повторного ревью ещё не проходили —
это первое.

Запрос: независимое ревью по фактам — ошибки, неточности, удобство, недостающие инструменты,
пахнущий код.

Метод: разбор `git diff f883353..HEAD` (45 файлов: `instance/upgrade.ts`, `recover-env/facts.ts`,
`sets/set*.ts`, `set/artifacts/install.ts`, `set/ownership/validate.ts`, `core/arguments.ts`,
`core/io/{help-render,output}.ts`, `entry/{bin,cli}.ts`, `integration/{gate,completion}.ts`,
`integration/mcp/schema.ts`, `runtime/datadir.ts`, `restore`, `logs`, `smoke`, `provider`,
`expose/ssh`, `incident`, проверки, руководство, CHANGELOG). Пробы — свежий `dist/` этой ревизии
(`npm run build`); роль системной команды — копия собранного пакета в
`apps/.r33/g/node_modules/@clawforge/framework` (`version --verbose` → `source: global`);
установленное приложение `apps/.r33/app1` (`init` через `--project-root`), развёртывание
чекаута `apps/r33a` (`./clawforge new-app`), подпапка чекаута `apps/.r33/outside`. Цель обоих
развёртываний — `OC_TARGET_LOCATION=ssh` с неразрешимым хостом `r33-unreachable.invalid`: WSL и
Docker не трогались, команды, которым нужна цель, честно падают на недоступности. Свежие входы
(не повторяющие раунды 28–32): 22 вызова с `--json` при недоступной цели (в том числе `inspect`,
`plan`, `operations`, `watch status`, `recipe list`, `accept`, `verify`, `bootstrap --check`,
`backup --dry-run`); `help` для 48 имён, включая `control-mcp`; 43 строки `COMP_WORDS` в
настоящем bash (скрипты чекаута и установленного, оба через `bash -n`) и те же сценарии через
`completionCandidates()`; `set validate|build|diff` на дереве с lock для другого образа, с
`recipe.json` без `description`, с агентным рецептом без `server.ts`, на битом и на
отсутствующем артефакте; `recipe install|verify|onboard|diagnose|status|logs|remove`,
`provision-agent` и 10 сочетаний `secrets` с неизвестными именами; MCP `initialize` +
`tools/list` обоих видов, скан всех 210 описаний аргументов на баланс скобок и кавычек,
7 вызовов `tools/call`. `upgrade()` — настоящая функция на заглушке из `upgrade.check.ts`
(копия в `apps/.r33`): `--image repo@sha256:…` с `--json` и `--dry-run`, откат при `.env` с
голым тегом, опечатка в digest. Путь `cli`/`exec` — команда приложения в `apps/r33a/app.ts`,
вызывающая тот же примитив (`spawnLocal(…, { stream: true })`, ненулевой код →
`dieWithExitCode`). Мутационные пробы (каждая откачена, `git status` после — чистый): два
изменения тела pwsh-комплитера, строгое сравнение образа в `facts.ts`. Скрипты: граф
статических импортов `tools/framework` (компоненты сильной связности), длины файлов и размеры
каталогов, `npm pack --dry-run`. Прогнаны проверки: `foundation/core/arguments` (4 файла),
`completion`, `connection-facts` (6), `hook-framework-import`. Статически — `--json`-контракт,
`withArtifactInspected`, `upgrade`, `provision-agent`, `recipe`, `secrets`, повторный
`bootstrap`, `restore`/`datadir`, допуски по времени в проверках; руководство против поведения —
`README.md`, `commands.md`, `sets.md`, `monitoring-and-access.md`, `data-and-backups.md`. Вывод,
сделанный рассуждением, а не воспроизведением, помечен «по коду». Каталоги проб удалены.

Не проверялось: живой `bootstrap`/`up`/`upgrade`/`backup`/`restore` — цель не трогалась вообще;
`backup list` и `restore --dry-run` на пустом каталоге данных (нужна достижимая цель);
пересоздание контейнера Compose при другой строке `image:` — по коду Compose (`ServiceHash`
включает `image`), не запуском; горячая перезагрузка `openclaw.json` самим OpenClaw. Настоящие
`cli`/`exec` (нужен Docker) — только через тот же примитив. PowerShell, `zsh` и `cmd.exe` не
запускались (pwsh — по коду и мутацией проверки). Установленная команда вне любого чекаута
(нужен каталог за пределами рабочей копии) — только в подпапке чекаута. Linux-хост, macOS,
настоящая ssh-цель. `system-install.check.ts` и полный `npm run check` не запускались.

Шкала: P0 — ломает данные/безопасность; P1 — ломает основное обещание; P2 — неверное
поведение в реальном сценарии; P3 — шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| R33-01 | P2 | `entry/cli.ts:167-174`, `core/io/output.ts:16, 60-68`, `runtime/transport/exec.ts:211, 231`, `commands/interface/{cli.ts:27, exec.ts:24}`, `runtime/docker/{helper-container.ts:54, compose-operations.ts:287}`, `docs/guide/commands.md:38-45` | новый `--json`-контракт срабатывает на чужой `--json`: `clawforge cli … --json` (и `exec`) при ненулевом коде дописывает к собственному JSON дочернего процесса второй документ `{"error":…}` — потоковый вывод идёт мимо счётчика `emit`; `jq` получает два документа; воспроизведено тем же примитивом |
| R33-02 | P2 | `checks/integration/agent/recipe-hook-freshness/hook-framework-import.check.ts:105-114` | фикс R32-10: проба шлюза перед прогоном удаляет целиком каждый `apps/gateprobe-*` — это законное имя развёртывания: `new-app gateprobe-prod`, затем `check hook-framework-import` — каталог с `.env`, `secrets/`, lock и `sets/` исчез; воспроизведено |
| R33-03 | P3 | `set/artifacts/install.ts:402-417`, `commands/sets/set-diff.ts:349-350`, `commands/sets/set.ts:109, 120` | регрессия 4eae8b5: `withArtifactInspected` оборачивает и ошибки тела — `set diff <целый> <битый>` винит целый («A is not a valid set artifact: B is not a valid set artifact: …»), `set validate --set` с блокирующей находкой кончается «not a valid set artifact: 1 blocking finding(s)»; воспроизведено (консоль, `--json`, MCP) |
| R33-04 | P3 | `commands/lifecycle/instance/upgrade.ts:181, 189-193, 230, 246, 311, 338, 356`, `docker-compose.yml:31`, `docs/guide/commands.md:73` | фиксы R32-01/R32-06 неполны: явный digest того же репозитория и откат при голом теге пересоздают шлюз на бестеговой строке, а в `.env` пишут `repo:tag@sha256:…` — следующий `up`/`apply` пересоздаст шлюз снова (по коду Compose); `--json` (`pinnedImage`) и `--dry-run` называют бестеговую строку, хотя пишется теговая; воспроизведено на заглушке |
| R33-05 | P3 | `commands/lifecycle/instance/upgrade.ts:60, 92-93, 214-223, 302-306` | явный `--image repo@sha256:…` не проверяется ни по формату, ни в реестре: `--dry-run` с опечаткой печатает «registry …@sha256:typo» и «upgrade available»; настоящий прогон сначала делает бэкап (без `--native` — с остановкой шлюза), и только Compose откажет на pull; воспроизведено на заглушке |
| R33-06 | P3 | `set/ownership/validate.ts:107-123`, `commands/sets/set-manifest.ts:65-93`, `service/inspection.ts:291-298`, `commands/management/lock.ts:144`, `runtime/docker/container-introspection.ts:110-118` | фикс R32-03 неполон: ветка «lock есть» у `SET_IMAGE_UNPINNED` бывает только при lock для другого образа (или без digest) — там `set validate` безусловно советует `./clawforge lock` («records the digest the running gateway already serves» — неверно, `lock` читает локальный образ тега), а `set build` для того же состояния — `upgrade --image`; «lock есть ⇒ развёрнут» ложно для закоммиченного lock; воспроизведено |
| R33-07 | P3 | `commands/management/recipe/index.ts:176-177`, `recipe/actions.ts:306, 311, 316, 413`, `provision-agent/index.ts:66-67`, `commands/management/secrets.ts:50-61, 286-289` | класс R32-08 остался: `recipe install|verify|onboard|diagnose <опечатка>` берёт замок на цели до проверки, что рецепт есть (`--dry-run` той же команды отвечает локально); `provision-agent <опечатка>`, `secrets --apply --store <опечатка или ../x>` — тоже сначала цель; воспроизведено |
| R33-08 | P3 | `set/ownership/validate.ts:128-172`, `service/recipe.ts:251-267`, `service/inspection.ts:253-258` | `set validate` не разбирает `recipe.json`: рецепт, который `recipe list` называет сломанным («needs a description»), — «coherent», собирается и проходит `validate --set`, упадёт только при установке; совет `SET_RECIPE_INCOMPLETE` один на пять разных деталей («add recipe.json or server.ts» не снимает «declares an agent but has no server.ts»); воспроизведено |
| R33-09 | P3 | `integration/gate.ts:238-240, 244-266`, `entry/cli.ts:66-78`, `core/io/help-render.ts:109-110`, `integration/completion.ts:100, 152` | `help control-mcp` → «unknown command: control-mcp / did you mean: control-mcp» (код 1) — в чекауте, в установленном приложении, в подпапке чекаута и в MCP `help`; общая справка и автодополнение его предлагают; воспроизведено |
| R33-10 | P3 | `checks/foundation/core/arguments/completion-behaviour.check.ts:64-159`, `action-arguments.check.ts:95-106`, `integration/completion.ts:144-150, 202-204, 233-237, 305-311, 338, 357`, `CHANGELOG.md:13-15` | тело pwsh-комплитера по-прежнему проверяется подстроками: мутация класса R32-02 (`-ne ''` → `-eq ''` в условии `$scan`) проходит все 5 файлов; модель/pwsh и bash расходятся на `status --app <Tab>` (имена развёртываний против флагов); значения `--kind` предлагаются и для `set try`; воспроизведено |
| R33-11 | P3 | `commands/lifecycle/bootstrap/index.ts:137-171`, `commands/orchestration/config.ts:44-52`, `runtime/docker/compose-operations.ts:205-207`, `README.md:59-60`, справка `bootstrap` | повторный `bootstrap` на живом экземпляре пишет desired-state, подавляет совет «restart to pick it up» и не перезапускает шлюз (`compose up --detach` неизменный контейнер не трогает) — по собственной модели фреймворка новые настройки не действуют; справка и README обещают «refreshes the image and restarts»; по коду |
| R33-12 | P3 | `CHANGELOG.md:65-84`, `docs/guide/{commands.md:38-45, 73; monitoring-and-access.md:250-263, 288; sets.md:89-91}`, `incident/index.ts:374`, `set/artifacts/install.ts:358, 366, 475`, `core/io/help-render.ts:172-174`, `restore/index.ts:189-196`, `runtime/datadir.ts:194-201, 228-234` | тексты и гигиена: в CHANGELOG — устаревший хвост пункта R31-04 и вклеенный обрывок; `--json`-контракт описан с неверным примером и без перечня форм отказа; `incident --dry-run` и подтверждение `set` в руководстве устарели; «installing from» у `plan --set`/`accept --set`; «depending on the action given» у команд без действий; три копии `readlink -f` |

P0 и P1 нет.

## 2. Подробно

### R33-01 (P2). `--json`-контракт дописывает второй документ к выводу `cli`/`exec`

```
(apps/r33a/app.ts: команда r33passthrough — spawnLocal(node -e "печатает {child:'own document'}; exit 3",
 { stream: true, allowFailure: true }), затем dieWithExitCode — путь cli/exec вне MCP)
$ ./clawforge r33passthrough lint --json > out 2> err          → код 3
stdout:
{"child":"own document"}
{
  "error": {
    "message": "child lint --json failed (exit 3)"
  }
}
$ ./clawforge r33passthrough lint                              → stdout: {"child":"own document"}, код 3
```

- `reportJsonFailure` (`entry/cli.ts:167-174`) решает «вызов с `--json`» по наличию любого
  токена `--json` в argv до `--`, а «команда уже напечатала свой документ» — по счётчику
  вызовов `emit`/`emitRaw` (`core/io/output.ts:16, 60-68`). У `cli` и `exec` весь хвост argv —
  аргументы дочернего процесса (`--json` принадлежит OpenClaw или запускаемой команде), и вне
  MCP их вывод идёт потоком: `options` без `input` (`cli.ts:27`, `exec.ts:24`) → `stream: true`
  (`helper-container.ts:54`, `compose-operations.ts:287`) → `process.stdout.write` в
  `runtime/transport/exec.ts:211, 231` либо наследование stdio на терминале — мимо счётчика.
  Итог: собственный JSON дочернего процесса, а за ним `{"error":…}` от clawforge; при отказе
  без вывода — документ clawforge в формате, которого вызывающий не просил.
- Реальный сценарий: `clawforge cli doctor --lint --json | jq …` — сам фреймворк отмечает, что
  `doctor --lint` отвечает ненулевым кодом и на рядовых предупреждениях (`upgrade.ts:123-128`).
  Руководство (`commands.md:38-45`) обещает обратное: документ — только когда иначе stdout пуст.
- `host` в трубе захватывает вывод и зовёт `emitRaw(result.stdout)` и для пустой строки —
  счётчик растёт, и контракт молча не срабатывает; на терминале (поток) — как `cli`.
- По коду: счётчик учитывает и записи, ушедшие в заглушённый сток (`withOutputSink(() => {}, …)`
  в `upgrade`, `restore`, `smoke`, `state`, `verify`, `deploy`, `bootstrap`) — эмит внутри
  такого блока и последующий отказ без собственного документа оставят stdout пустым.
- `failure-order.check.ts:183-236` проверяет контракт на командах, у которых `--json` даже не
  объявлен, и под стоком захвата — потоковый вывод дочернего процесса там не виден.

Предложение: решать по объявлению — документ ошибки только если у команды объявлен флаг `json`
и он разобран `parseDeclaredArgs` (у `cli`/`exec`/`host` с вариадическими `args` — никогда);
«уже напечатано» считать по байтам, реально ушедшим в `process.stdout` (учёт в `emitRaw`
только без стока плюс форвардер `exec.ts`). Проверка: `cli`-подобная команда на заглушке
рантайма, печатающая свой JSON и выходящая с кодом 1, — ровно один документ.

### R33-02 (P2). Проба шлюза удаляет чужие развёртывания `apps/gateprobe-*`

```
$ ./clawforge new-app gateprobe-prod                                         → created …/apps/gateprobe-prod (код 0)
$ ls apps                                                                    → .r33/ gateprobe-prod/ r33a/
$ node --experimental-strip-types tools/clawforge.ts check hook-framework-import   → 1 check file(s) passed
$ ls apps                                                                    → .r33/ r33a/
```

- Фикс R32-10.4 (`hook-framework-import.check.ts:105-114`) заменил фиксированное имя префиксом
  и перед прогоном удаляет (`rm` с `recursive`/`force`) всё в `apps/`, что начинается с
  `gateprobe-`. Это законное имя развёртывания (строчные буквы, цифры, дефисы — `new-app`
  принимает), а в каталоге развёртывания лежат `.env` с токеном шлюза, `secrets/` (локальные
  хранилища значений), `config/deployment.lock.json`, `sets/` и `incidents/` — восстановить
  неоткуда. `check` — команда, которую общая справка и CONTRIBUTING предлагают запускать в
  чекауте, где и живут настоящие развёртывания. Обоснование в комментарии («safe because the
  file is marked check:exclusive and owns that prefix») защищает от других проверок, но не от
  пользователя.
- Вероятность низкая (нужно совпадение префикса), последствие — безвозвратная потеря
  конфигурации и секретов развёртывания; поэтому P2.

Предложение: помечать фикстуру файлом-маркером (например `.clawforge-check-fixture` с
идентификатором прогона, записанным до `app.ts`) и подметать только каталоги с маркером.
Проверка: заранее созданный `apps/gateprobe-keep` без маркера переживает прогон.

### R33-03 (P3). `set diff`/`set validate --set`: ошибки тела выдаются за «not a valid set artifact»

```
$ ./clawforge set diff <A, целый> apps/.r33/broken.tar.gz
error: <A> is not a valid set artifact: apps/.r33/broken.tar.gz is not a valid set artifact:
       could not inspect apps/.r33/broken.tar.gz: gzip: stdin: not in gzip format …           (код 1)
$ ./clawforge set diff <A> apps/.r33/missing.tar.gz --json
{ "error": { "message": "<A> is not a valid set artifact: apps/.r33/missing.tar.gz is not a valid set artifact: …" } }
MCP tools/call set {action: diff, from: A, to: broken}  → тот же текст
$ ./clawforge set validate --set <A; рецепт zeta без recipe.json и server.ts>
blocking: SET_RECIPE_INCOMPLETE  recipe "zeta" is neither an MCP recipe (server.ts) nor a service (recipe.json)
error: <A> is not a valid set artifact: 1 blocking finding(s): SET_RECIPE_INCOMPLETE                (код 1)
```

- `withArtifactInspected` (`set/artifacts/install.ts:402-417`) держит в одном `try` и проверку
  артефакта, и вызов `body`, и любое исключение превращает в `die("<artifact> is not a valid
  set artifact: …")`. Прежний `withUnpackedArtifact` (`:472-484`) тело не оборачивал — это
  регрессия 4eae8b5. Следствия: во вложенном `set diff` (`set-diff.ts:349-350`) отказ второго
  артефакта приписывается первому, целому — чинить начнут не тот файл; итог `set validate
  --set` (`report` бросает «N blocking finding(s)», `set.ts:109`) звучит как нарушение
  целостности — ровно та формулировка, которую R32-05 просил оставить только для целостности
  (то же обещают комментарий `install.ts:410-412` и CHANGELOG `:111-118`).
- `set-validate.check.ts` смотрит на `blocking:` и на JSON, но не на итоговую строку и не на
  `set diff` с битым вторым артефактом.

Предложение: `try/catch` только вокруг `verifyArtifact`, ошибки `body` пропускать как есть.
Проверка: `set diff <целый> <битый>` называет только битый; `validate --set` с блокирующими
находками кончается «N blocking finding(s)» без «not a valid set artifact».

### R33-04 (P3). `upgrade`: строка образа контейнера и `.env` снова расходятся, отчёты называют не тот пин

Настоящая `upgrade()` на заглушке из `upgrade.check.ts`:

```
(.env: ghcr.io/openclaw/openclaw:extended-stable@sha256:pinned…; upgrade --image ghcr.io/openclaw/openclaw@sha256:target…)
--dry-run          : 5. on success: pin OPENCLAW_IMAGE to ghcr.io/openclaw/openclaw@sha256:target… in .env
--json             : {"ok":true,"changed":true,…,"pinnedImage":"ghcr.io/openclaw/openclaw@sha256:target…"}
recreateWithImage  : ghcr.io/openclaw/openclaw@sha256:target…
.env после         : ghcr.io/openclaw/openclaw:extended-stable@sha256:target…

(.env: ghcr.io/openclaw/openclaw:extended-stable — голый тег; doctor --lint падает → откат)
recreateWithImage  : …@sha256:target…   затем   ghcr.io/openclaw/openclaw@sha256:previous…
контейнер после    : ghcr.io/openclaw/openclaw@sha256:previous…
.env после         : ghcr.io/openclaw/openclaw:extended-stable@sha256:previous…
```

- Явный digest того же репозитория (R32-06): шлюз пересоздаётся на бестеговой строке
  (`upgrade.ts:230`, `targetDigest`), а в `.env` пишется теговый `target.pin` (`:246`, `:338`).
  Откат при голом теге (R32-01): пересоздание на `previousDigest` (`:181`), пин — `тег@digest`
  (`:189-193`). В обоих случаях контейнер создан со строкой `image:`, отличной от той, что
  следующий `compose up` прочтёт из `.env` (`docker-compose.yml:31`): хеш конфигурации сервиса
  другой, и следующий `up` или `apply` пересоздаст шлюз ещё раз — то самое «the next up
  recreating again», которое комментарий `:167-172` обещает устранить (по коду Compose).
  `ENV_STALE` этого уже не видит — сравнение по digest (`facts.ts:64-69`) скрывает разницу в
  написании; проверка `upgrade.check.ts` для голого тега утверждает только отсутствие
  расхождения по digest, для явного digest — только значение в `.env`.
- `--json` успеха сообщает `pinnedImage: target.targetDigest` (`:356`), `--dry-run` — «pin …
  to ${target.targetDigest}» (`:311`), хотя пишется `target.pin`: скрипт, сверяющий `.env` с
  `pinnedImage`, увидит расхождение. R32-06 закрыт в `.env`, но не в отчётах.
- `commands.md:73` по-прежнему: откат «restores OPENCLAW_IMAGE to its exact pre-upgrade
  reference (tag and digest)» — для голого тега это уже не так (`data-and-backups.md`
  исправлен, таблица команд — нет).

Предложение: пересоздавать на той строке, что будет записана: успех —
`target.pin ?? target.targetDigest`, откат — уже вычисленный пин; ту же строку отдавать в
`pinnedImage` и шаге 5 `--dry-run`. Проверка: заглушка сравнивает строку `recreateWithImage`
с `parseEnv(.env).OPENCLAW_IMAGE` побуквенно, а не по digest. Поправить `commands.md:73`.

### R33-05 (P3). `upgrade --image repo@sha256:…` не проверяет digest

```
(заглушка; .env: …:extended-stable@sha256:pinned…)
$ upgrade --image ghcr.io/openclaw/openclaw@sha256:typo --dry-run
==> registry   ghcr.io/openclaw/openclaw@sha256:typo
==> upgrade available: ghcr.io/openclaw/openclaw@sha256:previous… -> ghcr.io/openclaw/openclaw@sha256:typo
вызовов resolveImageDigest: 0
```

- Явный digest узнаётся по подстроке `@sha256:` (`upgrade.ts:60`) — без проверки формата
  (64 шестнадцатеричных знака) и без обращения к реестру; `--dry-run` подписывает его строкой
  `registry` (`:302`), хотя реестр не спрашивали, и объявляет обновление доступным. Для тега тот
  же путь сначала спрашивает реестр и отказывает, если ответа нет (`:92-93`). Настоящий прогон
  с опечаткой дойдёт до отказа Compose на pull только после предварительного бэкапа
  (`:214-223`; без `backup --native` — остановленный полный бэкап, то есть простой шлюза), а
  затем пройдёт цикл отката.

Предложение: при разборе проверять `^[^@\s]+@sha256:[0-9a-f]{64}$`; в `--dry-run` и до
бэкапа звать `resolveImageDigest(requestedImage)` (`buildx imagetools inspect` принимает и
digest) и отказывать, если реестр его не знает; подпись `registry` — только при ответе реестра.

### R33-06 (P3). `SET_IMAGE_UNPINNED` советует `lock` там, где `set build` советует `upgrade`

```
(apps/r33a: OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:extended-stable;
 config/deployment.lock.json записан для ghcr.io/openclaw/openclaw:2026.6 с digest)
$ ./clawforge set validate
blocking: SET_IMAGE_UNPINNED  the set requires image …:extended-stable, which is a tag — …; ./clawforge --app r33a lock
          records the digest the running gateway already serves, while ./clawforge --app r33a bootstrap would re-resolve …
      → ./clawforge --app r33a lock
$ ./clawforge set build
error: the lock's digest does not belong to …:extended-stable — it was recorded for …:2026.6, …
A lock only exists on a deployed instance, so the safe paths are the upgrade ones: run ./clawforge --app r33a upgrade
--image <repo:tag> to move to the image now declared, or ./clawforge --app r33a lock if the running gateway already serves it. …
```

- В ветку «lock есть» `checkImagePinned` (`validate.ts:107-123`) попадает только в двух
  состояниях `requiredImage` (`set-manifest.ts:65-93`): lock записан для другого образа
  (`:70-71`) или lock без digest (`:86`). В первом шлюз почти наверняка работает на образе
  lock'а, а `.env` уже называет другой тег: `set build` советует `upgrade --image` и `lock` лишь
  условно, `set validate` для того же состояния — безусловно `lock`. Во втором `lock` снова
  запишет lock без digest (`imageReference()` пуст, пока тега нет локально) — совет по кругу
  (по коду).
- «lock records the digest the running gateway already serves» неверно: `lock` пишет
  `{reference: OPENCLAW_IMAGE, digest: RepoDigests[0] локального образа этого тега}`
  (`lock.ts:144`, `container-introspection.ts:110-118`), а не образ контейнера. Если новый тег
  уже вытянут, `lock` закрепит его digest при работающем старом образе, `set build` соберёт
  набор под образ, которого шлюз не запускал, и отказ всплывёт при установке (по коду).
- «A lock only exists on a deployed instance» (`set-manifest.ts:75`) и вывод «lock есть ⇒
  развёрнут» (`validate.ts:109-113`, `inspection.ts:294-296`) ложны для закоммиченного lock'а:
  справка `lock` — «Meant to be committed», `new-app` советует `git init` ради этого
  (`integration/deployment/scaffold.ts:78`); в свежем клоне на новом хосте lock есть,
  экземпляра нет, и `lock`, и `upgrade` откажут.

Предложение: одна функция совета для `requiredImage` и `checkImagePinned`, по реальному
состоянию: lock для другого образа — «upgrade --image <объявленный тег>; lock — только если
шлюз уже работает на нём»; lock без digest — «вытянуть тег (bootstrap до первого
развёртывания, иначе upgrade), затем lock»; без lock — оба случая. Не выводить «развёрнут» из
наличия файла; описывать `lock` как «записывает digest локального образа, который называет
OPENCLAW_IMAGE».

### R33-07 (P3). Локальные отказы после похода на цель: `recipe`, `provision-agent`, `secrets --store`

```
$ ./clawforge recipe install nosuch            → error: ssh:… is unreachable — …
$ ./clawforge recipe install nosuch --dry-run  → error: recipe "nosuch" not found — expected recipes/nosuch/recipe.json
$ ./clawforge recipe verify|onboard|diagnose nosuch               → error: ssh:… is unreachable — …
$ ./clawforge recipe status|logs nosuch, recipe remove nosuch --dry-run → recipe "nosuch" not found — …
$ ./clawforge provision-agent nosuch           → error: ssh:… is unreachable — …   (то же для alpha — рецепт без агента)
$ ./clawforge secrets --apply --store nosuch   → error: ssh:… is unreachable — …
$ ./clawforge secrets --store ../x --apply     → error: ssh:… is unreachable — …
```

- `recipe` берёт замок экземпляра (`recipe/index.ts:176-177`, `guarded`; замок живёт на цели)
  раньше, чем действие узнаёт, есть ли рецепт (`stackFor`, `recipe/actions.ts:306, 311, 316,
  413`); `provision-agent` зовёт `requireBootstrapped` и `isRunning`
  (`provision-agent/index.ts:66-67`) до чисто локального `loadRecipeAgentBundle`
  (`declaration.ts:83-102`); `secrets --apply` — `requireBootstrapped` и `guarded`
  (`secrets.ts:286-289`) до проверки имени и наличия хранилища (`secretStoreFile` → `safeName`,
  `runtime/deployment.ts:115-117`; «not found» — `secrets.ts:50-61`).
- Опечатка стоит похода на цель (на WSL — секунды, по MCP — на каждый вызов), при занятом
  замке отвечает «lock held», при недоступной цели — ошибкой транспорта; `recipe install` и
  `recipe install --dry-run` на одну опечатку отвечают по-разному. R32-08 закрыл тот же класс
  в трёх командах, `failure-order.check.ts` проверяет только их.

Предложение: разрешать рецепт (`loadRecipe`, `loadRecipeAgentBundle`) и имя/наличие хранилища
до `requireBootstrapped`/`guarded`; в `failure-order.check.ts` — эти случаи с утверждением
«the target was never contacted».

### R33-08 (P3). `set validate`: `recipe.json` не проверяется, совет `SET_RECIPE_INCOMPLETE` один на все случаи

```
(recipes/alpha/recipe.json = {"compose":"docker-compose.yml"} — без description)
$ ./clawforge recipe list --json        → {"recipes":[],"bundles":[],"broken":[{"name":"alpha","error":"recipes/alpha/recipe.json needs a description"}]}
$ ./clawforge set validate              → set r33a is coherent  (код 0)
$ ./clawforge set build                 → built set r33a (3 file(s))
$ ./clawforge set validate --set <он>   → set r33a is coherent and its artifact contents match  (код 0)
(recipes/beta: agent/config.json, agent/AGENTS.md, page.md — без server.ts)
$ ./clawforge set validate
blocking: SET_RECIPE_INCOMPLETE  recipe "beta" declares an agent but has no server.ts — that is the file the gateway is registered to spawn
      → add recipe.json or server.ts to recipes/beta, or remove the directory
```

- `checkRecipesComplete` (`validate.ts:128-172`) проверяет наличие файлов, но не разбирает
  `recipe.json` тем разборщиком, которым его читают `recipe list` и `recipe install`
  (`service/recipe.ts:251-267`). Набор с рецептом, который `recipe list` называет сломанным,
  проходит `validate` и `build` и падает только при установке — на цели, посреди
  `apply --set`. Справка `set`: «validate checks a whole set with no running instance — recipe
  completeness, …».
- Совет (`validate.ts:132-133`) одинаков для пяти разных деталей: для «declares an agent but has
  no server.ts» добавленный `recipe.json` находку не снимет (агентному рецепту нужен именно
  `server.ts`); для «no agent/config.json» и «serves no content» совет не о том; для артефакта
  править `recipes/<имя>` нельзя — нужна пересборка из дерева. `nextAction` по умолчанию
  (`inspection.ts:257`) — «./clawforge set validate  (after …)» с двойным пробелом.

Предложение: для рецепта с `recipe.json` звать разборщик определения рецепта и сообщать его
ошибку (тем же кодом или новым `SET_RECIPE_INVALID`); совет — по детали («add server.ts»,
«add agent/config.json», …), для артефакта — «fix the tree and rebuild».

### R33-09 (P3). `help control-mcp` не работает

```
$ ./clawforge help control-mcp
error: unknown command: control-mcp
    did you mean: control-mcp
    run ./clawforge --app r33a help to list every command            (код 1)
$ ./clawforge control-mcp --help                                     → справка (код 0)
установленная команда в приложении — то же; в подпапке чекаута — «unknown command: control-mcp»
MCP tools/call help {command: "control-mcp"}                         → тот же текст ошибки
```

- Общая справка перечисляет `control-mcp` и обещает «help <command> — same as: <command>
  --help» (`help-render.ts:109-110`); автодополнение предлагает `help control-mcp`
  (`completion.ts:100, 152`). Но `renderHelp` (`gate.ts:244-266`) знает только команды
  приложения и шлюза, текст `control-mcp` встроен прямо в `runApp` (`cli.ts:66-78`), а
  `knownCommandNames` (`gate.ts:238-240`) имя включает — отсюда совет исправить на самого себя.

Предложение: вынести справку `control-mcp` в объявление, которое читает `renderHelp`;
`closestCommand` не предлагать точное совпадение. Проверка: `help <имя>` для каждого имени из
`knownCommandNames` — код 0.

### R33-10 (P3). Автодополнение: тело pwsh проверяется подстроками, модель и bash расходятся

| Мутация `integration/completion.ts` (откачена) | Проверки | Итог |
|---|---|---|
| `:338` `if ($wordToComplete -ne '' -and $scan.Count -gt 0)` → `-eq ''` (класс R32-02: набираемое слово снова сканируется как команда, после пробела теряется последнее) | `foundation/core/arguments` (4 файла), `completion` | все прошли |
| `:367` `if ($between.Count -eq 0)` → `-eq 1` | те же | упала одна — подстрока в `action-arguments.check.ts:105` |

```
                                   настоящий bash         | completionCandidates() и pwsh
clawforge status --app <Tab>    => --help --json          | r33a r33b   ($ clawforge status --app r33a → «--app must come before the command»)
clawforge set try --kind <Tab>  => agent mcp-server cron-job — в обоих, хотя у `set try` нет `--kind`
```

- Раздел pwsh в `completion-behaviour.check.ts:64-159` берёт из скрипта только таблицы и
  гоняет по ним JS-функцию `completionCandidates` — тело `Register-ArgumentCompleter` (`$scan`,
  `$prev`, `$between`, порядок веток) не исполняется; остаются подстроки
  (`completion-behaviour.check.ts:146-150`, `action-arguments.check.ts:95-106`). CHANGELOG
  (`:13-15`) обещает «not script substrings». Регрессия класса R32-02 проходит зелёной.
- Модель и pwsh отвечают на `--app` после команды значениями развёртываний
  (`completion.ts:144-146`; в pwsh блок `:305-311` стоит вне ветки «команда не найдена»), bash —
  флагами команды (`:202-204` внутри `:233-237`): «одна модель» на деле две. Значения опций с
  `choices` берутся без учёта действия (`:150`, `:210-215`, `:357`).

Предложение: в Windows-задаче CI (там уже `shell: pwsh`) загружать сгенерированный скрипт и
звать `TabExpansion2 -inputScript … -cursorColumn …` по тем же сценариям, что и bash;
значения `--app` в модели и pwsh — только пока команда не найдена; ключ значений опции —
с действием (`set forget --kind`).

### R33-11 (P3). Повторный `bootstrap` на живом экземпляре не применяет desired-state до конца

- Справка `bootstrap` («Safe to run again on a live instance: it refreshes the image and
  restarts») и `README.md:59-60` обещают перезапуск. По коду: при закреплённом
  `OPENCLAW_IMAGE` образ не обновляется (тянется тот же digest, `bootstrap/index.ts:137-154`;
  тот же абзац README говорит «left alone»), а запуск — это `docker compose up --detach
  gateway` (`compose-operations.ts:205-207`), который неизменный контейнер не трогает. Между
  ними `applyConfig(live, [], { restartAdvice: false })` (`bootstrap/index.ts:164-165`) пишет
  desired-state и подавляет совет «restart to pick it up», потому что «the gateway starts a few
  lines below» — на живом экземпляре он не стартует. Собственная модель фреймворка
  (`config.ts:44-52`: «Not ./clawforge up: a healthy container already converges on `up`,
  reporting success while leaving the old settings live») говорит, что такие изменения без
  перезапуска не действуют. Итог: правка `desired-state.json` и повторный `bootstrap` —
  «desired state applied», «gateway is healthy», «OpenClaw is up», а работают старые
  настройки. По коду; горячая перезагрузка `openclaw.json` самим OpenClaw не проверялась.

Предложение: запоминать, работал ли шлюз до прогона; если работал и `applyConfig` или
`configureProvider` что-то изменили — `restart` (или вернуть совет); поправить «refreshes the
image and restarts» в справке и README.

### R33-12 (P3). Тексты и гигиена

- CHANGELOG `:65-84`: пункт о R31-04 сохранил устаревший хвост («the unpack gate (also behind
  … `set diff`, …) refuses it. `set validate --set` reports findings through the same path…»,
  `:71-77`), противоречащий `:111-118` (`set diff` такие артефакты принимает); `:81-84` —
  обрывок «`accept --set`) refuses it. …», вклеенный с середины предложения в пункт о
  `backup --help`.
- `commands.md:38-45` («one failure contract»): пример «`upgrade --dry-run`» неверен — его
  отказы печатают `{error}` (проверено: `upgrade --dry-run --json` при недоступной цели; тот
  же пример повторяет комментарий `failure-order.check.ts:194`). Свои документы отказа есть ещё у
  `bootstrap --check`, `watch check`, `set validate`, `incident`, `apply-config`, `restore`,
  `deploy`, а у `upgrade` и `restore` форма зависит от фазы (`{error}` до замка, `{ok:false,…}`
  под ним). Отказ сочетания флагов (`secrets --template --json`) даёт документ, неизвестный
  аргумент — нет. Скрипту нужно знать по меньшей мере три формы — так и написать.
- `monitoring-and-access.md:250-263, 288`: «A contain failure … is reported as a note, never
  thrown», «`--dry-run` prints the plan» — не сказано, что с bc4015a `--dry-run` при
  недоступной цели кончается кодом 1; заметка в выводе dry-run по-прежнему «— rotate proceeds
  regardless» (`incident/index.ts:374`), хотя rotate в dry-run нет.
- `sets.md:89-91`: «The group retains its conservative confirmation requirement» устарело —
  `diff`, `receipts`, `validate` объявлены только чтением (`openclawCommands.sets.ts:19`); MCP
  `set {action: receipts}` выполняется без `confirm` (проверено), `forget` — требует.
- `plan --set` и `accept --set` печатают «installing from <artifact>» (умолчание
  `install.ts:475`; `plan.ts:369`, `accept.ts:374`), хотя ничего не устанавливают;
  `apply --set` печатает его ещё дважды для временной копии отката (`storeArtifactForRollback`,
  `install.ts:358, 366`; по коду).
- «This command can replace or destroy state, depending on the action given»
  (`help-render.ts:172-174`) — и у команд без действий (`upgrade`, `apply`, `restore`, `push`,
  `deploy`, `destroy`, `incident`, `rollback`, `secrets`), где это зависит от флагов.
- Обход предков каталога данных теперь один (R32-11), но `readlink -f` живёт в трёх копиях:
  `restore/index.ts:189-196`, `datadir.ts:194-201` и встроенная в `assertCanonicalAncestry`
  (`datadir.ts:228-234`).

Предложение: поправить перечисленное; у `withUnpackedArtifact` умолчание заметки — «checking»,
«installing from» — только у установщиков; один `physicalPath(ctx, path, prefix)`.

## 3. Что хорошо

- R32-01: сравнение образа по digest держит проверка — мутация `facts.ts` обратно на строгое
  `!==` роняет `connection-facts/upgrade` (1 из 6 файлов); откат при теговом пине
  пересоздаёт шлюз на теговой строке, и `connectionFactDiffs` пуст (заглушка).
- R32-02, R32-09 в настоящем bash (43 строки): `sta` → `status`, `--ap` → `--app`,
  `--app r33a backup <Tab>` — действия и флаги создания, `backup --hot <Tab>` — без слов
  действий, `help ba` → `backup`, `completion <Tab>` — оболочки, `host <Tab>` — контексты,
  `--profile`/`--client`/`--kind` — значения; `bash -n` чист для обоих скриптов, в скрипте
  установленного нет `--app`.
- R32-03: отказ `set build` без lock называет оба состояния (`bootstrap` до первого
  развёртывания, `lock` на работающем).
- R32-04: все 210 описаний аргументов в `tools/list` со сбалансированными скобками и
  кавычками; `set.json` и `set.name` — по действиям, `cli.args`/`exec.args`/`check.jobs`/
  `host.root` — короткие явные строки; `tools/list` — 31 986 байт в чекауте (запас 782),
  30 767 в установленном.
- R32-05: MCP `set validate --set` на артефакте с блокирующей находкой — `problems`
  заполнены, документ в `result`; в консоли `--json` — документ и код 1.
- R32-07: `backup --help` — одна грамматика интервала в строке аргумента и в подробностях.
- R32-08: `logs --tail abc`, `smoke --zzz`, `configure-provider --provider` отказывают без
  похода на цель; `recover-env --zzz` — с подсказкой `--help` (и с `--json`); `--local-port
  65536` — отказ, `65535` — команда; `incident --dry-run` при недоступной цели — код 1;
  все 16 команд с `--json`, отказавших при недоступной цели, печатают ровно один документ
  (свой или `{"error":…}`).
- R32-09: установленная команда в подпапке чекаута отвечает на `status --help`,
  `help status`, `backup list --help` справкой с пометкой, где команда работает.
- R32-11: один обход предков для `restore` и `datadir` (отказ на пустом ответе `readlink`
  с кодом 0 сохранён); псевдоним `unpackForTry` удалён.
- Граф импортов: 170 модулей, 860 рёбер, ровно две компоненты сильной связности — те, что
  перечислены в `set-module-load.check.ts`; новый импорт `validate.ts` → `lock.ts` цикла не
  создал.
- Упаковка: `npm pack --dry-run` — 349 файлов, ни одного исходного `.ts`, все четыре экспорта
  (`.js` и `.d.ts`) и `bin` на месте; `FRAMEWORK_EXPORT_SOURCES` совпадает с `exports`.
- Раскладка: самый длинный файл фреймворка — `backup/index.ts` (655 строк), проверок —
  `recipe.check.ts` (672); исходных каталогов больше 7 записей нет.
- Допуски по времени в проверках (`transport-listing`, `recipe-readiness`, `contract.ts`) —
  верхние границы с запасом в секунды над дедлайнами в сотни миллисекунд; новых не появилось.

## 4. Порядок работ

1. R33-02 — маркер фикстуры вместо подметания по префиксу (потеря чужого развёртывания).
2. R33-01 — `--json`-контракт по объявлению команды; `cli`/`exec`/`host` вне его; учёт
   реально записанных байт.
3. R33-03 — `withArtifactInspected` оборачивает только проверку артефакта.
4. R33-04, R33-05 — `upgrade`: пересоздание на строке пина, отчёты по пину, проверка явного
   digest до бэкапа.
5. R33-06 — один совет по образу для `set build` и `set validate`.
6. R33-11 — перезапуск или совет после повторного `bootstrap` на живом экземпляре.
7. R33-07, R33-08 — локальные отказы до похода на цель; разбор `recipe.json` в
   `set validate`, советы по детали.
8. R33-09, R33-10 — `help control-mcp`; pwsh через `TabExpansion2`, `--app` после команды.
9. R33-12 — тексты и гигиена.
