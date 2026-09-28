# Ревью ClawForge — XS, раунд 4, 2026-09-23

## Результат и проверенный снимок

**13 находок: 5 × P1, 6 × P2, 2 × P3. Подтверждённых P0 нет.**

P0 — критическая авария без приемлемого ограничения; P1 — исправить до релиза;
P2 — существенный дефект поддерживаемого сценария или пробел гарантии; P3 — недостаток
поддерживаемости, диагностики либо защиты цепочки разработки. Приоритет учитывает условия
срабатывания: потенциально тяжёлый эффект, требующий явной локальной конфигурации или
операторского действия, отнесён к P1, а не автоматически к P0.

База отдельного worktree: `ada7d3aec88f52099a7a91b288ba637116bd4aa9`. В него перенесён
текущий снимок незакоммиченных исправлений основного checkout: 57 изменённых и 22 новых
source/test-пути. Продуктовый код и штатные тесты в ходе аудита не редактировались. В
отчётный коммит входит только этот документ.

Контрольная сумма проверенного исходного снимка без этого отчёта:
`70a624d71dae365dcf6adb5ac5d5489a600eda07dd2e359730d63794d3cba904`.
Для 246 файлов из `git ls-files --cached --others --exclude-standard` пути отсортированы;
SHA-256 получает последовательно UTF-8 путь, нулевой байт и бинарный SHA-256 содержимого.
Игнорируемые зависимости и `tools/framework/dist` исключены.

**Ссылки на строки относятся к этому снимку, а не к чистому базовому коммиту.** Новые
исходники, на которые ссылается отчёт, должны войти в соответствующий коммит исправлений.

Релиз без оговорок этот раунд не подтверждает. Главные причины: опасный корень данных может
привести к рекурсивной смене владельца системного дерева; `smoke` восстанавливает snapshot
поверх живого экземпляра; prompt-часть agent bundle обходит общую portable-content policy;
валидатор архива не вычисляет цепочки ссылок; deploy проверяет не всё дерево, которое затем
отправляет.

## Метод и границы

Прочитаны три предыдущих XA-отчёта, весь diff снимка и критические цепочки environment/data
layout, private paths/history, archive/backup/pull/verify/restore, smoke, recipe lifecycle,
portable content, set build/install/rollback, ownership, instance locks, deploy, MCP,
host contexts, inspect/apply/recovery и CI. Анализ выполнен по потокам данных, состояниям до
и после ошибок и границам прав. Существующие проверки запускались как единый штатный набор.

Для P1-04 дополнительно вызвана только чистая функция `inspectArchive()` над синтетическим
списком имён и ссылок. Архив не создавался и не распаковывался. Для остальных находок
исполняемые reproducer-сценарии не создавались: выводы подтверждены достижимыми ветками кода
и уже существующими тестами, включая тест, который прямо закрепляет удаление target-копии
privacy history при пустом локальном ledger.

Рабочее приложение, live deployment, его конфигурация и секреты не читались и не менялись.
Не выполнялись рабочие backup/restore, SSH deploy, эксплуатационные payload, ручной запуск
host engine или нагрузочные проверки. Штатный `npm test` сам использовал ограниченные WSL и
Docker fixtures, предусмотренные репозиторием; они не обращались к рабочему deployment.
Удалённый GitHub Actions run не запускался. Проверка advisories ограничена текущим lockfile и
ответом `npm audit --omit=dev` на дату аудита.

## Статус прежних P1/P2

### Первый XA-аудит

