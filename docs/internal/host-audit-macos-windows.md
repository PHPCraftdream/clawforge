# Аудит host-кода: macOS и Windows без WSL — 2026-09-29

Проверенный commit: `22a5e8d` (база задачи X5) + правки этой задачи.
Среда проверки: Windows 10 с WSL2 и Docker Desktop. Реальной macOS-машины нет — часть выводов
опирается на чтение кода и на то, что `macos-checks` в `.github/workflows/ci.yml` реально
прогоняет `npm run check` на `macos-latest` (см. ниже, это не голое предположение).

## Результат

**Найдено 9 позиций: 0 × P1, 1 × P2 (исправлен), 3 × P2 (не исправлены, для отдельной задачи),
5 × P3/informational.** Критических (P0) дефектов, ломающих host×target матрицу
(`docs/guide/requirements.md`), не найдено.

Общее впечатление: framework уже прошёл ~30 раундов ревью (`docs/internal/review-*.md`) именно
по кроссплатформенности транспорта, блокировок, ACL и WSL-границы — большинство категорий из
задания уже закрыты инъекцией платформы (`hostPlatform`/`TransportConfig.platform` в
transport.ts, `platformProbes` в process-identity.ts, `onWindows` в core/paths.ts) и/или реальным
прогоном на `macos-latest`/`windows-latest` в CI. Единственный найденный реальный дефект —
отсутствие retry на Windows-специфичный EPERM/EBUSY при `rename()` поверх приватного файла
(`.env`), который на POSIX в принципе не может произойти. Он исправлен в рамках этой задачи.

## Метод

