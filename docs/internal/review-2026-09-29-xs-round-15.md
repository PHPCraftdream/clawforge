# ClawForge — статическое ревью XS, раунд 15

Дата: 2026-09-29. База: `e2afda5`. Сверены отчёты и закрытые задачи раундов 10–14. Изучены текущие пути apply/rollback, set/artifact/ownership, provisioning, MCP, транспорта, приватных публикаций, backup/verify, планировщиков, watch и incident; связанные проверки и руководства читались как исходники. Работа велась только чтением: приложение, сервисы, тесты, сборки, линтеры, smoke, воспроизведения и бенчмарки не запускались, действующие секреты не читались. Единственное изменение этого раунда — отчёт.

Шкала: P0 — безусловный критический ущерб; P1 — возможная утечка секретов или потеря данных в поддерживаемой конфигурации; P2 — существенное нарушение безопасности или поведения при явном условии; P3 — меньший эксплуатационный дефект. Новые статически подтверждаемые механизмы: **P0 — 0, P1 — 1, P2 — 2, P3 — 1**. Это доказательство ветвей исходников, а не воспроизведение на действующем экземпляре.

## Подтверждённые находки

### P1-01 — rollback заменяет приватную конфигурацию файлом с общедоступным режимом

**Код:** `tools/framework/commands/orchestration/rollback.ts:290-298`, `tools/framework/commands/orchestration/rollback.ts:333-340`, `tools/framework/runtime/transport/local.ts:32-41`, `tools/framework/runtime/transport/ssh.ts:99-103`, `tools/framework/runtime/transport/quoting.ts:39-45`, `tools/framework/runtime/datadir.ts:304-334`.

Обе ветви rollback читают сохранённый `openclaw.json` и передают его в обычный `transport.writeFile(live, content)` без приватного режима. Local writer создаёт новый staging inode с `0o666`, remote writer делает `cat > temporary` без приватного umask; затем staging заменяет существующий файл. Поэтому при umask 022 даже ранее защищённый `0600` live config становится `0644`. Режим старого inode и ACL не сохраняются. В standard data layout framework сужает до `0700` только `auth-secrets/`; для `data/` и `config/` такой защиты нет.

**Последствие:** при доступных на поиск родительских каталогах другой пользователь target получает чтение восстановленного конфига, включая поддерживаемые буквальные gateway/provider credentials и credential URL. Защищённый исходный snapshot не защищает опубликованную копию. **Исправление:** восстанавливать secret-bearing config через атомарный приватный publisher с закрытыми правами до первого байта и с явно определённым owner/ACL; охватить single-file и previous-set ветви. Адресная регрессия должна проверять права final и staging при восстановлении поверх файла `0600`, включая отказ публикации. **Граница доказательства:** смена inode и default modes следуют из writers; реальный umask, права родителей, наличие буквальных секретов и доступ другого пользователя не исследовались. Это отдельный путь от закрытой защиты snapshot/secret-store writers прежних раундов.

### P2-01 — отказ записи pre-rotate evidence останавливает incident до смены токена

**Код:** `tools/framework/commands/operate/incident/index.ts:265-294`, `tools/framework/commands/operate/incident/index.ts:344-377`; обещание: `docs/guide/monitoring-and-access.md:199-217`.

`preserveEvidence()` перехватывает только ошибку `captureIncidentSnapshot()`. Следующие `protectPrivateDirectory()` и обе `createPrivateFile()` находятся вне этого catch. `runPhases()` ждёт preserve без защиты, до входа в try ротации. Если snapshot успешно прочитан, но локальный evidence-каталог нельзя создать/защитить или записать — например, deployment incidents недоступен, локальный диск заполнен или Windows ACL command отказывает, — runbook сразу завершается. Target и локальный `.env` при этом могут оставаться доступными для ротации, особенно при SSH target; сама ротация даже не предпринимается.

**Последствие:** отказ вторичной записи улик оставляет потенциально скомпрометированный gateway token в силе и пропускает audit/collect. Это противоречит контракту продолжать остальные фазы при отказе фазы. **Исправление:** охватить ошибками всю preserve-фазу, сохранить сведения о реально записанных файлах и безопасную причину отказа, затем всё равно исполнить rotate/audit и попытку collect. Итог должен сообщать неполноту evidence и исходную ошибку, не изображая успешное сохранение. Добавить адресную проверку отказа private writer после успешного snapshot: rotate вызывается, фаза preserve содержит ошибку. **Граница доказательства:** последовательность await и границы catch однозначны; disk-full, ACL failure и ротация не воспроизводились. Закрытый прежний пункт про отказ contain касается другой фазы и эту ветвь не защищает.