| Находка | Состояние текущего снимка |
| --- | --- |
| P1-01: повреждённый recipe manifest отключает privacy policy | **Исправлено.** Security reader строго читает существующие manifests и останавливается на ошибке. |
| P1-02: `privatePaths` становился glob в tar | **Исправлено.** Объявленные пути экранируются как буквальные, проверки с квадратными скобками проходят. |
| P2-01: private helper пропускал `..` | **Исправлено.** Путь нормализуется, проверяются сырые prefixes и symlink ancestors, запись идёт в проверенную цель. |
| P2-02: restart не применял repo-env | **Исправлено.** Repo-env delivery пересоздаёт контейнер и сверяет environment. |
| P2-03: recipe hooks обходили instance lock | **Исправлено для действий.** Mutating actions используют общий lock. Конкурентный takeover остаётся P2-03 этого раунда. |
| P2-04: `host engine` мог неявно прийти как root | **Частично исправлено.** Docker Desktop engine требует двойного согласия. Уже-root `local` и `target` по-прежнему не определяются как `arrivesAsRoot`; универсальная гарантия effective UID отсутствует. |
| P2-05: `apply-config --dump --dry-run` писал декларацию | **Исправлено.** Несовместимые флаги отклоняются до записи. |

### XA, раунд 2

| Находка | Состояние текущего снимка |
| --- | --- |
| P1-01: restore действует через внешние ссылки | **Частично исправлено.** Root/mandatory layout проверяются с согласованными правами. Составные link chains не вычисляются: P1-04 ниже. |
| P1-02: исчезновение декларации снимало защиту runtime-файлов | **Частично исправлено.** Локальный ledger сохраняет историю, full backup переносит её. Пустой новый ledger может удалить единственную target-копию: P2-01 ниже. |
| P1-03: `privateFiles` не ограничивал build/mirror/deploy | **Частично исправлено.** Общий walker обслуживает served content, set и обычный mirror. Agent prompts обходят его, а framework checkout deploy проверяется другим списком: P1-03/P1-05 ниже. |
| P2-01: helper проверял один путь, писал в другой | **Исправлено.** Запись использует нормализованный проверенный target. |
| P2-02: symlink data root давал пустой успешный backup | **Исправлено.** Корневая ссылка отклоняется до pause и в архиваторе; staging проверяется на содержимое. |
| P2-03: apply продолжал со старым Context | **Исправлено.** Context обновляется после env/secrets, смена target coordinates останавливает run. |
| P2-04: sidecar state не согласован с backup/restore | **Открыто как ограничение.** Добавлены предупреждения, но quiesce/rebind lifecycle участников нет; смежная готовность install — P2-04 ниже. |
| P2-05: private paths сравнивались как неограниченные prefixes | **Исправлено.** Сопоставление идёт по границе компонента. |
| P2-06: файловые security regressions пропускались в Linux | **Исправлено для выбора transport.** POSIX группы исполняются на Linux. Windows/WSL CI отсутствует: P3-02 ниже. |

### XA, раунд 3

| Находка | Состояние текущего снимка |
| --- | --- |
| P1-01: внутренняя ссылка переносила приватные байты под alias | **Исправлено в общем walker.** Проверяется логическое и resolved имя, loop/outside links отклоняются. Отдельный prompt loader walker не использует: P1-03 ниже. |
| P1-02: privacy history не восстанавливалась с данными | **Исправлен штатный full backup/restore.** History публикуется и импортируется до действий. Неопределённость пустого локального ledger остаётся P2-01. |
| P1-03: deploy пропускал sensitive names | **Исправлено для recipes и deployment config.** Полный framework checkout синхронизируется отдельно и не проходит ту же проверку: P1-05. |
| P1-04: restore проверял layout меньшими правами | **Исправлено.** Проверка использует тот же privilege prefix и различает отсутствие от невозможности проверить. |
| P2-01: ledger расширял privacy до общего родителя | **Исправлено.** Записываются точная цель и реально объявленная boundary. |
| P2-02: параллельные private writes теряли ledger entries | **Исправлено внутри процесса.** Read/merge/write сериализован по ledger path. |
| P2-03: apply отменял намеренную правку `.env` | **Исправлено.** Diverged facts advisory; runtime принимается только с явным `--adopt-runtime`. |
| P2-04: MCP держал старый recipe hook | **Частично исправлено.** Главный hook versioned по checksum, но его относительные imports остаются в ESM cache: P2-06 ниже. |
| P2-05: успешный MCP output обходил redaction | **Исправлено.** Text и structured result маскируются независимо от exit status; раскрытие требует `exportsSecrets`. |
| P2-06: egress probe не имел общего deadline | **Исправлено.** Deadline покрывает DNS/body, transport exec имеет внешний timeout. |

