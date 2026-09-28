# Ревью ClawForge, раунд 11 — после реализации раунда 10

Дата: 2026-09-28. База: `main` @ 4ad7cf8 (14 коммитов после последнего зелёного CI на 4da64e5,
не запушены). Предыдущее ревью: `docs/internal/review-2026-09-28-round-10.md` — его R1–R15
закрыты коммитами 9bce750…db5f7c2.

Метод: прогон CLI и `control-mcp` (stdio JSON-RPC) на временном развёртывании (`new-app
r11-probe`, без bootstrap; удалено после, на target ничего не создавалось), подмена
`OC_WSL_DISTRO` в `.env` на несуществующий дистрибутив, воспроизведение через `spawnLocal`,
чтение кода `deploy`, транспорта, `apply`, `backup`, сверка `docs/` и `.env` с кодом.
Вывод, сделанный рассуждением, а не воспроизведением, помечен «по коду».

Шкала: P1 — ломает основное обещание; P2 — неверное поведение в реальном сценарии; P3 —
шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| S1 | P2 | `runtime/transport/exec.ts` | вывод команды декодируется по чанкам: многобайтовый символ на границе 64 КБ портится (U+FFFD); воспроизведено |
| S2 | P2 | транспорт WSL, `doctor`/`plan`/`status` | недоступная цель диагностируется пустой строкой: `could not check whether … exists (exit 4294967295):`; текст ошибки `wsl.exe` (UTF-16LE) теряется; у `doctor` нет кода `TARGET_UNREACHABLE`, есть только у `watch` |
| S3 | P2 | `apply --dry-run` | считает advisory-шаги как «would run» и печатает вместо шага `(you)` без текста — `plan` для того же состояния говорит верно |
| S4 | P2 | команды с блокировкой | на не-bootstrapped развёртывании `backup`, `incident`, `configure-provider`, `smoke` падают на `mkdir …/operation.lock`, `apply-config --dry-run` печатает целиком внутренний `sh -c`-скрипт |
| S5 | P2 | `deploy` | `--path` по умолчанию зашит как `/opt/openclaw`; `OC_REMOTE_PATH`, который читают `.env`-шаблон и `watch install`, игнорируется |
| S6 | P3 | `check` | не принимает аргументов: `check --list` и `check <имя>` молча гоняют весь набор; прерванный прогон оставляет `apps/cli-help-check-*` |
| S7 | P3 | `control-mcp` | `tools/list` — 88 КБ (≈22 тыс. токенов): в описание каждого инструмента вложен весь `--help`; отдельного `help`-инструмента нет |
| S8 | P3 | окружение | экспортированные в оболочке `OC_*` (кроме `OC_APP`) молча игнорируются; нигде не сказано |
| S9 | P3 | argv | `new-app a b` создаёт `a`, `b` проглочен; `help help`; `status` при нескольких развёртываниях; unknown action без подсказки |
| S10 | P3 | `new-app` | `.gitignore` развёртывания не покрывает `state/` и `sets/`, а сообщение советует `git init` в нём |
| S11 | P3 | `backup`/`pull` | нечисловой `OC_BACKUP_KEEP`/`OC_SNAPSHOT_KEEP` молча выключает ротацию |
| S12 | P3 | код | внутренний ID аудита в тексте ошибки `deploy`; ~25 комментариев «used to / no longer»; 25 % строк — комментарии |
| S13 | P3 | код | `deploy()` 360 строк, ещё 9 функций 150–235 строк; лимит есть только на файл |
| S14 | P3 | доки/зависимости | `recover-env --adopt-runtime` нет в `commands.md`; `OC_DEBUG` нигде не описан; `@types/node` 22 при `engines >=24` |

## 2. Ошибки

### S1 (P2). Вывод команд портится на границе чанка

Воспроизведено: `spawnLocal(node, ["-e", "process.stdout.write('€'.repeat(300000))"])` вернул
300 014 символов вместо 300 000 и 23 символа U+FFFD.

Причина — `runtime/transport/exec.ts:125` и `:133`: `stdout += String(chunk)` и
`stderr += String(chunk)` декодируют каждый `Buffer` отдельно. Канал отдаёт куски по 64 КБ,
и символ из 2–4 байт, попавший на границу, распадается на два невалидных. Задет любой
не-ASCII вывод длиннее 64 КБ: логи, `config get`, списки файлов, `--json`; порча тихая.
Тот же `String(chunk)` кормит потоковый вывод (`forwardStdout.push`).