### P2-02 — неизвестное состояние каналов превращается в объявленное восстановление watch

**Код:** `tools/framework/commands/orchestration/inspect/live.ts:223-225`, `tools/framework/commands/orchestration/inspect/live.ts:438-445`, `tools/framework/commands/operate/watch/health.ts:38-41`, `tools/framework/commands/operate/watch/check.ts:46-63`, `tools/framework/commands/operate/watch/check.ts:175-184`, `tools/framework/commands/operate/watch/check.ts:258-280`, `tools/framework/commands/operate/watch/check.ts:288-299`; текущий oracle: `tools/checks/runtime/watch/health.check.ts:93-100`.

Watch запрашивает `channels status --json`, однако при ненулевом exit/невалидном JSON `parseChannelsStatus()` возвращает `undefined` без самостоятельного finding. `channelFindings(undefined)` и malformed response возвращают пустой список. При успешных HTTP probes, egress и df итог становится `ok`; даже ошибки других slots с кодом `CLI_READ_FAILED` не входят в `LIVENESS_CODES`. Если предыдущий цикл был `degraded` из-за `CHANNEL_UNHEALTHY`, исчезновение telemetry очищает эту причину, отправляет переход `degraded → ok`, сохраняет здоровое состояние и разрешает heartbeat. Связь канала при этом не была доказана.

**Последствие:** отказ канальной диагностики может скрыть продолжающийся сбой бота и отправить ложный recovery alert/healthy heartbeat. **Исправление:** отличать «каналы не запрашивались» от «запрошенное чтение не подтвердилось», переносить unknown с безопасной причиной в watch-вердикт и запретить healthy recovery/heartbeat без достаточной telemetry. Допустим отдельный `CHANNEL_UNKNOWN` с уровнем degraded; не нужно объявлять сам канал down без доказательства. Проверить переход после `CHANNEL_UNHEALTHY` при failed/malformed channels-read и успешных остальных probes. **Граница доказательства:** ложный итог следует из перечисленных ветвей; реальное состояние канала, доставка webhook и heartbeat не проверялись. Это не повтор закрытого R10-06: там исправлены registration reads и запрет mutating apply, а channels-read и watch остаются отдельными потребителями.

### P3-01 — процент в допустимом пути ломает установленную cron-команду

**Код:** `tools/framework/commands/operate/schedule.ts:83-85`, `tools/framework/commands/operate/schedule.ts:173-181`, `tools/framework/commands/operate/schedule.ts:124-129`, `tools/framework/core/io/shell.ts:5-7`, `tools/framework/core/env.ts:406`; проверки quoting: `tools/checks/runtime/schedule/schedule.check.ts:74-75`.

`cronLine()` цитирует cwd обычным POSIX single-quote и кладёт результат непосредственно в crontab. Допустимый POSIX путь с `%` не отвергается и не получает cron-экранирования. Cron обрабатывает неэкранированный `%` до shell: он разделяет команду и данные stdin даже внутри shell-кавычек. Поэтому, например, cwd `/srv/project%blue` превращает сформированный `cd '...%...' && ./clawforge ...` в обрезанную команду с незакрытой кавычкой. Установка crontab при этом успешно принимает запись, а вывод задания заглушён в `/dev/null`.

**Последствие:** backup/watch расписания на таком пути устанавливаются с сообщением об успехе, но не исполняют работу. **Исправление:** применять отдельное кодирование для cron-команд после shell-quoting либо заранее отказывать неподдерживаемому `%` до изменения crontab. Обновить matching собственных записей согласованно и проверить литеральный `%` и backslash перед ним. **Граница доказательства:** отсутствие cron-encoding видно в исходниках; реальный cron, schedule firing и shell-команда не запускались. Это отдельная грамматика от исправленного WSL shell-quoting раунда 11.

## Гипотезы и пределы

Новых гипотез, достаточно конкретных для отдельной задачи, не добавлено. Неполнота upstream native backup в отношении ссылок/пустых каталогов из раунда 13 остаётся прежней недоказанной гипотезой; повторной находкой не считается. Известный полный Windows → WSL → Docker прогон и capability-пропуски не исследовались и в новые P-пункты не включены.

Статический объём проверки не является доказательством отсутствия других дефектов. Закрытые пункты 10–14 не повторены; четыре новых находки описывают свои условия, последствия и границы доказательства. Задачи этого ревью — сверка предыдущих отчётов, анализ текущего кода, запись отчёта — выполнены. Исправление находок и любые динамические проверки в этот read-only раунд не входят.