## P1-01 — Опасный `OC_DATA_DIR` превращает bootstrap в рекурсивный `chown` системного дерева

**Evidence:** [env.ts:127](../tools/framework/core/env.ts#L127),
[datadir.ts:75](../tools/framework/runtime/datadir.ts#L75),
[datadir.ts:92](../tools/framework/runtime/datadir.ts#L92),
[bootstrap.ts:64](../tools/framework/commands/lifecycle/bootstrap.ts#L64).

`toSettings()` требует только непустой `OC_DATA_DIR`. Абсолютность, нормализация, минимальная
глубина и запрет `/` не проверяются. `bootstrap` перед любыми контейнерами вызывает
`ensureDataDirs()`. Если владелец data root или одного из подкаталогов отличается от
`1000:1000`, функция выполняет `chown -R 1000:1000 <dataDir>` с `sudo -n`, когда обычных прав
не хватает.

При `OC_DATA_DIR=/` путь достижим буквально как `chown -R 1000:1000 /`. Значения вроде
`/srv` могут аналогично захватить соседние приложения. Это не удалённое повышение
привилегий: оператор должен сохранить опасную конфигурацию, а target — разрешить
passwordless sudo. Но единичная ошибка в центральной настройке способна повредить права
всего host, поэтому дефект блокирует релиз.

**Безопасная проверка:** только статически прослежены `toSettings → bootstrap →
ensureDataDirs → runMaybePrivileged`; команд изменения прав не выполнялось.

**Рекомендация:** централизованно валидировать все destructive roots до создания `Context`:
требовать нормализованный абсолютный target path, отклонять `/`, пустое basename и
системные/слишком широкие корни. Рекурсивный `chown` разрешать только для каталога с
deployment marker либо только что созданного framework. Стандартные подкаталоги менять
точечно, не наследовать необходимость одного пути на весь root. Добавить регрессии `/`,
`/srv`, trailing slash, `.`/`..` и symlink root без настоящего `chown`.

## P1-02 — `smoke` восстанавливает snapshot поверх живого экземпляра и может откатить новые записи

**Evidence:** [smoke.ts:181](../tools/framework/commands/lifecycle/smoke.ts#L181),
[smoke.ts:192](../tools/framework/commands/lifecycle/smoke.ts#L192),
[smoke.ts:277](../tools/framework/commands/lifecycle/smoke.ts#L277),
[state.ts:265](../tools/framework/commands/lifecycle/state.ts#L265),
[state.ts:421](../tools/framework/commands/lifecycle/state.ts#L421),
[backup.ts:196](../tools/framework/commands/lifecycle/backup.ts#L196).

Round-trip check пишет marker в реальный workspace, делает `pull`, удаляет marker и вызывает
`push --force`. `pull` и `push` берут instance lock каждый для своей короткой операции, но
весь smoke run одним lock не охвачен. После backup gateway снова запускается и остаётся
живым до последующего restore. Любая запись агента, cron job или другого framework run в
этом окне отсутствует в snapshot и теряется при `push`, который заменяет весь data root.
Предыдущая копия остаётся в `.replaced-*`, но автоматически не возвращается и обычный
пользователь `smoke` не ожидает восстановления production state поверх себя.

Дополнительно marker удаляется не в `finally`: ошибка pull/checksum/push может оставить
SMOKE-MARKER либо экземпляр в промежуточном состоянии. Отдельные внутренние locks не делают
составную проверку транзакцией.

**Безопасная проверка:** сопоставлены границы locks и последовательность восьми штатных
checks; smoke против live deployment не запускался.

**Рекомендация:** проверять restore round-trip в отдельном временном root/throwaway instance
или распаковывать snapshot в staging и сравнивать байты без замены live data. Если live
restore остаётся, один outer lock и одна пауза должны покрывать snapshot → проверку → возврат,
а cleanup marker/state обязан быть в `finally`. Явно отделить destructive disaster-recovery
test от обычного `smoke`.

## P1-03 — Agent prompt loader обходит общую portable-content policy

**Evidence:** [declaration.ts:83](../tools/framework/commands/management/provision-agent/declaration.ts#L83),
[declaration.ts:104](../tools/framework/commands/management/provision-agent/declaration.ts#L104),
[reconcile.ts:117](../tools/framework/commands/management/provision-agent/reconcile.ts#L117),
[checksums.ts:50](../tools/framework/service/checksums.ts#L50),
[recipe-portable-content.ts:107](../tools/framework/security/recipe-portable-content.ts#L107).

Set inventory и `agentBundleChecksums()` проходят общий walker: `privateFiles`, sensitive
names, resolved targets и escaping symlinks исключаются или отклоняются. Но реальное
`provision-agent` загружает bundle другим путём: обычный `readdir(agentDir)` и `readFile()`
для каждого `*.md`, отдельный прямой read `cron-message.txt`. Затем эти байты без повторной
policy-проверки пишутся в agent workspace.

Поэтому `privateFiles: ["agent/private.md"]` исключает файл из set manifest/checksum, но
прямой working-tree provision всё равно копирует его. Ссылка с публичным `.md`-именем также
читается `readFile()` с переходом за recipe root. Workspace входит в разрешённый share
профиль, так что credential/instruction bytes могут попасть не только на target, но и в
последующий share snapshot. Аналогичное расхождение касается cron message.

**Безопасная проверка:** статически сопоставлены два inventories; приватный файл и ссылка
не создавались, provisioning не запускался.

**Рекомендация:** `loadRecipeAgentBundle()` должен получать список prompt/config/cron файлов
из того же canonical walker и отказывать, если обязательный файл исключён политикой.
Проверять resolved containment до любого `readFile`. Один regression должен доказать
одинаковое решение build, direct provision, inspect и set apply для private/sensitive file,
внутреннего alias и escaping link.

## P1-04 — Проверка архива не вычисляет составные цепочки ссылок

**Evidence:** [archive.ts:214](../tools/framework/service/archive.ts#L214),
[archive.ts:256](../tools/framework/service/archive.ts#L256),
[archive.ts:277](../tools/framework/service/archive.ts#L277),
[restore.ts:217](../tools/framework/commands/lifecycle/restore.ts#L217).

`inspectArchive()` оценивает каждую ссылку отдельно. Для внешнего symlink она ищет только
архивную запись с прямым prefix `${source}/`. Она не разрешает link graph: безопасная на вид
`data/a -> b` может привести к `data/b -> ../../outside`, а запись `data/a/file` проходит
через обе. Первая ссылка отдельно не выходит из root; у второй нет прямой записи
`data/b/...`, поэтому она остаётся нефатальным предупреждением.

Чистый вызов текущей функции над этим списком вернул:

```json
[{"message":"link points outside the archive: data/b -> ../../outside","fatal":false}]
```

Restore распаковывает после отсутствия fatal findings. Post-extract validator проверяет
только стандартные layout paths и уже не может отменить запись, которую tar сделал при
распаковке. Та же проблема возможна при комбинации hard link и symlink. Фактическая запись
за root зависит от поведения конкретного tar, но security gate уже доказанно классифицирует
составной путь как безопасный для unpack, не вычислив его назначение.

**Безопасная проверка:** исполнена только чистая функция над строками; tar и файловая система
не использовались.

**Рекомендация:** построить нормализованный граф ссылок и разрешать каждый archive member
через все ancestors до обычного path либо цикла/выхода. Альтернатива для restore — запрещать
все links в принимаемом backup format и явно мигрировать допустимые runtime links. Добавить
unit-регрессии для двух symlinks, hardlink→symlink, циклов и `./` prefixes, затем безопасный
end-to-end fixture в temp root.

## P1-05 — Deploy проверяет recipes/config, но отправляет непроверенный framework checkout

**Evidence:** [deploy.ts:41](../tools/framework/commands/management/deploy.ts#L41),
[deploy.ts:172](../tools/framework/commands/management/deploy.ts#L172),
[deploy.ts:193](../tools/framework/commands/management/deploy.ts#L193),
[deploy.ts:297](../tools/framework/commands/management/deploy.ts#L297),
[recipe-portable-content.ts:54](../tools/framework/security/recipe-portable-content.ts#L54).

Исправление прошлого раунда сканирует каждый recipe и deployment `config/` общей
portable-content policy. Но первая rsync-операция отправляет весь checkout root. Он не
проходит walker; его `EXCLUDES` — отдельный список с `.env`, `secrets/`, `*.token`, но без
`.env.*` и `*.secrets.env`, которые общий `SENSITIVE_RECIPE_NAME` считает приватными.

Следовательно, случайный `tools/local/.env.production` или `notes/service.secrets.env`
вне исключённых `apps/`/`secrets/` отправляется на remote host, хотя то же имя под recipe или
deployment config останавливает deploy до соединения. Git ignore не помогает rsync и
untracked local files тоже входят в source tree.

**Безопасная проверка:** статически сопоставлены regex, `EXCLUDES`, области preflight scans и
source первого rsync. SSH/rsync не выполнялись.

**Рекомендация:** формировать framework delivery из tracked/проверенного inventory либо
прогонять всё отправляемое дерево через общую generic sensitive policy до первого remote
действия. Один table-driven тест должен размещать каждое sensitive-name имя в recipe,
deployment config и произвольном checkout subtree и требовать одинакового отказа.

## P2-01 — Пустой локальный ledger удаляет target-копию privacy history

**Evidence:** [private-paths-ledger.ts:175](../tools/framework/security/private-paths-ledger.ts#L175),
[private-paths-ledger.ts:181](../tools/framework/security/private-paths-ledger.ts#L181),
[archive.ts:410](../tools/framework/service/archive.ts#L410),
[private-history-restore.check.ts:1](../tools/checks/runtime/private-history-restore.check.ts#L1).

Перед full backup `publishPrivatePathsHistory()` считает deployment-side ledger главным.
Если он пуст, существующий `<data>/config/clawforge-private-paths.json` удаляется. Это нужно
для explicit forget, но пустота не различает два состояния: «история намеренно забыта» и
«deployment folder/ledger потерян, новый оператор подключился к существующему target».

Во втором состоянии target-копия может быть единственным сохранившимся описанием приватных
runtime paths. Первый full backup новой deployment-папки удалит её до tar и запишет backup
без истории. Существующая штатная проверка прямо утверждает текущее поведение: `an empty
ledger removes a stale copy instead of publishing nothing`.

**Impact:** последующее удаление recipe declaration или перенос данных лишает migrate/share
exclusions сведений о ранее приватных файлах. Это снова открывает класс утечки, который
round 2/3 ledger должен был закрыть, но требует потери или смены operator-side metadata.

**Рекомендация:** ввести явное состояние ledger (`initialized`/generation/id) и отдельную
операцию forget, которая атомарно обновляет обе копии. При пустом/отсутствующем локальном
ledger и существующей валидной target history импортировать/объединять её либо останавливать
backup с инструкцией, а не удалять. Проверить adopt-existing-target и lost-deployment-folder.

## P2-02 — Rollback неудачного restore не охватывает все изменённые состояния

**Evidence:** [restore.ts:245](../tools/framework/commands/lifecycle/restore.ts#L245),
[restore.ts:254](../tools/framework/commands/lifecycle/restore.ts#L254),
[restore.ts:265](../tools/framework/commands/lifecycle/restore.ts#L265),
[restore.ts:281](../tools/framework/commands/lifecycle/restore.ts#L281),
[private-paths-ledger.ts:201](../tools/framework/security/private-paths-ledger.ts#L201).

Ошибка после extraction обрабатывается только когда существовал старый `dataDir` и был
заполнен `aside`. На чистом target `aside === undefined`, поэтому неполностью распакованный
или уже отклонённый data root остаётся на месте. Следующий bootstrap/restore видит его как
существующее состояние.

Кроме того, privacy history импортируется в operator-side ledger до fresh-identity и
`ensureDataDirs`. Если любой последующий шаг падает, data tree возвращается из `aside`, но
добавленные ledger entries не откатываются. Старый instance после неудачного restore получает
policy boundaries из непринятого архива: migrate/share может необоснованно терять публичные
данные, а private helper — считать чужую boundary разрешённой.

**Безопасная проверка:** прослежены ветки catch и расположение import; failure injection в
restore не добавлялся.

**Рекомендация:** сделать restore transaction явной: всегда удалять принадлежащий операции
staging/new root при отказе, независимо от наличия `aside`; импортировать ledger после всех
проверок через staged commit либо сохранять его прежние байты и восстанавливать в catch.
Добавить две регрессии: failed first restore и failure после успешного history import.

## P2-03 — Два одновременных `--break-lock` оба входят в критическую секцию

**Evidence:** [instance-lock.ts:228](../tools/framework/runtime/instance-lock.ts#L228),
[instance-lock.ts:247](../tools/framework/runtime/instance-lock.ts#L247),
[instance-lock.ts:263](../tools/framework/runtime/instance-lock.ts#L263),
[instance-lock.ts:289](../tools/framework/runtime/instance-lock.ts#L289).

Обычный lock атомарен благодаря `mkdir`. Takeover атомарного claim не делает: каждый caller,
увидев существующую директорию и `breakLock: true`, переходит к записи своего `holder.json`
в ту же директорию. Два запуска могут одновременно прочитать старого holder, оба удалить
его marker, по очереди записать новый holder и оба вернуть успешный `HeldLock`. Последний
только меняет имя владельца; первый уже выполняет body без дальнейшей проверки lease.

Существующие regressions проверяют один takeover и поздний release прежнего holder, но не
два конкурентных takeover. Требуется явное двойное согласие, поэтому это не обычный race,
однако stale-lock recovery двух автоматизированных клиентов снова нарушает основную
гарантию «один instance — одно изменение».

**Рекомендация:** takeover должен атомарно переименовать/удалить старую директорию и заново
выиграть обычный `mkdir`, либо создать уникальный claim через compare-and-swap marker и
подтвердить владение перед body. Добавить interleaving regression с двумя break callers,
где body входит ровно у одного.

## P2-04 — Recipe install сообщает `running` без доказательства готовности stack

**Evidence:** [recipe.ts:296](../tools/framework/commands/management/recipe.ts#L296),
[recipe.ts:319](../tools/framework/commands/management/recipe.ts#L319),
[recipe.ts:321](../tools/framework/commands/management/recipe.ts#L321),
[runtime-docker.ts:522](../tools/framework/runtime/runtime-docker.ts#L522),
[runtime-docker.ts:529](../tools/framework/runtime/runtime-docker.ts#L529).

После `compose up --detach` install немедленно вызывает `afterStart` и печатает
`<name> is running`. Нет `--wait`, health contract или даже проверки, что контейнеры не
успели завершиться. `Stack.isRunning()` отвечает true, если `docker ps` нашёл любой контейнер
с project label; для multi-service recipe один живой вспомогательный контейнер маскирует
падение основного. `afterStart` может выполняться до готовности приложения и попадать в
гонку с его поздними записями.

**Impact:** CLI/MCP возвращает успешную установку, хотя stack не готов или частично мёртв;
post-start конфигурация/проверка становится flaky. Backup/restore warnings также считают
такой project работающим по неполному признаку.

**Рекомендация:** добавить generic recipe readiness declaration: список обязательных
services и/или health/command probe с timeout. Compose backend должен поддерживать
`up --wait` там, где healthchecks объявлены, и сверять состояние всех обязательных services.
`afterStart` запускать после readiness, а результат install делать structured и честным.

## P2-05 — Ошибки control ledgers сворачиваются в «ничего не установлено/не принадлежит нам»

**Evidence:** [install.ts:74](../tools/framework/set/artifacts/install.ts#L74),
[install.ts:93](../tools/framework/set/artifacts/install.ts#L93),
[install.ts:107](../tools/framework/set/artifacts/install.ts#L107),
[ledger.ts:59](../tools/framework/set/ownership/ledger.ts#L59),
[ledger.ts:81](../tools/framework/set/ownership/ledger.ts#L81),
[ledger.ts:116](../tools/framework/set/ownership/ledger.ts#L116).

Unreadable/corrupt `clawforge-installed-set.json` возвращает `undefined`, а unreadable/
malformed ownership ledger — пустой объект. Направление безопасно от немедленного удаления
чужого объекта, но последующие записи считают историю отсутствующей. Новый set marker
перезаписывает текущий без `previous`, теряя rollback chain. Следующий `recordOwned()`
переписывает malformed ledger единственной новой записью, окончательно теряя доказанное
владение остальными объектами.

Штатные тесты закрепляют это как желаемое (`an unreadable record reads as none`, `a corrupt
ledger reads as empty`). Такое fail-soft поведение подходит информационному UI, но не
операциям, которые после чтения перезаписывают control state.

**Рекомендация:** разделить tolerant observation и strict mutation readers. Inspect может
возвращать `unknown/corrupt`; record/install/rollback должны останавливаться, сохраняя байты,
и предлагать explicit repair/import. Записывать markers атомарно и хранить предыдущую
валидную версию.

## P2-06 — Обновление зависимостей recipe hook остаётся невидимым долгоживущему MCP

**Evidence:** [recipe.ts:81](../tools/framework/commands/management/recipe.ts#L81),
[recipe.ts:92](../tools/framework/commands/management/recipe.ts#L92),
[recipe.ts:100](../tools/framework/commands/management/recipe.ts#L100),
[recipe.ts:104](../tools/framework/commands/management/recipe.ts#L104).

Main hook теперь перечитывается и versioned query строится по его checksum. Но относительные
imports из него сохраняют обычные URL и остаются в process-wide ESM cache. Изменение
`shared.ts`, `config.ts` или другого поддерживаемого helper без изменения самого
`prepare.ts`/`verify.ts` продолжает исполнять старый модуль до перезапуска MCP. Код прямо
документирует ограничение и предлагает self-contained hook, однако многофайловой рецепт —
обычная форма поддерживаемого, читаемого кода.

**Impact:** CLI и уже открытая MCP-сессия дают разные результаты после правки; агент может
проверить или переустановить сервис старой логикой и решить, что изменение применено.

**Рекомендация:** исполнять hook graph в короткоживущем worker/process либо versioned loader,
который включает content identity всего локального dependency graph. Как минимум checksum
должен включать разрешённые относительные imports, а изменение любого из них — создавать
новый isolated module context. Регрессия должна менять только imported helper между двумя
вызовами одного MCP process.

## P3-01 — `recipe.json` принимает значения, которые позже ломают каталог и команды

**Evidence:** [recipe.ts:96](../tools/framework/service/recipe.ts#L96),
[recipe.ts:142](../tools/framework/service/recipe.ts#L142),
[recipe.ts:152](../tools/framework/service/recipe.ts#L152),
[recipe.ts:153](../tools/framework/service/recipe.ts#L153),
[management/recipe.ts:46](../tools/framework/commands/management/recipe.ts#L46).

Loader валидирует верхний объект, description и private paths, но `ports` принимает любую
array через type cast, `variables` — любой object, включая array и значения не-string.
`recipe list` затем без проверки обращается к `port.host`/`port.container`; один `null` в
array ломает весь каталог, хотя `listRecipes()` обещает изолировать broken manifest.
Некорректные variables превращаются в неожиданные имена/сообщения во время install.

**Рекомендация:** полностью проверять runtime shape: finite integer ports в диапазоне,
string descriptions, plain-object variables со string values, booleans/reasons и отсутствие
неизвестных конфликтующих полей. Ошибка одного manifest должна быть видимой записью каталога,
не исключением во время render. Добавить negative table tests.

## P3-02 — CI не проверяет заявленную Windows/WSL поверхность и доверяет плавающим Action tags

**Evidence:** [ci.yml:10](../.github/workflows/ci.yml#L10),
[ci.yml:13](../.github/workflows/ci.yml#L13),
[ci.yml:19](../.github/workflows/ci.yml#L19),
[ci.yml:22](../.github/workflows/ci.yml#L22).

Единственный job работает на `ubuntu-latest`. Значительная часть продукта — Windows ACL,
`wsl.exe`, UTF-16 distro listing, drive/path bridge и Docker Desktop engine context — в
удалённом CI не исполняется. Локальный Windows прогон этого раунда зелёный, но он не является
release gate. Дополнительно `actions/checkout@v4` и `actions/setup-node@v4` закреплены
изменяемыми major tags, а workflow имеет доступ к исходникам каждого push/PR.

**Рекомендация:** добавить Windows Node 24 job хотя бы для unit/typecheck/build и выделить
доступные без Docker WSL/ACL проверки. Linux integration оставить отдельным job. Закрепить
third-party Actions полными commit SHA с комментарием версии и включить автоматическое
обновление этих SHA.

## Выполненные проверки

| Проверка | Результат |
| --- | --- |
| Node | `v24.12.0` |
| `npm ci --ignore-scripts --no-audit --no-fund` | Успешно, lockfile установлен без lifecycle scripts |
| `npm test` с доступным штатным WSL transport | **96 check-файлов прошли** |
| `npm run format:check` | tsgo и Oxlint прошли |
| `npm run build` | **90 source-файлов** собрано |
| `npm run pack:check` | Успешно, **189 package entries** |
| `actionlint` | Успешно |
| `npm audit --omit=dev --json` | 0 известных production vulnerabilities |
| Pure link-chain check | `inspectArchive()` вернул только нефатальное предупреждение для составного выхода |

Зелёный набор показывает отсутствие пойманной регрессии, но не опровергает находки: в
частности, тесты сами закрепляют удаление target history при пустом ledger и fail-soft
чтение control markers; отсутствуют regressions для опасного data root, составного lock
takeover, prompt-policy parity, link graph и whole-smoke transaction.

## Порядок исправления

Сначала поставить hard guard на destructive roots (P1-01) и убрать live restore из обычного
smoke (P1-02). Затем свести все readers переносимого recipe content к одному inventory
(P1-03/P1-05) и закрыть link graph до любой распаковки (P1-04). После этого сделать restore
и privacy history транзакционными (P2-01/P2-02), атомарным takeover lock (P2-03), добавить
generic readiness stack (P2-04) и strict readers для control state (P2-05). Freshness должен
охватывать весь hook graph (P2-06), иначе поддерживаемое разбиение рецептов на небольшие
модули остаётся ненадёжным. Завершить строгой схемой recipe manifest и Windows/supply-chain
CI gate.
