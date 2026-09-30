# ClawForge — статический аудит XXS, раунд 10

Дата: 2026-09-29. База: `b2a2966`. Просмотрены изменения после XXS-раунда 9, его закрытые задачи, последующие внутренние ревью, а также ключевые цепочки CLI, MCP, планирования, резервного копирования, восстановления, рецептов, развёртывания, транспорта, приватности и CI. Это **только чтение**: приложение, Docker, тесты, сборки, линтеры и воспроизведения не запускались; действующие секреты не читались. Выводы ниже доказывают пути исполнения по исходникам, а не частоту или результат на живом экземпляре.

Шкала: P0 — непосредственный критический ущерб без дополнительных условий; P1 — потеря данных либо выход за заявленную границу удаления; P2 — существенное неверное поведение в поддерживаемом сценарии; P3 — неверная диагностика или меньший операционный дефект. Подтверждённые статически: **P0 — 0, P1 — 4, P2 — 3, P3 — 1**. Условная гипотеза приведена отдельно и в счёт не входит.

## Подтверждённые дефекты

### P1-01 — `check`, включая `--list`, может удалить обычное развёртывание

**Код:** [`tools/checks/kit/run.ts:86–117`](../../tools/checks/kit/run.ts#L86), [`tools/checks/kit/discover.ts:90–106`](../../tools/checks/kit/discover.ts#L90), [`tools/framework/core/names.ts:8–21`](../../tools/framework/core/names.ts#L8).

`runChecks()` вызывает `sweepOrphanedCheckDeployments()` **до** выбора проверок и ветки `--list`. Очистка считает своим любой каталог `apps/<имя>-check-<8–10 hex>`, у которого `mtime` старше 30 минут, и вызывает для него рекурсивный `rm`. Это допустимое имя настоящего развёртывания по `safeName()`; маркер владения или доказательство, что каталог создала проверка, отсутствует. Поэтому даже read-only команда `check --list` удалит такой каталог с `.env`, `secrets/` и конфигурацией без подтверждения. `mtime` каталога может оставаться старым, пока редактируются уже существующие файлы внутри.

**Исправление:** держать тестовые деревья вне `apps/` либо удалять только по проверенному маркеру происхождения, а не по похожему имени; `--list` и неудачный фильтр не должны запускать очистку. Проверить регрессией сохранность настоящего каталога с совпадающим именем. **Граница:** ветка удаления однозначна в коде; реальный каталог для воспроизведения не создавался и не удалялся.

### P1-02 — `destroy` пропускает `..` и symlink в предке удаляемого пути

**Код:** [`tools/framework/core/env.ts:360–378`](../../tools/framework/core/env.ts#L360), [`tools/framework/commands/lifecycle/lifecycle.ts:197–236`](../../tools/framework/commands/lifecycle/lifecycle.ts#L197), [`tools/framework/commands/lifecycle/lifecycle.ts:260–305`](../../tools/framework/commands/lifecycle/lifecycle.ts#L260).

`OC_BACKUP_DIR` и `OC_SNAPSHOT_DIR` попадают в `Settings` без нормализации. `assertSafeRemovalShape()` считает сырые сегменты и проверяет форму домашнего каталога **до** разрешения `..`; `assertNotSymlink()` проверяет только последний компонент. Например, путь вида `/srv/instance/../../home/user` проходит обе проверки, если его промежуточный каталог существует, но `rm -rf -- <путь>` адресует чужой домашний каталог. Так же `.../link/backups` проходит `test -L`, когда `link` — symlink-предок, а `backups` — обычный каталог за ним. `destroy --backups --yes --confirm-name ...` поэтому может удалить дерево вне заявленного пути, в том числе через `sudo -n`.

**Исправление:** отвергать `.`/`..`, повторные и смешанные разделители для всех трёх корней; на целевом хосте разрешать и проверять всю цепь предков с теми же правами, что у удаления, и повторять проверку непосредственно перед `rm`. Проверить оба случая на искусственном дереве. **Граница:** путь от конфигурации до `rm` подтверждён статически; удаление не выполнялось.

### P1-03 — `remove-app --yes` удаляет локальный центр настроек при неизвестном состоянии экземпляра

**Код:** [`tools/framework/integration/list.ts:95–115`](../../tools/framework/integration/list.ts#L95), [`tools/framework/integration/deployment/remove.ts:76–104`](../../tools/framework/integration/deployment/remove.ts#L76), [`tools/framework/integration/deployment/remove.ts:107–124`](../../tools/framework/integration/deployment/remove.ts#L107).

При недоступном target, ошибке `app.ts` или сбое `isRunning()` каталог получает состояние `error`. `removeApp()` отказывает только для `running` и `stopped`; `error` и отсутствие строки проходят к рекурсивному удалению `apps/<name>`. Удаляются локальные `.env`, `secrets/`, рецепты и клиентские конфиги, хотя удалённый экземпляр может продолжать работать. Обещание команды «сначала destroy для любого bootstrapped instance» в такой ситуации не соблюдено.

**Исправление:** разрешать `--yes` лишь после доказанного `not-bootstrapped`; `error`, `unchecked` и отсутствие записи должны останавливать удаление с причиной. Если нужен аварийный обход, выделить его в отдельное явное подтверждение состояния `unknown`. **Граница:** штатная ошибка target точно превращается в `error` и проходит текущий фильтр; живой target не отключался.

### P1-04 — сбой `crontab -l` может стереть чужие расписания при `install --apply`

**Код:** [`tools/framework/commands/operate/schedule.ts:93–112`](../../tools/framework/commands/operate/schedule.ts#L93), [`tools/framework/commands/lifecycle/backup/install.ts:92–99`](../../tools/framework/commands/lifecycle/backup/install.ts#L92), [`tools/framework/commands/operate/watch/install.ts:132–139`](../../tools/framework/commands/operate/watch/install.ts#L132).

`readCrontab()` преобразует **любой** ненулевой exit `crontab -l` в пустую строку. Отсутствие личного crontab действительно даёт ненулевой код, но его также дают отказ доступа, ошибка spool или транспорта. После такой ошибки обе команды `install --apply` записывают в `crontab -` только новую строку, заменяя расписание целиком. `probeCrontab()` доказывает лишь наличие бинарника, а не успешность чтения существующих заданий.

**Исправление:** отдельно распознавать доказанное «crontab ещё нет», прочие ошибки прерывать до `crontab -`; сохранить исходные строки при временном сбое чтения. Адресный тест — ненулевой listing с ошибкой и существующими заданиями в модели транспорта. **Граница:** исходники доказывают перезапись при этом ответе; системный crontab не менялся.

### P2-01 — `restore --dry-run` исполняет hook и пишет временные файлы

**Код:** [`tools/framework/commands/lifecycle/restore/index.ts:259–286`](../../tools/framework/commands/lifecycle/restore/index.ts#L259), [`tools/framework/commands/lifecycle/restore/index.ts:305–315`](../../tools/framework/commands/lifecycle/restore/index.ts#L305), [`tools/framework/commands/lifecycle/restore/index.ts:347–351`](../../tools/framework/commands/lifecycle/restore/index.ts#L347), [`tools/framework/commands/lifecycle/restore/index.ts:562–573`](../../tools/framework/commands/lifecycle/restore/index.ts#L562), [`tools/checks/runtime/lifecycle/restore/restore-dry-run.check.ts:58–79`](../../tools/checks/runtime/lifecycle/restore/restore-dry-run.check.ts#L58).

Ветка `--dry-run` вызывает общий `prepareRestore()`. Тот безусловно исполняет `applicationBeforeRestore`, которому доступен обычный код приложения, а архив с native manifest проверяет через `verifyEmbeddedNativeManifest()`: создаёт каталог под live data, распаковывает туда manifest, запускает CLI и удаляет временный каталог. Это противоречит обещанию «without touching the target»; проверка dry-run использует только архив **без** native manifest и контекст **без** hook, поэтому не видит обе ветви.

**Исправление:** отделить read-only план от hook-подготовки и проверки, требующей временной записи; явно отметить в плане, какие проверки будут выполнены только при настоящем restore. Добавить адресные проверки для hook и native manifest. **Граница:** выполнение ветвей следует из кода; неизвестно, какой побочный эффект конкретный hook окажет в приложении, и архивы не открывались.

### P2-02 — Windows `watch/backup install --apply` создаёт задачу без работающего `uninstall --apply`

**Код:** [`tools/framework/commands/operate/schedule.ts:124–136`](../../tools/framework/commands/operate/schedule.ts#L124), [`tools/framework/commands/operate/schedule.ts:249–283`](../../tools/framework/commands/operate/schedule.ts#L249), [`tools/framework/commands/operate/watch/install.ts:106–115`](../../tools/framework/commands/operate/watch/install.ts#L106), [`tools/framework/commands/operate/watch/install.ts:143–152`](../../tools/framework/commands/operate/watch/install.ts#L143), [`tools/framework/commands/lifecycle/backup/install.ts:66–75`](../../tools/framework/commands/lifecycle/backup/install.ts#L66), [`tools/framework/commands/lifecycle/backup/install.ts:102–111`](../../tools/framework/commands/lifecycle/backup/install.ts#L102).

На Windows `schedulingSupport()` возвращает `supported:false`. Ветка `install` всё равно передаёт `--apply` в `printSchedulingInstructions()`, которая вызывает `schtasks /create`. Обе ветки `uninstall` при том же `supported:false` заявляют, что задача не могла быть установлена, и **отказывают** с `--apply`; объявленный `schtasksDeleteCommand()` в продуктивном пути не используется. Для `watch` Windows-ветка также возвращается до `recordInstalledInterval()`, поэтому `watch status` не знает реально установленный интервал, отличный от умолчания.

**Исправление:** симметрично создать/удалить Windows task по одному имени и обновлять watch state только после успешного `schtasks`; покрыть lifecycle установки и удаления без реального Task Scheduler. **Граница:** ветви платформы и вызовы ясны статически; Windows task не создавалась.

### P2-03 — неудачный batched CLI-read превращается в ложное задание для `apply`

**Код:** [`tools/framework/service/openclaw-cli.ts:148–180`](../../tools/framework/service/openclaw-cli.ts#L148), [`tools/framework/commands/orchestration/inspect/live.ts:225–248`](../../tools/framework/commands/orchestration/inspect/live.ts#L225), [`tools/framework/commands/orchestration/inspect/live.ts:304–334`](../../tools/framework/commands/orchestration/inspect/live.ts#L304), [`tools/framework/commands/orchestration/inspect/live.ts:411–419`](../../tools/framework/commands/orchestration/inspect/live.ts#L411), [`tools/framework/commands/orchestration/plan.ts:65–83`](../../tools/framework/commands/orchestration/plan.ts#L65), [`tools/framework/commands/orchestration/plan.ts:252–261`](../../tools/framework/commands/orchestration/plan.ts#L252).

`openclawCliBatch()` возвращает слот с `code:1` при отказе всей одноразовой CLI-сессии или отдельной команды. `parseJsonOrEmpty()` превращает этот слот в пустые `agents`, `mcp` или `cron`, и сравнение объявляет существующие объекты отсутствующими (`AGENT_MISSING`, `MCP_SERVER_MISSING`, `CRON_DRIFT`). `planActions()` на такие находки строит **исполняемый**, а не advisory шаг `provision-agent`; последующий `apply` может менять исправное состояние на основании неудачного чтения. Комментарий «gap, not verdict» фактическим типом `[]` не обеспечен.

**Исправление:** переносить `unknown/read failed` как отдельное состояние с причиной; при нём не строить доказательных `*_MISSING` и исполняемых шагов, а `apply` останавливать до мутаций. **Граница:** ложные находки/план следуют из кода для ненулевого слота; живой `apply` не запускался.

### P3-01 — ошибка инвентаризации архива показана как пустой каталог

**Код:** [`tools/framework/service/archive/inventory.ts:40–67`](../../tools/framework/service/archive/inventory.ts#L40), [`tools/framework/service/archive/inventory.ts:101–112`](../../tools/framework/service/archive/inventory.ts#L101), [`tools/framework/commands/lifecycle/backup/list.ts:48–61`](../../tools/framework/commands/lifecycle/backup/list.ts#L48), [`tools/framework/commands/lifecycle/backup/list.ts:94–106`](../../tools/framework/commands/lifecycle/backup/list.ts#L94), [`tools/framework/commands/orchestration/inspect/upkeep.ts:44–50`](../../tools/framework/commands/orchestration/inspect/upkeep.ts#L44).

`listBackupArchives()` и `listReplacedCopies()` при ненулевом `find` возвращают `[]`. Если каталог существует, но доступ потерян или `find` завершился ошибкой, `backup list` печатает `none found`; `doctor` может выдать `BACKUP_MISSING`. Это неверная причина и скрывает диагностический stderr. В соседнем `rotate()` ненулевой listing уже считается ошибкой — различие не обосновано.

**Исправление:** пустой успешный listing оставить `[]`, ненулевой код вернуть как ошибку чтения с безопасно усечённой причиной; UI и doctor показывают `unknown/unreadable`. **Граница:** поведение при ненулевом коде статически однозначно; реальные права каталога не менялись.

## Условная гипотеза, не засчитанная как подтверждённый дефект

**P2-H1 — native backup может оставить credential-complete временный архив после отказа `openclaw backup create --verify`.** Путь [`tools/framework/commands/lifecycle/backup/index.ts:282–303`](../../tools/framework/commands/lifecycle/backup/index.ts#L282) создаёт имя внутри live `config/`; `catch` выбрасывает ошибку **до** `finally`, который удаляет файл лишь начиная с [`index.ts:341–351`](../../tools/framework/commands/lifecycle/backup/index.ts#L341). Если upstream команда успела записать архив и затем отказала при проверке, файл остаётся в live data. Следующий framework backup исключает этот шаблон ([`profile.ts:116–120`](../../tools/framework/service/archive/profile.ts#L116)), что ограничивает распространение, но не удаляет секретный артефакт с диска. Нужен адресный отказ команды **после** создания файла и проверка cleanup; по одному чтению исходников upstream нельзя утверждать, что такой порядок отказа наблюдался.

## Известные ограничения и граница раунда

- Полный Windows → WSL → Docker по-прежнему вынесен в ручной workflow для self-hosted runner ([`windows-full.yml:1–49`](../../.github/workflows/windows-full.yml#L1)); hosted WSL2 job advisory и `continue-on-error` ([`ci.yml:166–180`](../../.github/workflows/ci.yml#L166)). Зелёный обычный CI не является свидетельством этого пути. Это уже отмеченный инфраструктурный пробел, не новая находка.
- Пункты XXS-раунда 9 повторно не заявлены: перед оценкой прочитаны их [отчёт](review-2026-09-24-xxs-round-9.md) и [статус исправлений](session-tasks-2026-09-24-round-9.md). Ни один сценарий здесь не выдаётся за воспроизведённый: не было тестов, сборок, запусков, работы с контейнерами, живых backup/restore или сетевых проверок.