Исправление: `child.stdout.setEncoding("utf8")` (или `StringDecoder`) до первого `data`;
регрессионная проверка на `€`/`ж` через границу.

### S2 (P2). Недоступная цель диагностируется пустой строкой

Воспроизведено: в `.env` `OC_WSL_DISTRO=Nope`. `doctor`, `plan`, `status` отвечают
`error: could not check whether /srv/r11-probe/data exists (exit 4294967295):` — после
двоеточия пусто. `backup list` — `could not run \`test -d …\` on the target (exit
4294967295) — the transport failed, not the check`.

Причина: `wsl.exe` печатает собственные ошибки («There is no distribution with the supplied
name.») в UTF-16LE. `spawnLocal` декодирует как UTF-8, получается текст с NUL между
символами, который терминал показывает пустым. Кодировку знает только `parseWslDistroListing`
(`commands/interface/host/contexts.ts:58`), путь `exec` — нет. Код выхода −1 печатается
как `4294967295`.

Вторая половина: `watch check` превращает такой отказ в причину `TARGET_UNREACHABLE`
(`operate/watch/check.ts:110`), а `doctor`/`inspect`/`plan`/`status` просто падают
исключением — у них нет ни проблемы с `nextAction`, ни `--json`-ответа. Агент через
`control-mcp` получает `isError` с этой пустой строкой.

Это самый частый первый отказ на Windows (опечатка в имени дистрибутива, WSL остановлен).

Исправление: транспорт WSL нормализует UTF-16LE (срез NUL уже используется в
`parseWslDistroListing`) и помечает отказ самого `wsl.exe`/`ssh` типизированной ошибкой
транспорта; `doctor` получает блокирующий код `TARGET_UNREACHABLE` с подсказкой
(`OC_WSL_DISTRO`/`OC_SSH_HOST`, `wsl.exe -l -q`, `ssh -o BatchMode=yes …`); `status` и
`plan` отвечают им же; код выхода печатается знаковым.

### S3 (P2). `apply --dry-run` расходится с `plan`

Воспроизведено: на не-bootstrapped развёртывании `./clawforge plan` печатает
`1 step(s) — 0 that ./clawforge apply will run` и текст шага; `./clawforge apply --dry-run` —
`1 step(s) would run — nothing was applied` и строку `      (you)`.

Причина — `commands/orchestration/apply.ts:424–428`: счётчик берёт `plan.actions.length`
(включая advisory), а вместо описания advisory-шага печатается литерал `(you)`, `command`
у него пуст. После исправления `plan` (раунд 10, R1) каждая проблема без runner-а —
advisory-шаг, так что «пустая строка» теперь типичный вывод, а не редкий.

Дополнительно: `isApplyDryRun()` (`apply.ts:173`) — рукописный разбор argv рядом с
`parseDeclaredArgs`, который уже разобрал тот же флаг.

Исправление: считать и печатать так же, как `plan` (общий рендер шага, разделение
«выполнит / сделайте сами», `because`); флаг брать из результата `parseDeclaredArgs`.

### S4 (P2). Не-bootstrapped развёртывание: сырые ошибки вместо `NOT_BOOTSTRAPPED`

Воспроизведено на `r11-probe`:

- `backup`, `incident`, `configure-provider` — `could not take the instance lock at
  /srv/r11-probe/data-locks/operation.lock: mkdir: cannot create directory … No such file or
  directory` + «Nothing holds it — the directory is not there»;
- `smoke` — сначала два `FAILED` (`healthz returned 0`, `container health is "missing"`),
  потом та же ошибка блокировки;
- `apply-config --dry-run` — `error: sh -c temporary=$1; target=$2; trap 'rm -f -- "$temporary"'
  EXIT; cat > "$temporary" && mv -f -- "$temporary" "$target"; status=$?; exit $status sh
  /srv/… failed (exit 2): sh: 1: cannot create …: Directory nonexistent` — внутренний
  скрипт публикации файла как сообщение оператору.

При этом `doctor`, `plan`, `status`, `mcp-creds` уже умеют сказать «never been bootstrapped —
`./clawforge bootstrap`». Единого предохранителя перед командами, которым нужен
bootstrap, нет.

Исправление: одна `requireBootstrapped(ctx)` (общая для `NotBootstrapped` из
`ctx.runtime`) до `takeLock()` в командах, которые не создают инстанс; ошибка
транспорта `sh -c …` в сообщение не попадает (команда — в `OC_DEBUG`, как у остальных).

