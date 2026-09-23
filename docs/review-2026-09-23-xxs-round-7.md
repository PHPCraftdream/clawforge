# Статический defensive audit ClawForge — XXS, раунд 7, 2026-09-23

## Результат и проверенный снимок

**17 актуальных находок: P0 — 0, P1 — 3, P2 — 13, P3 — 1.** P1 означает риск записи вне ожидаемого дерева либо выпуска приватного содержимого; P2 — нарушенный поддерживаемый сценарий или неполную защитную гарантию; P3 — пробел проверки. Это выводы из кода, а не свидетельство эксплуатации или результат запуска.

Основа снимка — `50740d62c83ac5be764061fdb5504204a42c7a08` (`docs: record XXA static audit round 6`). В отдельный worktree перенесены **59 изменённых tracked-путей и 19 новых файлов** основного checkout. SHA-256 `git diff --binary HEAD`: `58ff8f44a14678143a7c9cb7d8feadcdf75ea8f3c62800097812bdc472edf0f`. SHA-256 манифеста 19 новых файлов до добавления этого отчёта: `89ad367325263b725319e2c7563edcceb05065385f9548d64cfbe4c43c56c6b3` (пути `git ls-files --others --exclude-standard`, `Sort-Object`, для каждого UTF-8 путь + NUL + lowercase SHA-256 содержимого + LF). Patch в worktree и patch основного checkout дали одинаковый SHA-256; содержимое каждого из 19 новых файлов сверено отдельно. **Номера строк ниже относятся к этому снимку с незакоммиченными изменениями, а не к одному базовому commit.** Отчёт не включает product diff.

Прочитаны пять предыдущих отчётов, исходники и существующие checks в потоках lifecycle, data roots, archive/backup/restore, privacy history, secrets, locks, recipes/hooks, portable policy, set control state, MCP, host, apply/recovery, deploy и CI; сопоставлены `git diff` и история commit. **Тесты, typecheck, lint, build, pack, audit, приложение, контейнеры, host engine и сетевые проверки не запускались.** Реальные секреты не читались; exploit payload и reproducer не создавались. Поэтому «исправлено по коду» ниже не означает пройденную регрессию, а выявленные условия не означают подтверждённое исполнением воспроизведение.

## P1 — границы данных и приватности

### P1-01 — Restore проверяет физическую ancestry data root после перемещения и распаковки

