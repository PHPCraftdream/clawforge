# ClawForge — статическое ревью XS, раунд 19

Дата: 2026-09-30. Проверенная база: `main` @ `2fc8646`, после исправлений раунда 18. Метод — чтение исходников, документации, существующих checks и локальной истории. Приложение, сервисы, контейнеры, тесты, сборки, линтеры, форматтеры, smoke и нагрузка **не запускались**. Действующие секреты и содержимое пользовательских deployment не читались. Единственное изменение этого раунда — этот отчёт; коммит содержит только его.

Сверены отчёты XS/XXS раундов 10–18, сессионные статусы и доступные более ранние отчёты, в том числе внутренние usability-ревью. Переданные результаты проверок раунда 18 приняты как имеющееся evidence, а не перепроверены. Credential URL redaction и сериализация/drain heartbeat в текущих исходниках учтены; закрытые механизмы не заявляются повторно.

Шкала: **P0** — безусловный критический ущерб; **P1** — утечка секретов или потеря данных в поддерживаемом сценарии; **P2** — существенное нарушение поддерживаемого поведения; **P3** — меньший эксплуатационный дефект. Новые подтверждаемые статически находки: **P0 — 0, P1 — 0, P2 — 5, P3 — 1**. Это доказательство описанных путей исполнения и допустимых interleavings, не результат динамического воспроизведения.

## Сводка

| ID | Приоритет | Нарушенный consumer workflow |
| --- | --- | --- |
| R19-01 | P2 | `upgrade`: post-upgrade doctor запускается из прежнего image |
| R19-02 | P2 | `upgrade`: исключение после начала recreation обходит автоматический rollback |
| R19-03 | P2 | `lock`: отказ инвентаризации plugins/skills сохраняется как доказанное отсутствие |
| R19-04 | P2 | SSH `watch install`/`status`: расписание и наблюдаемый state находятся на разных машинах |
| R19-05 | P2 | Документированный `afterBackup`: offsite-копия gzip проходит через UTF-8 и портится |
| R19-06 | P3 | Конкурентные `watch check`: один неизменный outage отправляет два transition-alert |

## Подтверждённые находки

### R19-01 / P2 — `upgrade` проверяет новый gateway CLI-кодом прежнего image