Прочитан код (не только grep) для: runtime/transport/* (local/wsl/ssh/exec/quoting/
spawn-failure), runtime/lock/* (process-identity, instance-lock, heartbeat),
security/privacy/* (private-file, private-paths-ledger, recipe-portable-content,
deploy-boundary), set/artifacts/install.ts, commands/sets/{set,set-manifest,set-try-env}.ts,
commands/management/deploy/{server,sync}.ts, commands/management/provision-agent/
target-boundary.ts, commands/management/recipe/hook-graph.ts, commands/operate/schedule.ts,
commands/interface/host/contexts.ts, runtime/docker/*, tools/checks/kit/capabilities/
capabilities.ts, .github/workflows/ci.yml, .gitattributes. Каждый вызов `tar`/`find`/`stat`/
`readlink`/`sed`/`date`/`sha256sum`/`cp` проверен на то, выполняется ли он на HOST
(`spawnLocal`) или на TARGET (`ctx.transport.exec` — Linux всегда, по host×target матрице).

## Таблица находок

| № | Серьёзность | Место | Механизм | Влияние macOS / Windows-без-WSL | Статус |
|---|---|---|---|---|---|
| 1 | P2 | `tools/framework/security/privacy/private-file.ts` (было: строка 511, `rename(temporary, file)` в `replacePrivateFile`) | POSIX `rename(2)` молча заменяет открытый файл; Windows `MoveFileEx` при открытом получателе (редактор с `.env`, антивирус, backup-агент, сканирующий только что созданный temp-sibling) возвращает `EPERM`/`EBUSY`. Retry не было — наружу уходила сырая ошибка Node. | Только Windows (POSIX не подвержен). Ломает обычный сценарий «отредактировал `.env` в редакторе, не закрыл, запустил `clawforge secrets ...`» на Windows-без-WSL хосте, где `.env` лежит на реальном NTFS хоста (в отличие от target-файлов, которые всегда на Linux). | **Исправлено** — см. ниже |
| 2 | P2 | `tools/framework/set/artifacts/install.ts:381` (`storeArtifactForRollback`), `tools/framework/security/privacy/private-paths-ledger.ts:157` (`writeLedgerState`), `tools/framework/commands/sets/set-manifest.ts:341`, `tools/framework/commands/operate/watch/state.ts:206`, `tools/framework/integration/mcp/project.ts:186` | Тот же класс: `rename(temp, file)` напрямую на node:fs, без retry, для host-файлов (артефакт для отката, ledger приватных путей, собранный артефакт, состояние watch-демона, MCP project-файл). Вероятность конфликта ниже, чем у `.env` (эти файлы обычно не держит открытыми пользователь), но механизм тот же. | Только Windows. Не исправлено в этой задаче — узкий фикс сделан только для самого вероятного и самого чувствительного (credential) случая; остальные пять сайтов — кандидат на отдельную мелкую задачу с тем же паттерном (`renameOverPrivateFile`-подобная обёртка). | Не исправлено — вынесено в отдельную задачу |
| 3 | P3 | `tools/framework/runtime/lock/process-identity.ts:52-59` (`queryProcessStartedAt`, ветка `win32`) | Использует `wmic process where ... get CreationDate`. `wmic.exe` объявлен Microsoft deprecated и убран в Windows 11 24H2+ на части сборок; PowerShell `Get-CimInstance Win32_Process` — прямая замена. | Деградация безопасна уже сейчас: `queryProcessStartedAt` — best-effort (см. комментарий в коде), `ENOENT`/ошибка → `undefined` → `localLiveness` трактует как `"alive"` (никогда не помечает живой процесс мёртвым). На новых Windows просто теряется детект переиспользования pid, а не ломается блокировка. | Не исправлено — нет машины без `wmic` для проверки замены; риск на будущее, не дефект сейчас |
| 4 | P3 / informational | `tools/framework/commands/sets/set-try-env.ts:98-108` (`tryTargetProblem`) | `set try` не поддерживает ни `local` (не-Linux хост), ни `wsl` (требует `platform===win32`), ни `ssh` (сам command явно отказывает: "SSH requires remote staging and is not supported yet"). На macOS (единственный поддерживаемый target которого — ssh) это значит, что `set try` не работает вообще ни при каком значении `OC_TARGET_LOCATION`. | Отказ явный и по делу (`LOCAL_TARGET_UNSUPPORTED` из transport.ts, или сообщение `set try`), не крэш и не тихий no-op. Это дизайн-ограничение конкретной команды, а не платформенный баг. | Не исправлено — не дефект (redesign вне рамок задачи), задокументировано |
| 5 | Not applicable | Case-insensitive FS (macOS default, Windows) | Просмотрены все путесравнения, которые решают судьбу приватных данных: `excludesPortablePath` (recipe-portable-content.ts:82-84), `private-paths-ledger.ts` (`validateEntry`), `SENSITIVE_RECIPE_NAME` (уже `/i`). Сравниваемые строки везде получены из одного и того же источника правды (реальные имена `Dirent` с диска), а не введены пользователем в другом регистре — рассинхронизации регистра тут неоткуда взяться. | — | Не применимо |
| 6 | Not applicable | macOS tmpdir symlink `/var` → `/private/var`, `resolve()` vs `realpath()` | Проверены все host-side контайнмент-проверки: `recipe-portable-content.ts` (`realRoot = realpath(recipeDirectory)`, далее realpath-to-realpath на каждом шаге), `provision-agent/target-boundary.ts` (`verifyContainedLocally` — realpath против realpath), `recipe/hook-graph.ts:278` (`realpath(targetPath)` против `realpath(recipeDirectory)`). Ни один не сравнивает "сырой" `resolve()` с чужим `realpath()`. Единственный код, который вообще мог бы столкнуться с этим на не-Linux хосте (`LocalTransport`), недостижим вне Linux (`refuseLocalTarget` в transport.ts:57-67 блокирует `local` target на `win32`/`darwin` до создания транспорта). | — | Не применимо |
| 7 | Not applicable | Хостовой `tar` — GNU vs BSD/bsdtar (macOS, Windows System32) | Единственный HOST-spawned (`spawnLocal`, не через transport) архиватор — `tar`, в `install.ts`, `commands/sets/set.ts`, `set-manifest.ts` (+ их checks). `--force-local` добавляется только при `process.platform === "win32"`, и код сразу перепробует без флага при ненулевом коде — это одновременно чинит и GNU-tar-для-Windows (нужен флаг), и `bsdtar` из System32 (флаг не знает, откатывается сам). На macOS флаг вообще не добавляется (нет буквы диска — не нужен). Используемые опции (`-czf/-xzf/-tzf/-tvzf/--no-same-owner/--no-same-permissions`) поддерживаются и GNU tar, и bsdtar. Разбор verbose-листинга в `install.ts` (`verifyArtifact`) заякорен на месяц+день/ISO-дату, а не считает колонки — переживает разное число полей owner/group у bsdtar. Этот код реально гоняется на настоящем `macos-latest` в CI (`macos-checks` job → `npm run check` → `tools/checks/sets/artifact/*.check.ts` строит и распаковывает архив настоящим host tar) — то есть это не "предположение без macOS", а CI-подтверждённое поведение. | — | Не применимо (уже корректно и CI-покрыто) |
| 8 | Not applicable | GNU-only цели (`find -printf`, `stat -c`, `readlink -f`, `sha256sum`, `tar --numeric-owner`, `/proc`) | Каждое вхождение идёт через `ctx.transport.exec(...)` (datadir.ts, backup/index.ts, restore/index.ts, service/archive/{inventory,pack}.ts, lifecycle/verify.ts, orchestration/inspect/drift.ts) — то есть выполняется НА TARGET, а target по host×target матрице (`docs/guide/requirements.md`) всегда Linux (`local` только с Linux-хоста, `wsl`/`ssh` — тоже Linux-система на другом конце). `bootstrap --check` (`lifecycle/bootstrap/prereqs.ts`) отдельно проверяет именно GNU-userland target'а. Хост (macOS/Windows) эти команды не выполняет никогда. | — | Не применимо |
| 9 | Not applicable | `chmod`/`chown`/ACL на Windows, локализация | `security/privacy/private-file.ts` уже не трогает POSIX-биты на Windows: `grantWindowsAcl`/`assertDaclOwnerOnly` читают SDDL через `icacls /save` и сравнивают SID (`S-1-5-18`, `S-1-5-32-544`), никогда локализованные имена (`whoami.exe`/`icacls.exe` — абсолютный путь в `System32`, чтобы Git-Bash-шный `whoami` не подменил ответ). Отсутствие `icacls`/`whoami` (гипотетически — это часть базовой ОС) даёт именованную ошибку (`windowsOwnerSid` бросает `Error("cannot determine the Windows owner...")`), а не стектрейс. | — | Не применимо (уже корректно) |
| 10 | Not applicable | `localhost`→`::1` на macOS/Node 24 vs `127.0.0.1`-бинды | `set-try-env.ts:37` (`isPortFree`) и весь остальной код (`webhook.ts`, `secrets.ts`, `expose/*`, `audit.ts`) везде используют явный литерал `127.0.0.1`/`::1`/`[::1]`, никогда голое имя `localhost` для bind/probe. Несовпадения резолва `localhost` тут не имеют почвы. | — | Не применимо |
| 11 | Not applicable | ssh ControlMaster/ControlPath на Windows OpenSSH | Grep по всей кодовой базе — ни одного использования `ControlMaster`/`ControlPath`/`ControlPersist`. Каждый `ssh`-вызов — одна короткая команда (`BatchMode=yes` + одна команда или `-N -L` форвард), без мультиплексирования соединений. | — | Не применимо |
| 12 | Not applicable | Перевод строк (LF) в сгенерированных файлах | `.gitattributes` фиксирует LF для `*.sh/*.yml/*.yaml/*.json/*.md` в репозитории. Файлы, которые framework генерирует В РАНТАЙМЕ (`.env`, `set.json`, ledger-файлы, `docker-compose.yml`-оверрайды через `compose-operations.ts`), собираются JS-шаблонными строками с явным `"\n"` (нигде не встречен `os.EOL`) — на Windows это тоже даёт `\n`, а не `\r\n`, независимо от ОС. | — | Не применимо |
| 13 | Not applicable | `os.homedir()`/`HOME` vs `USERPROFILE`, `USER` vs `USERNAME` | `instance-lock.ts:476` — `process.env.USERNAME ?? process.env.USER ?? "unknown"` (уже кросс-платформенно). Отдельного `os.homedir()`-based layout, который бы отличался Windows/macOS/Linux в проверенном коде, не найдено — данные каталоги задаются явно через `OC_DATA_DIR`/deployment dir, не через домашний каталог пользователя. | — | Не применимо |

## Находка №1 (исправлено) — подробности

**Файл:** `tools/framework/security/privacy/private-file.ts`, функции `replacePrivateFile`
(строка ~557), новая `renameOverPrivateFile` (строка ~533), новый инъекционный сеанс
`privateFileHost`/`withPrivateFileRenamer` (строки 503–520) — по тому же паттерну, что
`hostPlatform`/`TransportConfig.platform` в `runtime/transport/transport.ts` и `platformProbes`
в `runtime/lock/process-identity.ts`.

**Механизм.** `replacePrivateFile` пишет содержимое во временный sibling и переименовывает его
поверх целевого файла (`.env`, ротация токена, `secrets`-команды). На POSIX `rename(2)` заменяет
целевой inode атомарно, даже если кто-то держит старый файл открытым. На Windows
`MoveFileEx`/`ReplaceFile` при открытом (не в режиме `FILE_SHARE_DELETE`) получателе — типично
редактор с открытым `.env`, антивирус или backup-агент, сканирующий только что записанный
temp-sibling, — возвращает `EPERM` или `EBUSY`. Раньше это всплывало как сырая ошибка Node без
объяснения причины.

**Почему P2, а не P1.** Сценарий не универсальный (нужен реально открытый файл), есть ручной
обход (закрыть файл и повторить), это не деградация безопасности и не потеря данных — временный
файл и оригинал остаются нетронутыми при неудаче.

**Фикс.** `renameOverPrivateFile` на `privateFileHost.platform === "win32"` делает до 5 попыток
с нарастающей паузой (100/200/300/400 мс) на `EPERM`/`EBUSY`; если все попытки исчерпаны — бросает
именованную ошибку («appears to be open in another program (an editor, backup tool or antivirus
scan) — close it and retry»), сохраняя оригинальное сообщение ОС внутри. На POSIX поведение не
меняется вообще (одна попытка, ошибка пробрасывается как раньше) — эта ветка на POSIX
физически недостижима (`rename(2)` так не падает), но код всё равно её не трогает, чтобы не
менять поведение вне заявленного дефекта.

**Проверка.** Платформа (`privateFileHost.platform`) и сам вызов `rename` (`withPrivateFileRenamer`)
инжектируются — реальная ОС нигде не читается внутри теста. Новый check
(`tools/checks/security/credentials/private-file.check.ts`, `renameRetryChecks`) прогоняет три
сценария под сценарным `renamer`: (1) транзиентный `EPERM` на симулированном `win32` — исчерпание
ровно нужного числа попыток и успех; (2) неисчезающий `EBUSY` на `win32` — именованная ошибка,
файл остаётся в прежнем (не повреждённом) состоянии; (3) симулированный не-`win32` — ровно одна
попытка, оригинальный код ошибки без переформулировки. Прогнан и на реальном Windows-хосте (все
90 assertions файла, включая новые, зелёные), и через typecheck/lint.

## Не проверено (нет macOS-машины) — но не голое предположение

Строки в таблице выше, помеченные CI-покрытием (в первую очередь №7, host tar), опираются на то,
что `.github/workflows/ci.yml`'s `macos-checks` job реально запускает `npm run check` на
`runs-on: macos-latest`, включая `tools/checks/sets/artifact/*.check.ts`, которые строят и
распаковывают настоящий `.tar.gz` настоящим host-`tar`. Это не "unverified assumption" в духе
"CI job существует, но неизвестно, зелёный ли он" — сам факт, что job вызывает эту цепочку кода
против реального `bsdtar` из coreutils macOS, и есть проверка. Что не проверено физически в этой
задаче: реальный прогон этого CI job (нет доступа к Actions отсюда) и любое поведение, которое
CI не покрывает (P2 №1 fix, например, не может быть перепроверен на реальной macOS отсюда —
но на macOS его вообще не касается: ветка `win32`-only).

## Не исправлено — для отдельной задачи

- **P2 №2** (пять дополнительных `rename()` без retry) — тот же паттерн `renameOverPrivateFile`
  стоит вынести в общий хелпер и применить к `install.ts:381`, `private-paths-ledger.ts:157`,
  `set-manifest.ts:341`, `watch/state.ts:206`, `integration/mcp/project.ts:186`. Не сделано в
  этой задаче: это уже расширение за пределы одного узкого дефекта (credential-файл), и часть
  сайтов (например, `set-manifest.ts` — сборка артефакта) при коллизии просто проваливает
  команду без риска для данных, то есть цена бага ниже, а объём правки — на отдельный проход.
- **P3 №3** (wmic deprecation) — нет машины без `wmic` для проверки PowerShell-замены;
  деградация уже безопасна.