**Evidence:** [restore.ts:247](../tools/framework/commands/lifecycle/restore.ts#L247), [restore.ts:254](../tools/framework/commands/lifecycle/restore.ts#L254), [restore.ts:262](../tools/framework/commands/lifecycle/restore.ts#L262), [restore.ts:297](../tools/framework/commands/lifecycle/restore.ts#L297), [datadir.ts:129](../tools/framework/runtime/datadir.ts#L129), [datadir.ts:225](../tools/framework/runtime/datadir.ts#L225).

`restoreArchive` останавливает сервис, перемещает существующий `dataDir` и распаковывает архив до `ensureDataDirs`, где теперь проверяется canonical ancestry. Более ранний `verifyRestoredLayout` проверяет ссылки *внутри уже распакованного root*, но не путь к самому root. **Условие:** один из существующих родителей настроенного `dataDir` стал symlink на другое дерево. Тогда `mv`, `mkdir` и распаковка действуют в этом другом дереве ещё до проверки. Поздний отказ может попытаться откатить результат, но не делает предшествовавшие действия безопасными, особенно при ошибке отката. Это остаток исходной границы restore из XA round 2, отличный от исправленной проверки ссылок в архиве.

**Рекомендация:** выполнять проверку canonical ancestry и назначения data root до `stop`, `mv`, `mkdir` и `tar`; применять ту же физическую границу ко всем destructive операциям и прекращать работу, если она не доказана.

### P1-02 — Прямой `verify` не учитывает privacy history, сохранившуюся только на target

**Evidence:** [archive.ts:514](../tools/framework/service/archive.ts#L514), [verify.ts:237](../tools/framework/commands/lifecycle/verify.ts#L237), [verify.ts:240](../tools/framework/commands/lifecycle/verify.ts#L240), [verify.ts:269](../tools/framework/commands/lifecycle/verify.ts#L269), [private-paths-ledger.ts:527](../tools/framework/security/private-paths-ledger.ts#L527).

`createArchive` теперь импортирует target-side history до чтения policy для новых migrate/share архивов. `verifySnapshot`, в том числе вызываемый напрямую командой `verify`, использует только локальные declarations/ledger и не делает этого согласования. **Условие:** новый или восстановленный operator-side deployment ещё не имеет локальной записи, а существующий target хранит единственную копию history. Внешний или ранее созданный archive с записанным там приватным путём может пройти проверку профиля: выборка известных значений secret scan не заменяет проверку объявленного пути. Прежняя P1-04 round 6 закрыта для создания архива, но не для независимого verifier.

**Рекомендация:** вычислять одну политику из declarations, локальной и target-side history для каждого security reader; read-only verification может объединять её в памяти, не меняя ledger.

### P1-03 — Профиль архива проверяет сырые имена после отдельной структурной нормализации

**Evidence:** [archive.ts:253](../tools/framework/service/archive.ts#L253), [archive.ts:345](../tools/framework/service/archive.ts#L345), [archive.ts:351](../tools/framework/service/archive.ts#L351), [verify.ts:250](../tools/framework/commands/lifecycle/verify.ts#L250), [verify.ts:267](../tools/framework/commands/lifecycle/verify.ts#L267), [verify.ts:269](../tools/framework/commands/lifecycle/verify.ts#L269), [verify.ts:282](../tools/framework/commands/lifecycle/verify.ts#L282).

`inspectArchive` приводит записи и ссылки к каноническому виду для structural checks. Следующий проход `verifySnapshot` заново получает относительные имена из *сырых* записей и по ним применяет `forbiddenViolations` и share allow-list. **Условие:** архив содержит неканоническое, но структурно допустимое написание внутреннего пути (например, лишний компонент текущего каталога). Физическая цель при извлечении совпадает с приватной декларацией, строковая проверка профиля — нет; known-value scan может её не обнаружить. Исправление link resolver из round 6 не закрывает это отдельное расхождение policy.

**Рекомендация:** использовать одну каноническую, проверенную структуру entries для structural и profile checks; дубликаты физических имён с разными spellings отклонять до извлечения.

## P2 — поведение и неполные гарантии

### P2-01 — Первый deploy удаляет собственный маркер root

**Evidence:** [deploy-boundary.ts:22](../tools/framework/security/deploy-boundary.ts#L22), [deploy-boundary.ts:43](../tools/framework/security/deploy-boundary.ts#L43), [deploy.ts:414](../tools/framework/commands/management/deploy.ts#L414), [deploy.ts:431](../tools/framework/commands/management/deploy.ts#L431), [deploy.ts:439](../tools/framework/commands/management/deploy.ts#L439), [root-boundary.check.ts:94](../tools/checks/runtime/service/deploy/root-boundary.check.ts#L94).

Deploy пишет `.clawforge-deploy-marker` в remote root, затем первый `rsync --delete` зеркалирует framework checkout в этот же root. Маркера нет в checkout и нет в `EXCLUDES`, поэтому mirror удаляет его как лишний файл. **Условие:** обычный первый deploy в пустой root. Следующий deploy видит непустой немаркированный root и требует `--adopt`; проверка, которая должна защищать повторные операции, сама исчезает. Существующий check подтверждает порядок «маркер до rsync», но не проверяет его сохранность после rsync. P1-06 round 6 исправлена лишь частично.

**Рекомендация:** сохранять маркер вне удаляемого inventory либо исключить его из root mirror и после sync повторно проверять его точные байты.

### P2-02 — Неудачный lock takeover временно снимает живой lock с пути

**Evidence:** [instance-lock.ts:236](../tools/framework/runtime/instance-lock.ts#L236), [instance-lock.ts:243](../tools/framework/runtime/instance-lock.ts#L243), [instance-lock.ts:250](../tools/framework/runtime/instance-lock.ts#L250), [instance-lock.ts:202](../tools/framework/runtime/instance-lock.ts#L202).

`claimTakeover` сначала перемещает directory по *имени пути*, затем сравнивает generation. **Условие:** caller B прочитал старый holder, caller A уже сменил его и выполняет работу, B переместил живой directory A. Пока B читает displaced holder и пытается вернуть его, обычный caller C может выиграть `mkdir` освободившегося lock path. B откажет себе, но A и C уже выполняются одновременно. Это оставшийся interleaving P2-03 round 6; проверка generation *после* unlink не обеспечивает непрерывную исключительность.

**Рекомендация:** takeover должен удерживать непрерывную эксклюзивную претензию на lock path при проверке поколения; строить протокол на атомарном CAS/lease механизме, а не на move-then-check.

### P2-03 — `smoke` перезаписывает одноимённый пользовательский файл и сохраняет маркер в backup

**Evidence:** [smoke.ts:263](../tools/framework/commands/lifecycle/smoke.ts#L263), [smoke.ts:289](../tools/framework/commands/lifecycle/smoke.ts#L289), [smoke.ts:305](../tools/framework/commands/lifecycle/smoke.ts#L305), [smoke.ts:335](../tools/framework/commands/lifecycle/smoke.ts#L335), [backup.ts:241](../tools/framework/commands/lifecycle/backup.ts#L241).

Маркер пишется в фиксированный путь workspace без проверки предшествующего содержимого. `writeFile` заменяет существующий файл, а compensation затем удаляет его. **Условие:** workspace уже содержит файл с этим именем. Smoke уничтожает его при успешном выполнении; кроме того, full backup создаётся *между* записью и удалением, поэтому сохранённый backup содержит диагностический маркер вместо исходного файла. Изоляция restore закрыла P1-01 round 6, но не этот побочный эффект.

**Рекомендация:** выбрать одноразовое имя с exclusive create или вынести witness из пользовательского дерева; не сохранять временную метку как часть постоянного backup.

### P2-04 — Byte-identical smoke witness не работает для каталогов и бинарных данных

**Evidence:** [smoke.ts:90](../tools/framework/commands/lifecycle/smoke.ts#L90), [smoke.ts:93](../tools/framework/commands/lifecycle/smoke.ts#L93), [smoke.ts:296](../tools/framework/commands/lifecycle/smoke.ts#L296), [smoke.ts:319](../tools/framework/commands/lifecycle/smoke.ts#L319), [recipe.ts:86](../tools/framework/service/recipe.ts#L86), [transport.ts:32](../tools/framework/runtime/transport.ts#L32), [transport.ts:159](../tools/framework/runtime/transport.ts#L159).

`privatePaths` допускает boundary каталога, а witness вызывает `cat` для каждого существующего пути; каталог приводит к отказу smoke до backup. Для обычного файла `ExecResult.stdout` — строка, полученная из каждого output chunk через `String(chunk)`; SHA-256 вычисляется уже по декодированной строке. **Условие:** directory private path или бинарное/разрезанное между chunks UTF-8 содержимое. Первое делает поддерживаемый сценарий непроверяемым, второе не доказывает обещанное байтовое равенство и может дать ложное совпадение/расхождение. Check round-trip моделирует текстовый файл.

**Рекомендация:** сравнивать байтовые хеши на target; для каталога строить детерминированный manifest из относительных путей, типов и содержимого, включая случаи empty/missing.

### P2-05 — Backup делает pause раньше блока компенсации

**Evidence:** [backup.ts:134](../tools/framework/commands/lifecycle/backup.ts#L134), [backup.ts:140](../tools/framework/commands/lifecycle/backup.ts#L140), [backup.ts:156](../tools/framework/commands/lifecycle/backup.ts#L156), [backup.ts:160](../tools/framework/commands/lifecycle/backup.ts#L160), [backup.ts:172](../tools/framework/commands/lifecycle/backup.ts#L172), [recipe/index.ts:83](../tools/framework/commands/management/recipe/index.ts#L83).

Gateway ставится на паузу до `try/finally`; перечисление работающих recipe stacks и quiesce происходят тоже до него. **Условие:** после успешного pause inventory/probe или lifecycle wrapper выбрасывает ошибку (например, transport вызов `stack.isRunning` отвергается). Путь к `runtime.start` в `finally` не достигается, и прежде работающий gateway остаётся остановленным. Новые lifecycle hooks расширили этот промежуток.

**Рекомендация:** включить каждый await после успешного pause в компенсационную область; хранить исходное состояние и объединять ошибки операции/возобновления без потери первичной причины.

### P2-06 — Failed restore откатывает data/ledger, но не исходное состояние gateway

**Evidence:** [restore.ts:247](../tools/framework/commands/lifecycle/restore.ts#L247), [restore.ts:298](../tools/framework/commands/lifecycle/restore.ts#L298), [restore.ts:305](../tools/framework/commands/lifecycle/restore.ts#L305), [restore.ts:332](../tools/framework/commands/lifecycle/restore.ts#L332), [restore.ts:374](../tools/framework/commands/lifecycle/restore.ts#L374).

При отказе post-extract validation, импорта history или `ensureDataDirs` catch восстанавливает старое дерево и ledger, затем выбрасывает ошибку. Он не проверяет, работал ли gateway до `stop`, и не возвращает его. **Условие:** direct restore существующего работающего экземпляра завершается отказом после остановки. Данные могут быть возвращены, а сервис остаётся выключенным. Это остаток компенсации P2-02 round 4, который новые проверки data/ledger не охватывают.

**Рекомендация:** зафиксировать исходное состояние перед stop и компенсировать его на каждом отказе после stop; отдельно сообщать, если компенсация не удалась.

### P2-07 — Recipe lifecycle пока не даёт согласованный snapshot/restore

**Evidence:** [backup.ts:151](../tools/framework/commands/lifecycle/backup.ts#L151), [backup.ts:159](../tools/framework/commands/lifecycle/backup.ts#L159), [recipe/lifecycle.ts:50](../tools/framework/commands/management/recipe/lifecycle.ts#L50), [recipe/lifecycle.ts:107](../tools/framework/commands/management/recipe/lifecycle.ts#L107), [recipe/lifecycle.ts:127](../tools/framework/commands/management/recipe/lifecycle.ts#L127), [restore.ts:335](../tools/framework/commands/lifecycle/restore.ts#L335).

Обычный backup теперь вызывает quiesce/resume, но отсутствие, ошибка или timeout quiesce только предупреждаются; архивирование продолжается. Проигравший timeout Promise продолжает работать и может остановить sidecar уже во время или после tar, не попадая в список для resume. `leaveStopped` вовсе пропускает hooks, а restore по-прежнему лишь предупреждает о прежних bind mounts. **Условие:** recipe пишет в data root или её hook задерживается/отказывает. Backup может быть несогласованным, restore — показывать разные поколения данных, sidecar — остаться остановленным. Это частичная реализация P2-12 round 6.

**Рекомендация:** предусмотреть строгий режим, который отказывает при невозможности quiesce; сделать timeout управляемым состоянием с обязательной компенсацией; координировать rebind/restart участников при restore.

### P2-08 — Чтение archive source всё ещё решается проверкой writable

**Evidence:** [archive.ts:422](../tools/framework/service/archive.ts#L422), [archive.ts:423](../tools/framework/service/archive.ts#L423), [archive.ts:536](../tools/framework/service/archive.ts#L536), [datadir.ts:38](../tools/framework/runtime/datadir.ts#L38), [datadir.ts:57](../tools/framework/runtime/datadir.ts#L57).

`privilegePrefixFor` теперь спрашивает source paths отдельно от destination, однако для обоих вызывает `sudoFor`, который проверяет `test -w`. **Условие:** текущая identity может писать в source, но не читать его, либо читать, но не писать. В первом случае tar/read запускается без нужной привилегии; во втором требуется sudo без необходимости. Исправление P2-05 round 6 решило порядок выбора, но не само различение capability.

**Рекомендация:** выбирать privilege по нужной операции: read/search для источника, write/search для destination, смену владельца — по identity/capability; проверять отказ до частичного archive publish.

### P2-09 — MCP `recover-env` всё ещё требует Context, который команда должна восстановить

**Evidence:** [cli.ts:168](../tools/framework/entry/cli.ts#L168), [mcp-server.ts:84](../tools/framework/integration/mcp-server.ts#L84), [mcp-server.ts:90](../tools/framework/integration/mcp-server.ts#L90), [openclawCommands.management.ts:223](../tools/framework/commands/interface/groups/openclawCommands.management.ts#L223).

CLI dispatch теперь отправляет `recover-env` в recovery-first bootstrap до `createContext`. MCP tool зарегистрирован той же декларацией, но его dispatcher всегда создаёт полный Context до вызова `command.run`. **Условие:** из `.env` исчез `OC_DATA_DIR` и клиент вызывает recovery через MCP. Парсер настроек отказывает раньше команды; выставленный в MCP `adopt-runtime` ситуацию не меняет. P2-10 round 6 закрыта для CLI и остаётся для MCP.

**Рекомендация:** общий pre-context dispatch для команд восстановления в обоих интерфейсах; проверять путь через реальные CLI и MCP dispatchers с неполным env.

### P2-10 — Неопределённый UID снимает host root consent gate

**Evidence:** [host/contexts.ts:124](../tools/framework/commands/interface/host/contexts.ts#L124), [host/contexts.ts:127](../tools/framework/commands/interface/host/contexts.ts#L127), [host/index.ts:88](../tools/framework/commands/interface/host/index.ts#L88), [host/index.ts:97](../tools/framework/commands/interface/host/index.ts#L97), [host/index.ts:114](../tools/framework/commands/interface/host/index.ts#L114).

Effective identity теперь проверяется для known contexts; если `id -u` отвергнут или вернул непригодный ответ, probe возвращает `undefined`. `host` оставляет `arrivesAsRoot=false` и запускает команду без root-флагов. **Условие:** identity probe недоступен, но произвольная команда исполнима в root-login/уже-root context. Отсутствие ответа трактуется как разрешение, поэтому остаток P2-11 round 6 всё ещё нарушает заявленное двойное согласие.

**Рекомендация:** fail closed для host execution, пока effective identity не доказана; если диагностический probe невозможен, отказать с причиной до запуска команды.

### P2-11 — Recovery выбирает первый контейнер из `docker ps --all`

**Evidence:** [recover-env/bootstrap.ts:56](../tools/framework/commands/recover-env/bootstrap.ts#L56), [recover-env/bootstrap.ts:68](../tools/framework/commands/recover-env/bootstrap.ts#L68), [recover-env/bootstrap.ts:83](../tools/framework/commands/recover-env/bootstrap.ts#L83), [recover-env/facts.ts:93](../tools/framework/commands/recover-env/facts.ts#L93).

Pre-context recovery фильтрует по project/service labels, просит `--all` и inspect делает лишь для первой строки. `connectionFactsFromInspect` правильно отвергает остановленный контейнер. **Условие:** под этими labels сохранился остановленный контейнер, перечисленный раньше работающего. Recovery сообщает «не работает/не найден», хотя живой источник фактов есть. Проверка существующего dispatcher покрывает однозначный ответ, не несколько кандидатов.

**Рекомендация:** выбирать только running candidates или осмотреть весь список до первого доказанно работающего; неоднозначные несколько running containers сообщать явно.

### P2-12 — Вычисляемый relative import не входит в версию hook graph

**Evidence:** [recipe/index.ts:133](../tools/framework/commands/management/recipe/index.ts#L133), [recipe/index.ts:170](../tools/framework/commands/management/recipe/index.ts#L170), [recipe/index.ts:199](../tools/framework/commands/management/recipe/index.ts#L199), [recipe/index.ts:202](../tools/framework/commands/management/recipe/index.ts#L202), [recipe/hook-loader.ts:26](../tools/framework/commands/management/recipe/hook-loader.ts#L26).

Новый loader исправил temp cache, package origin и literal relative imports. Но checksum scanner находит dynamic import только со строковым literal. **Условие:** hook вычисляет допустимый relative specifier во время исполнения. Изменение такого dependency не меняет checksum entry, `importHookModule` возвращает ранее cached hook; long-lived MCP продолжает старый код. Даже literal specifier с query не читается scanner как файловый путь и не получает новую метку в resolve hook. Это узкий остаток freshness-контракта, не возврат старого temp-cache дефекта.

**Рекомендация:** определить поддерживаемый граф импортов и отвергать формы, которые невозможно версионировать, либо использовать механизм загрузки/инвалидации, отслеживающий фактические module resolutions.

### P2-13 — Принятый native Windows data path даёт неверные соседние каталоги

**Evidence:** [env.ts:153](../tools/framework/core/env.ts#L153), [env.ts:185](../tools/framework/core/env.ts#L185), [env.ts:212](../tools/framework/core/env.ts#L212), [env.ts:217](../tools/framework/core/env.ts#L217), [env.ts:69](../tools/framework/core/env.ts#L69), [archive.ts:405](../tools/framework/service/archive.ts#L405).

`assertSafeDataDir` намеренно принимает Windows drive path с обратными слешами, но `parentOfData`, `locksDir` и `dataDirParent` ищут только `/`. **Условие:** `OC_TARGET_LOCATION=local` на Windows и native backslash path, который валидатор признал допустимым. Backup/snapshot/lock/restore path вычисляется из неправильного parent, так что операции адресуют не соседние с data root каталоги. Это отдельный функциональный дефект от CI coverage.

**Рекомендация:** вычислять path components библиотекой целевой платформы или строго канонизировать accepted форму перед использованием; единый нормализованный путь применять во всех lifecycle readers/writers.

## P3 — проверка покрытия

### P3-01 — Windows CI list уже не включает три новых check-файла

**Evidence:** [ci.yml:42](../.github/workflows/ci.yml#L42), [ci.yml:99](../.github/workflows/ci.yml#L99), [ci.yml:199](../.github/workflows/ci.yml#L199), [recipe-lifecycle-hooks.check.ts:1](../tools/checks/integration/recipe/recipe-lifecycle-hooks.check.ts#L1), [recover-env-dispatch.check.ts:1](../tools/checks/runtime/connection-facts/recover-env-dispatch.check.ts#L1), [reconcile-history.check.ts:1](../tools/checks/security/private-paths-ledger/reconcile-history.check.ts#L1).

Windows job запускает hand-maintained список. Сравнение этого списка с `rg --files tools/checks -g '*.check.ts'` показывает пять отсутствующих файлов: два явно исключены как WSL-bound в комментарии CI, а три новые файла выше не перечислены и не классифицированы. **Условие:** regression проявляется только на Windows в новом check. Linux job её не видит, Windows job файл не запускает. Publish Actions теперь закреплены SHA; прежний P3-01 round 6 частично исправлен, но реальный Windows/WSL runtime gate по-прежнему отсутствует. Классификация трёх новых файлов как Windows-safe этим чтением не доказана.

**Рекомендация:** автоматически сверять inventory всех checks с Windows include/exclude и явной причиной исключения; отдельно запускать WSL/Docker-dependent subset на оснащённом runner.

## Статус прежних находок в этом снимке

Статус означает проверку механизма по исходникам и существующим checks; ни один regression здесь не исполнялся. Новые условия выше не переименовывают полностью исправленные старые случаи в «открытые» без совпадения механизма.

| Отчёт | Исправлено по коду | Остаётся частично или открыто |
| --- | --- | --- |
| XA 2026-09-21 | P1-01/02, P2-01/02/03/05, P3-01/02/03: строгий recipe reader, literal tar exclusions, private helper, env delivery, lock для hooks, dry-run guard, интерфейс и документация. | P2-04: effective-root gate расширен, но unknown UID допускает команду — текущая P2-10. |
| XA round 2 | P1-01/03, P2-01/02/03/05/06, P3-01: archive/layout checks, portable carriers, normalized private write, root-symlink backup, Context refresh, path boundary, Linux checks и structured MCP ответы. | P1-02: target history подхватывается архиватором, прямой verify — P1-02. P2-04: restore sidecars — P2-07. |
| XA round 3 | P1-01/03/04, P2-01/02/03/05/06: resolved alias policy, deploy inventory, restore layout privilege, precise ledger, внутрипроцессная сериализация, apply env, MCP redaction, egress deadline. | P1-02: target-only history в direct verify — P1-02. P2-04: literal hook graph обновляется, вычисляемый import — P2-12. |
| XS round 4 | P1-01/02/03/04/05, P2-04/05, P3-01: root ownership без recursive chown, isolated smoke, prompt walker, link-chain resolver, checkout scan, readiness и strict ledgers, manifest validation. | P2-01: archive reconciles target history, direct verify — P1-02. P2-02: data/ledger rollback есть, сервис — P2-06. P2-03: lock race — P2-02. P2-06: computed hook import — P2-12. P3-02: Windows/WSL gate — P3-01. |

Для непосредственного предшествующего XXA round 6 статус указан по каждому пункту:

| Round 6 | Статус в этом снимке |
| --- | --- |
| P1-01 smoke менял live data | Исправлено: full backup восстанавливается в scratch root; новые witness-ошибки — P2-03/04. |
| P1-02 provisioning через target symlink | Исправлено для проверяемых point-in-time путей: `assertTargetContained` вызывается до writes/deletes; concurrent replacement границы не доказано. |
| P1-03 private staging | Исправлено: archive exclusions и verifier запрещают staging marker families. |
| P1-04 target-only privacy history | Частично: `createArchive` согласует history; прямой `verify` — P1-02. |
| P1-05 symlink walk root `agent/` | Исправлено: root canonicalized и проверен до readdir. |
| P1-06 destructive deploy root | Частично: root validation и marker есть, но первый mirror удаляет marker — P2-01. |
| P1-07 deploy tracked bytes и recipes root | Исправлено по коду: status/committed blob identity и top-level recipes scan. |
| P1-08 общий temp hook cache | Исправлено: hook loader импортирует real URL; отдельный freshness edge — P2-12. |
| P1-09 recursive ownership data root | Исправлено: canonical ancestry, provenance marker и non-recursive ownership; restore preflight — P1-01. |
| P2-01/02 hook package origin и cycles | Исправлено: real module location и native ESM graph вместо копирования в temp. |
| P2-03 takeover lock | Открыто: transient vacant path — P2-02. |
| P2-04 повторный full backup | Исправлено: target history публикуется atomic replace и пропускает identical bytes. |
| P2-05 read/chown capability | Частично: fixed-owner chown проверяет identity, source/destination перечислены; read всё ещё использует writable probe — P2-08. |
| P2-06 smoke после pause | Исправлено для smoke: initial state и compensation; прямые backup/restore имеют отдельные пробелы P2-05/06. |
| P2-07 archive link resolver | Исправлено для прежнего случая: segment-by-segment resolution; profile-name mismatch — P1-03. |
| P2-08 strict control ledgers | Исправлено: preflight до live changes, atomic publish markers. |
| P2-09 readiness | Исправлено: full service inventory, frozen required set, grace и bounded probe. |
| P2-10 recovery dispatch | Частично: CLI pre-context исправлен, MCP — P2-09. |
| P2-11 host root consent | Частично: effective identity probe есть, unknown UID — P2-10. |
| P2-12 backup/restore recipe lifecycle | Частично: best-effort backup hooks есть, restore и timeout compensation — P2-07. |
| P2-13 secret env serialization | Исправлено относительно собственного parser: общий serializer вызывается writers; поведение внешних consumers здесь не проверялось. |
| P3-01 Windows gate/publish pins | Частично: publish Actions закреплены SHA, Windows subset добавлен; WSL/Docker gate и сверка нового inventory — P3-01. |
| P3-02 readiness docs | Исправлено: README и общая command/MCP description описывают schema и failure path. |

Приоритет принятия: закрыть обе независимые дыры `verify` и preflight физического data root; сохранить deploy marker после mirror и восстановить исключительность lock takeover; затем исправить lifecycle compensation и coverage. После изменений нужны целевые проверки на поддерживаемых платформах и штатные CI gates. **В этом раунде они не запускались.**