**Код:** [lifecycle.ts:471–474](../tools/framework/commands/lifecycle/lifecycle.ts#L471), [:543–556](../tools/framework/commands/lifecycle/lifecycle.ts#L543); [compose-operations.ts:259–289](../tools/framework/runtime/docker/compose-operations.ts#L259); [runtime-docker.ts:62–66](../tools/framework/runtime/docker/runtime-docker.ts#L62), [:119–125](../tools/framework/runtime/docker/runtime-docker.ts#L119); [docker-compose.yml:64–80](../tools/framework/docker-compose.yml#L64). Контракт: [data-and-backups.md:271–279](guide/data-and-backups.md#L271).

**Механизм:** `recreateWithImage(B)` передаёт override image/env только одному `compose up`; в отличие от `reconcile()`, не вызывает `#setSettings()`. Сам `.env` также остаётся на A до конца `upgradeLocked()`. После HTTP-проверок `runDoctorLint()` вызывает обычный `ctx.runtime.runOneOff("cli", ...)`: его `withEnvFile()` использует прежний `#getSettings()`, а service `cli` получает image из этого `OPENCLAW_IMAGE`. Поэтому validator запускается из A, хотя upgrade проверяет B. Ни отдельного B-context для CLI, ни проверки фактического running digest после doctor до pin в этой цепочке нет.

**Поддерживаемый сценарий:** deployment уже закреплён на A штатным bootstrap; registry/channel или явный `--image` выбирает отличающийся digest B. B запущен и отвечает на probes. Затем doctor неизбежно выбирает A по старому environment. Если между релизами изменились config/schema/security checks, именно новые правила не проверяются; прежний CLI также может ошибочно отвергнуть корректную конфигурацию нового релиза. Это не предположение о несовместимости конкретных опубликованных версий: несоответствие выбранного image доказывается аргументами и env.

**Последствие:** post-upgrade acceptance не относится к устанавливаемому коду. Успешный lint A позволяет объявить B проверенным; отказ старого CLI может вызвать ненужный rollback. Возможное дополнительное влияние `compose run` на его `depends_on` здесь не засчитывается: фактический recreate dependency без запуска Compose не установлен.

**Разумное исправление:** в пределах upgrade использовать target-image settings для всех post-recreate операций, особенно CLI validation, не публикуя durable pin до успеха. Сохранить отдельно точный previous digest для компенсации. Перед успешным pin подтвердить фактическую identity gateway; не просто заменить `.env` раньше проверки, теряя прежнюю декларацию при отказе.

**Acceptance:** при исходном pin A и target B действительный DockerRuntime/Compose-путь запускает doctor в B, а не в A; validator B может отклонить обновление, даже если A его бы принял. После успеха running digest и durable pin равны B; после rollback — предыдущему digest. Существующий [upgrade.check.ts:111–129](../tools/checks/runtime/connection-facts/upgrade.check.ts#L111) моделирует recreation и `runOneOff` независимо, поэтому не устанавливает image реального validator.

### R19-02 / P2 — исключения после начала upgrade обходят обещанный rollback

**Код:** [lifecycle.ts:442–461](../tools/framework/commands/lifecycle/lifecycle.ts#L442), [:524–557](../tools/framework/commands/lifecycle/lifecycle.ts#L524), [:624–636](../tools/framework/commands/lifecycle/lifecycle.ts#L624); [compose-operations.ts:141–156](../tools/framework/runtime/docker/compose-operations.ts#L141), [:185–200](../tools/framework/runtime/docker/compose-operations.ts#L185). Обещание «Any failure recreates on the digest that was running before»: [data-and-backups.md:271–275](guide/data-and-backups.md#L271).

**Механизм:** rollback вызывается только после возвращённого `{ok:false}` от health/lint. Вокруг `await recreateWithImage(targetDigest)`, первой части health-loop, `runDoctorLint()` и `pinImageReference()` нет общей compensation-области. Эти операции могут именно бросить исключение. Например, `withEnvFile()` после успешного Compose action отдельно бросает ошибку удаления temporary environment: target уже изменён, но `upgradeLocked()` прекращается до health и rollback. Аналогично ненулевой `compose up` может означать отказ запуска уже заменённого контейнера; exception из `probe`/`lastExitCode` или `runOneOff` тоже не превращается в health/lint outcome. JSON-wrapper лишь публикует ошибку и перебрасывает её, не компенсируя изменение.

**Поддерживаемый сценарий:** pre-upgrade backup успешно опубликован; recreation заменяет или начинает заменять прежний gateway. Затем Compose/transport сообщает ошибку либо отказывает cleanup временного env-каталога. Для cleanup-сценария успешное изменение и последующее исключение непосредственно заданы `withEnvFile()`, не требуют предполагать atomicity Docker-команды. Ошибка записи локального `.env` при SSH target — ещё один достижимый отказ после успешного изменения remote runtime.

**Последствие:** команда завершается ошибкой, оставляя новый либо не запущенный контейнер и прежний pin, хотя обещает автоматическое возвращение к предыдущему image. Наличие пригодного backup само по себе не запускает восстановление. Если target остаётся недоступным, успешную компенсацию гарантировать невозможно; дефект здесь в отсутствии даже попытки и её outcome, а не в требовании успешно откатить недоступный сервер.

**Разумное исправление:** охватить этапы от начала recreation до подтверждения/pin единым failure/compensation path. Различать отказ до мутации, ошибку после возможной мутации, migration failure и ошибку самого rollback; сохранять исходную причину и backup path. Не скрывать compensation failure под сообщением об успешном откате.

**Acceptance:** детерминированно смоделировать исключение после фактической смены image, исключение post-upgrade validator и отказ pin; в каждом случае проверить попытку вернуть previous digest, отсутствие успешного pin B и честный итог. Отказ до backup/recreation не должен вызывать rollback. Проверить также failed compensation с обеими причинами. Нынешний [upgrade.check.ts:40](../tools/checks/runtime/connection-facts/upgrade.check.ts#L40), [:160–200](../tools/checks/runtime/connection-facts/upgrade.check.ts#L160) покрывает возвращённые health/doctor failures, не эти exception-ветви.

**Отличие от R19-01:** даже validator с правильным image оставит этот пробел в обработке исключений; исправление только rollback не исправит выбор старого validator.

### R19-03 / P2 — `lock` закрепляет ошибку чтения plugins/skills как пустой состав

**Код:** [extensions.ts:46–80](../tools/framework/commands/management/extensions.ts#L46); [lock.ts:139–159](../tools/framework/commands/management/lock.ts#L139), [:278–307](../tools/framework/commands/management/lock.ts#L278); [openclaw-cli.ts:167–184](../tools/framework/service/openclaw-cli.ts#L167). Поддерживаемая команда: [commands.md:46](guide/commands.md#L46).

**Механизм:** `openclawCliBatch()` сохраняет отказ каждого slot, включая ошибку транспорта/неполный batch. `currentComposition({includeExtensions:true})` без проверки outcome передаёт slots в parsers, которые для ненулевого exit или malformed JSON возвращают `[]`. Затем composition содержит именно `plugins:[]`/`skills:[]`, а `lock()` записывает его поверх existing lock. `lock --check` также получает эти массивы и сравнивает их как подтверждённое отсутствие, предлагая reinstall прежних entries. При пустых pins ошибочное чтение может вообще дать «matches».

**Поддерживаемый сценарий:** обычный `./clawforge lock` или MCP `lock` при работающем gateway; одна CLI inventory-команда отказала, вернула malformed JSON либо CLI batch не смог запуститься, но последующие image/secrets reads доступны. Например, отказ отдельной команды не делает Docker image inspect недоступным. Для разрушительной публикации не нужен полный длительный outage target.

**Последствие:** повторное pinning молча теряет реальные plugin/skill pins и их версии; `--check` выдаёт ложный drift или ложное совпадение. Это нарушение инструмента воспроизводимости, не stylistic preference и не требование автоматически переустанавливать extensions.

**Разумное исправление:** сохранить distinction между успешным пустым inventory и неизвестным результатом. Неполная инвентаризация должна остановить публикацию нового lock, сохранив прежние байты; `--check` должен назвать непроверенные inventory, а не объявлять entries удалёнными. Общий parser может возвращать явный outcome или caller может проверять failure/shape до нормализации.

**Acceptance:** existing lock с pins; failed plugins-read при успешном skills-read, failed whole batch и malformed success JSON не изменяют файл и не порождают доказательное «no longer installed». Успешные `{plugins:[], skills:[]}` по-прежнему означают настоящее удаление. Существующий [release/release/lock.check.ts:208–212](../tools/checks/release/release/lock.check.ts#L208) утверждает empty parser outcome, но не сохранность lock при таком input.

**Не повтор R10-06:** inspect уже отдельно защищён unknown-read ветвью и [gather.ts:261–262](../tools/framework/commands/orchestration/inspect/gather.ts#L261) не сравнивает extensions при неполном результате. Здесь другой consumer — durable writer `lock` и его собственный `--check`.

### R19-04 / P2 — SSH-расписание `watch` пишет не тот state, который читает оператор

**Код:** [schedule.ts:248–252](../tools/framework/commands/operate/schedule.ts#L248); [watch/install.ts:96–103](../tools/framework/commands/operate/watch/install.ts#L96), [:117–135](../tools/framework/commands/operate/watch/install.ts#L117); [watch/state.ts:72–74](../tools/framework/commands/operate/watch/state.ts#L72), [:163–192](../tools/framework/commands/operate/watch/state.ts#L163); [watch/status.ts:38–65](../tools/framework/commands/operate/watch/status.ts#L38); [deploy/sync.ts:85–123](../tools/framework/commands/management/deploy/sync.ts#L85). Контракт: [monitoring-and-access.md:156–165](guide/monitoring-and-access.md#L156), [:191–208](guide/monitoring-and-access.md#L191).

**Механизм:** на SSH `watch install --apply` ставит cron **на target**, с cwd `remotePath` и `./clawforge --app <name> watch check`. Запущенный там процесс имеет remote deploymentDir и пишет remote `apps/<name>/state/watch.json`. Но `recordInstalledInterval()` выполняется исходным operator-процессом и пишет local `deploymentDir()/state/watch.json`. `watch status` из исходного SSH deployment также всегда читает этот local файл через `node:fs`, не спрашивая target. Deploy переносит `app.ts`, `config/` и recipes, не синхронизирует watch state. Общего файла между машинами нет.

**Поддерживаемый сценарий:** deployment штатно зеркалирован через `deploy`; оператор настроил SSH connection, установил watch с интервалом, отличающимся от пяти минут, и затем использует штатный `watch status`/MCP на своей машине. Remote job работает и может иметь собственный webhook failure/pending alert. Его результат не попадёт в operator-side status. Если локальная ручная проверка ещё не выполнялась, status сообщит «no check has run yet» несмотря на работающий remote schedule; если выполнялась — останется на её старом состоянии. На remote стороне установленный interval также не записан этой установкой, и status там использует default для staleness.

**Последствие:** основной инструмент проверки автоматического мониторинга не показывает фактические run/error/pending данные своего SSH-расписания; staleness оценивается по другой истории или неправильному интервалу. Это особенно существенно потому, что cron вывод заглушён и руководство называет `watch status` сохранённым trace отказа доставки.

**Разумное исправление:** согласовать execution location, interval metadata и status source. При target-side schedule interval и результаты должны принадлежать remote deployment, а operator `watch status` должен читать эту историю через transport либо явно предоставлять отдельный, исполнимый способ посмотреть именно scheduled history. Не смешивать её без маркировки с ad-hoc operator-side cycles; при недоступном target честно сообщать unknown, а не выдавать local history за состояние установленного расписания.

**Acceptance:** модель двух раздельных deployment filesystems: SSH install записывает interval там, где job реально запускается; remote check сохраняет down/error/pending; operator status возвращает именно этот outcome и правильный threshold. Успешный remote run не сопровождается ложным «never ran»/stale из local file. Uninstall очищает metadata в том же источнике. Local/WSL workflows сохраняют свою явно определённую location.

**Не повтор R10/R11/R16:** Windows action/cwd, cron marker и account-wide scheduler transaction уже исправлены. Этот дефект — разделение истории выполнения между operator и remote host после успешной установки.

### R19-05 / P2 — пример `afterBackup` портит offsite-архив текстовым чтением

**Документация и API:** [data-and-backups.md:214–219](guide/data-and-backups.md#L214); [transport/exec.ts:83–89](../tools/framework/runtime/transport/exec.ts#L83), [:160–165](../tools/framework/runtime/transport/exec.ts#L160); [transport/local.ts:28–30](../tools/framework/runtime/transport/local.ts#L28); [transport/ssh.ts:94–96](../tools/framework/runtime/transport/ssh.ts#L94).

**Механизм:** опубликованный пример копирует `.tar.gz` через `const bytes = await ctx.transport.readFile(archive)` и затем Node `writeFile(..., bytes)`. Несмотря на имя `bytes`, API возвращает `string`: local читает с `"utf8"`, SSH/WSL `cat` декодируется UTF-8 в `spawnLocal()`. Gzip не является UTF-8 текстом: уже обязательный header `1f 8b` содержит недопустимый самостоятельный byte `8b`. Decode заменяет его replacement character; обратная запись строки кодирует другой набор байтов. Исправить это поздним `Buffer.from(string)` уже нельзя — исходные байты утрачены при чтении.

**Поддерживаемый сценарий:** автор deployment использует рекомендованный hook для копии off-host; output directory существует, все filesystem/transport операции успешны. Дефект возникает и на обычном Linux local target, и при remote transport; не требует edge-case имени файла или специального содержимого backup.

**Последствие:** hook завершается успешно, но offsite-копия не является исходным gzip и не восстанавливается. Исходный target archive этим примером не повреждается; потеря всех данных не утверждается. Нарушена именно обещанная дополнительная recoverable copy, на которую оператор рассчитывает при потере target-диска.

**Разумное исправление:** заменить runnable пример байтосохраняющим переносом — корректный внешний scp/rsync либо target-side base64 с явным decode в `Buffer` на operator и проверкой source/destination digest. Явно описать `Transport.readFile` как text-only, чтобы похожий пример не воспроизвёл ошибку. Добавление нового binary API не обязательно для исправления документации.

**Acceptance:** выполнить исправленный пример над небольшим настоящим `.tar.gz` с бинарным payload; source/offsite SHA-256 совпадают, offsite архив распаковывается и возвращает исходные байты. Проверить хотя бы local и используемый в примере remote transfer path. Это поведенческая проверка документационного сценария, не source-text assertion. В данном раунде пример не запускался: ошибка следует из типов, явной кодировки и формата gzip.

### R19-06 / P3 — параллельные `watch check` дублируют alert одного перехода

**Код:** [watch/index.ts:31–35](../tools/framework/commands/operate/watch/index.ts#L31); [watch/check.ts:125–150](../tools/framework/commands/operate/watch/check.ts#L125), [:259–275](../tools/framework/commands/operate/watch/check.ts#L259); [watch/state.ts:173–192](../tools/framework/commands/operate/watch/state.ts#L173); [schedule.ts:84–90](../tools/framework/commands/operate/schedule.ts#L84). Контракт «an unchanged state never alerts twice»: [monitoring-and-access.md:49–58](guide/monitoring-and-access.md#L49).

**Поддерживаемый сценарий и interleaving:** на одной машине cron выполняет scheduled `watch check`, а оператор одновременно вызывает ручной `watch check` того же deployment, например разбирая отказ. Два процесса A/B получили одинаковый down outcome. Оба читают прежний state `ok`; A начал POST и ещё не записал down; B тоже вычисляет `ok → down` и отправляет POST. Оба сообщения могут успешно доставиться, после чего оба публикуют down. Этот порядок допустим между отдельными `await`, не требует нагрузки или shared MCP queue: CLI/cron — разные процессы.

**Механизм и последствия:** atomic rename защищает целостность одного JSON, не всю read/transition/delivery/write-транзакцию. В dispatcher/runWatchCycle нет взаимного исключения между процессами; cron command также без execution lock. Один и тот же неизменный outage поэтому получает два одинаковых alert. При разных outcomes поздняя публикация также может заменить state из другой незавершённой транзакции; для приоритета достаточно непосредственно доказуемой duplicate delivery, а конкретный пропущенный реальный инцидент здесь не утверждается.

**Разумное исправление:** сериализовать cycle для одного deployment на машине, где живёт его watch state, удерживая исключительность от чтения previous state до delivery/persistence. Не использовать только target instance lock: наблюдение должно работать и при недоступном target. При конкуренции ожидать/пропускать cycle с честным outcome, а не молча писать из stale snapshot.

**Acceptance:** два процесса/управляемых runner одного deployment, identical down outcome и prior ok; задержать первый POST до входа второго. Итог — один transition-alert и один согласованный down state. Затем recovery даёт один down→ok alert. Failure delivery по-прежнему сохраняет retry metadata. Account-wide flock исправленного R16-03 защищает редактирование crontab, не выполнение `watch check`, поэтому эту гонку не закрывает.

## Удобство, полнота инструментария и качество кода

Рассмотрен framework в целом через operator-facing цепочки, а не только diff раунда 18: source/installed gates, parser/help/completion, command declarations и MCP schema/dispatch/capture, контекст и transport, secrets/provisioning/recipe loader, inspect/doctor/plan/apply, set verification/rollback storage, upgrade/backup/restore, scheduling/watch и deploy boundaries. Прочитаны соответствующие руководства и адресные checks как исходники. Наиболее значимые оставшиеся usability-пробелы выше — не отсутствие косметических флагов, а неверный validator обновления, неполная компенсация, потеря достоверности pinning и невозможность нормально увидеть историю SSH-мониторинга. Отдельно документация сейчас предлагает невосстанавливаемую offsite-копию.

Положительные свойства, видимые в изученном коде: общий declared-argument контракт для CLI/MCP/help; named unknown-state вместо ложной provisioning mutation в inspect; protected публикация секретных файлов; backup staging и compensation; отдельный фактический restore outcome; shared account transaction для расписаний; текущие URL redaction и heartbeat drain. Эти свойства не выдаются за новые динамические проверки.

Размер функции, объём комментариев, выбор относительного импорта и существующие ограничения полноты upstream inventory сами по себе не засчитаны P3. Предложения добавить новые системы retry/telemetry или ещё один параллельный механизм dispatch не делаются: исправления привязаны к нарушенным существующим контрактам.

## Пределы доказательства

- Это статический обзор ключевых consumer paths, **не построчное доказательство корректности каждого файла** и не утверждение об отсутствии иных дефектов.
- Ни один новый пункт не выдаётся за воспроизведённый. Docker Compose, cron, Task Scheduler, SSH/WSL, webhook delivery, archive transfer и конкретные upstream релизы не запускались; acceptance выше предназначен для фазы исправлений.
- Поведение dependency recreation при `compose run`, частота exception/race на живой машине и совместимость конкретных релизов OpenClaw не установлены. Они не нужны для доказанных механизмов и не включены в severity.
- Известные capability-пропуски, полный Windows→WSL→Docker прогон и прежняя гипотеза полноты native backup для ссылок/пустых каталогов не заявлены новыми находками. Переданное evidence раунда 18 не расширено неисполненными checks.
- Новых P0/P1 в изученных цепочках не подтверждено. Завершение review-loop без P0–P3 пока не достигнуто: остаются перечисленные пять P2 и одна P3. Исправлений исходников в этом read-only раунде нет.