### S5 (P2). `deploy` игнорирует `OC_REMOTE_PATH`

`commands/management/deploy.ts:167`: `parsed.path === undefined ? "/opt/openclaw" : …`.
`core/env.ts:252` читает `OC_REMOTE_PATH` в `settings.remotePath`, шаблон `.env` говорит:
«Where this repository lives on the target when deploying over SSH (./clawforge deploy)»,
`watch install` (`operate/watch/install.ts:82`) ставит cron в `settings.remotePath` и печатает
«set OC_REMOTE_PATH if --path differed». Итог: `OC_REMOTE_PATH=/srv/cf` в `.env` + `deploy
user@host` кладут файлы в `/opt/openclaw`, а cron на цели смотрит в `/srv/cf`. По коду.

Исправление: значение по умолчанию `--path` — `ctx.settings.remotePath`; проверка
«`--path` и `OC_REMOTE_PATH` различаются» в выводе deploy и в next-шагах.

## 3. Шероховатости

### S6 (P3). `check` не принимает аргументов

Воспроизведено: `./clawforge check --list` и `./clawforge check nonexistent-filter` запустили
весь набор (141 файл, минуты); никакого «unknown argument». Единственный способ прогнать одну
проверку — `node --experimental-strip-types tools/checks/<файл>` вручную. При прерывании
остаются временные развёртывания в реальном `apps/` (`apps/cli-help-check-97131cc3` и
`-8777e5c6` после моих двух прерванных запусков), которые затем видит `list` и которые
ломают автовыбор единственного развёртывания.

Исправление: `check [<подстрока>] [--list]` с отказом на неизвестное; временные
развёртывания — в `os.tmpdir()` или с очисткой при старте от осиротевших `*-check-*`.

### S7 (P3). Список инструментов MCP весит 88 КБ

Воспроизведено: `tools/list` — 42 инструмента, 88 010 байт; крупнейшие `watch` 7,5 КБ,
`recipe` 5,7, `backup` 4,7, `set` 4,5, `incident` 4,1. Это ≈22 тыс. токенов контекста агента
на каждую сессию до первого вызова. Описание = полный `--help` (документированное решение),
но агенту нужны первая строка и схема, остальное — по запросу.

Исправление: `description` = краткая строка + «`help <command>` — подробности»; отдельный
инструмент/ресурс `help` отдаёт полный текст; проверка бюджета размера `tools/list`.

### S8 (P3). Экспортированные `OC_*` молча игнорируются

Воспроизведено: `OC_WSL_DISTRO=Nope ./clawforge status` печатает `target: wsl:Ubuntu-24.04`;
так же `OC_TARGET_LOCATION=ssh OC_SSH_HOST=…`. `loadEnv()` (`core/env.ts:141`) читает только
`.env` развёртывания; из оболочки работает один `OC_APP`. Сообщение `restore` советует
«point OC_DATA_DIR … at directories you already own» — без слова, что это `.env`. Правило
осмысленно (воспроизводимость), но молчаливо.

Исправление: предупреждение «OC_X экспортирован, но `.env` его перекрывает/игнорируется»
или явный приоритет оболочки; строка в `docs/guide/`.

### S9 (P3). Мелкие несоответствия грамматики

- `./clawforge new-app a b` создаёт `a`, `b` не замечено (раунд 10 закрыл это для других
  команд, `new-app` — шлюзовая команда вне общего парсера).
- `./clawforge help help` → `unknown command: help / did you mean: help`.
- `./clawforge status` при двух развёртываниях без `--app`: первая строка
  `deployment "openclaw" not found` — имя, которого никто не просил; правда — во второй
  («available: a, r11-probe»).
- `watch|set|recipe|expose bogus` — `unknown action: bogus (expected …)` без «did you mean» и
  без `--help`-указателя, которые есть у неизвестных команд и опций.
- Без действия `recipe` печатает список, а `watch`, `set`, `expose` — usage-ошибка.

### S10 (P3). `.gitignore` развёртывания неполон

`new-app` пишет `.gitignore` с `.env`, `secrets/`, `.mcp.json`, `.codex/`; после `set build`
и `watch check` появляются `sets/<name>-<id>.tar.gz` (и `sets/.tries/`, `sets/receipts/`) и
`state/watch.json` — машинно-локальные, меняются каждым циклом. Сообщение `new-app` при этом
прямо советует `cd apps/<name> && git init`, а `lock`/`deployment.lock.json` предлагается
коммитить: `git add -A` утащит артефакты и состояние. По коду и по составу каталога.

### S11 (P3). Нечисловая ретенция молча выключает ротацию

`backup/index.ts:124` и `lifecycle/state.ts:200`: `Number.parseInt(env ?? "10", 10)`,
`if (!Number.isFinite(keep) || keep <= 0) return;`. `OC_BACKUP_KEEP=ten` или пустая строка
в `.env` → `NaN` → возврат без слова, архивы копятся. `health.ts:70` (watch) для такого же
случая NaN хотя бы возвращается к значению по умолчанию. Заодно: комментарий «`ls -1t` ordered the listing» рядом с
`find`+сортировкой (`backup/index.ts:170`) устарел.

Исправление: разбор через общую `parseRetention(name, raw)` — нечисло → предупреждение и
значение по умолчанию (или отказ), `0` — явное «не ротировать» с записью в отчёте.

## 4. Код и структура

### S12 (P3). История в комментариях и в тексте ошибки

- `commands/management/deploy.ts:275` — в **сообщении оператору** об отказе: «(audit
  2026-09-22, P1-03, the two failure directions P1-02 fixed for tar)». То же, что R12 раунда
  10, но в пользовательском тексте.
- `deploy.ts:34` «not part of this round»; `deploy.ts:210` — оборванная фраза «keep only
  where a `.filter(…)` sat».
- ~25 комментариев, пересказывающих прошлое поведение («used to», «no longer», «half a fix»):
  `apply.ts:354,438`, `plan.ts:395`, `config.ts:68`, `backup/index.ts:109,435`,
  `restore.ts:230,440`, `secrets.ts:115,376` и др. Их место — git log и CHANGELOG.
- 8 054 из 32 527 строк (25 %) — комментарии, при правиле «лаконично».

### S13 (P3). Функции-монолиты

По объёму верхнего уровня: `deploy()` — 360 строк (проверка политики, сканирование трёх
деревьев, связь, инструменты, маркер, две синхронизации, bootstrap); `observeLive` 235;
`restoreArchive` 225; `gatherInspection` 208; `verifySnapshot` 197; `runRecipeAction` 195;
`serveMcp` 191; `planActions` 175; `createBackupLocked` 158; `secrets()` 152. Лимит 700 строк
на файл это не ловит; в `deploy.ts` фазы уже названы комментариями и просятся в функции
(`assertDeployable`, `checkTarget`, `prepareRoot`, `syncTrees`).

### S14 (P3). Доки и зависимости

- `docs/guide/commands.md`, строка `recover-env`: `[--dry-run]`, а схема и `--help` знают
  `--adopt-runtime`. Таблица ведётся руками поверх деклараций — дрейф неизбежен.
- `OC_DEBUG=1` (полный argv и стек при сбое, необрезанный поток) не описан ни в одном
  документе.
- `@types/node` 22.19 при `engines: node >=24` и коде, опирающемся на Node 24: типы отстают
  от рантайма.

## 5. Что хорошо

- `control-mcp` ведёт себя по спецификации: неизвестный инструмент — `-32602`, лишний
  аргумент — `isError` с именем аргумента, деструктивное без `confirm` отказывает
  словом, `backup {action:"list"}` не требует `confirm`.
- Ошибки аргументов после раунда 10 последовательны: did-you-mean для команд и опций,
  `--app` после команды отвергается, `--tail abc` называет причину.
- `set validate`/`set build`, `lock --check`, `expose status`, `watch status` работают до
  bootstrap и честно говорят, что проверено.
- `recover-env`, `mcp-creds`, `upgrade` при отсутствии инстанса отказывают с причиной и
  следующим шагом, а не с трассой.
- Сканирование `deploy` до первого сетевого действия и режим «REFUSE, not exclude» —
  решение верное, менять нужно только подачу.

## 6. Порядок работ

1. S1, S2 — P2, транспорт: корректная декодировка и диагностика недоступной цели.
2. S3, S4 — P2, ответы команд без bootstrap и `apply --dry-run`.
3. S5 — P2, `deploy` и `OC_REMOTE_PATH`.
4. S6–S11 — грамматика, `check`, размер MCP, окружение, ретенция, `.gitignore`.
5. S12–S14 — гигиена, отдельными коммитами.
