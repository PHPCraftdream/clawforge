# Ревью ClawForge — XXA, раунд 6, 2026-09-23

## Результат

**24 актуальные находки: 9 × P1, 13 × P2, 2 × P3. P0 этим аудитом не установлены.**

P1 — существенный риск потери/раскрытия данных, нарушения границ записи или исполнения;
исправить до релиза. P2 — ошибка поддерживаемого сценария или неполная защитная гарантия.
P3 — пробел документации, проверок или сопровождения. Приоритет не означает, что проблема
эксплуатировалась: ниже отдельно указаны условия и ограничения каждого вывода.

Исправления прошлых раундов заметно улучшили строгие readers, приватные пути, MCP redaction
и согласование Context. Однако новый снимок пока нельзя считать готовым к релизу:
`smoke` всё ещё восстанавливает неполный профиль поверх рабочего дерева; часть приватных
байтов может обходить inventory; новый загрузчик hooks меняет семантику модулей и доверяет
общему временному каталогу. Несколько исправлений закрывают только проверенное тестом
расписание или конкретную форму пути.

## Проверенная версия и границы

Аудит выполнен в отдельном git worktree от
`3c75e939d001b5ae7f481af6b8c9783ad6165fe4`. В него перенесён снимок текущего checkout:
**36 изменённых tracked-путей, включая удаление, и 7 новых check-файлов**. Исходный HEAD,
binary diff и копии новых файлов сохранены отдельно. Основной checkout не редактировался.

SHA-256 binary diff относительно HEAD:
`f649e17de703d9c7788e2317238b9c6c6dd5b770308fecead7f620b5989cd460`.

Идентичность 253 существующих source/doc/config-файлов проверенного снимка без этого отчёта:
`99545aa0ae3076a5a1c808f2dc4d065ba10419e6483350d28219ad0f27edbf04`.
Метод: уникальные существующие файлы из `git ls-files --cached --others --exclude-standard`,
отсортированные по пути; SHA-256 последовательно получает UTF-8 путь, NUL, lowercase hex
SHA-256 содержимого и LF. Игнорируемые зависимости, deployment state и build output не входят.

**Ссылки на строки относятся к этому снимку, включая незакоммиченные исправления,
а не только к базовому HEAD.** Коммит отчёта не включает продуктовый diff.

Это **статический defensive review**. Прочитаны критические потоки lifecycle, архивов,
privacy history, secret delivery, locks, hooks, provisioning, deploy, set install/rollback,
MCP, recovery, host execution и CI; существующие checks использованы для анализа покрытия.
Сопоставлены три XA-отчёта и XS round 4. Выполнялись только чтение исходников, git-операции
для изоляции/снимка/отчёта и вычисление идентичности файлов.

**Тесты, typecheck, lint, build, pack, npm audit и GitHub Actions намеренно не запускались.**
Не запускались host engine, рабочее приложение, контейнеры, backup/restore/deploy, сетевые
проверки или воспроизведения атак. Реальные секреты не читались. Нет утверждения о зелёных
проверках данного снимка, отсутствии внешних advisories или фактической эксплуатации.

## Статус находок прошлых раундов

«Исправлено по коду» означает, что прежний механизм закрыт в изученном снимке; это не
заменяет регрессионный прогон. Остаточные риски ниже входят в общие 24 находки, повторно
за каждое упоминание в таблицах они не считаются.

### XA от 2026-09-21

| Исходный пункт | Состояние |
| --- | --- |
| P1-01: broken recipe manifest отключал privacy policy | Исправлено по коду: security reader не проглатывает ошибку существующего manifest. Потеря operator-side history — отдельный остаточный P1-04 ниже. |
| P1-02: literal privatePaths становился tar glob | Исправлено по коду: literal-пути экранируются. Соседние временные private-файлы не покрыты: P1-03. |
| P2-01: private helper пропускал `..` | Исправлено по коду: нормализация, проверка сырых ancestors, использование проверенной цели. Это не распространяется на target writes provisioning: P1-02. |
| P2-02: restart после repo-env delivery сохранял старый environment | Исправлено по коду для `secrets --apply`: reconcile перечитывает env, затем проверяется environment. Обычный restart отдельно сохраняет свою файловую семантику. |
| P2-03: mutating recipe hooks обходили lock | Исправлено по коду: общий guard покрывает действия. Takeover ещё не обеспечивает исключительность: P2-03 ниже. |
| P2-04: неявный root у host engine | Частично: Docker Desktop engine требует два флага; effective UID остальных contexts не проверяется — P2-11. |
| P2-05: dump + dry-run перезаписывал декларацию | Исправлено по коду: сочетание отвергается до записи. |
| P3-01: MCP import не выражал новое имя | Исправлено по коду: `new-name` присутствует в общей декларации аргументов. |
| P3-02: private-file policy отсутствовала в инструкции | Исправлено для `privatePaths`/`privateFiles`: README и help их описывают. Новый readiness-контракт ещё не описан — P3-02 ниже. |
| P3-03: специфичные имена в framework import | Исправлено в рассматриваемой политике: generic sensitive-name rule + app-owned `privateFiles`. |

### XA, раунд 2

| Исходный пункт | Состояние |
| --- | --- |
| P1-01: restore действовал через внешние ссылки | Частично: layout проверяется, простые link chains теперь учитываются. POSIX resolution при `..`/неканонических путях ещё расходится — P2-07. |
| P1-02: удаление декларации снимало runtime privacy | Частично: локальный ledger сохраняется. Target-only history не читается при migrate/share — P1-04. |
| P1-03: privateFiles обходился другими carriers | Частично: общий walker внедрён, но его `walkRoot` и deploy inventory имеют пробелы — P1-05/P1-07. |
| P2-01: проверялся один private path, записывался другой | Исправлено по коду: запись идёт по нормализованной проверенной цели. |
| P2-02: symlink data root давал пустой успешный backup | Исправлено для непосредственной ссылки и пустого archive content. Это не подтверждает безопасность recursive ownership — P1-09. |
| P2-03: apply продолжал со старым Context | Исправлено внутри `runSteps`: после env/secrets Context обновляется, смена координат останавливает оставшиеся шаги. Вход recovery остаётся ограничен — P2-10. |
| P2-04: sidecars не согласованы с backup/restore | Открыто: добавлены предупреждения, lifecycle участия нет — P2-12. |
| P2-05: private path был неограниченным prefix | Исправлено по коду: equality или slash-boundary. |
| P2-06: POSIX security checks пропускались в Linux CI | Исправлен выбор LocalTransport на POSIX. Это не решает отдельный Windows runtime gate — P3-01. |
| P3-01: recipe outputSchema не выполнялся частью действий | Исправлено по коду: все успешные действия возвращаются через общий structured envelope. |

### XA, раунд 3

| Исходный пункт | Состояние |
| --- | --- |
| P1-01: private content переносился под внутренним alias | Исправлено для дочерних entries общего walker. Сам корень agent walk не проверяется — P1-05. |
| P1-02: privacy history не приезжала с full restore | Добавлены publish/import, но повторный publish использует exclusive create — P2-04; adopt-existing-target для migrate/share не покрыт — P1-04. |
| P1-03: deploy пропускал sensitive names | Частично: recipes/config сканируются, checkout scan добавлен. Tracked-path exemption и файлы прямо под recipes root оставляют обход — P1-07. |
| P1-04: restore проверял layout меньшими правами | Исправлено по коду для post-extract layout: используются согласованные privileges и проверка доступности parent. Отдельные owner-dependent операции остаются P2-05. |
| P2-01: private write исключал весь общий parent | Исправлено по коду: записываются exact path и объявленная boundary. Побочный staging за exact boundary — P1-03. |
| P2-02: Promise.all private writes терял ledger entries | Исправлено внутри одного процесса: serialized read/merge/write. Это не межпроцессный CAS и не заменяет instance lock. |
| P2-03: apply отменял намеренную правку `.env` | Исправлено по коду: diverged facts advisory, принятие runtime явно. Новый флаг не представлен в MCP — P2-10. |
| P2-04: MCP держал старый hook | Частично: граф теперь версионируется, но новый способ загрузки создаёт P1-08 и P2-01/P2-02. |
| P2-05: успешные MCP-ответы обходили redaction | Исправлено для зарегистрированных значений: маскируются text/structured, исключение явно обозначено `exportsSecrets`. |
| P2-06: egress не имел общего deadline | Исправлено по коду: endpoint deadline включает DNS/body, внешний transport timeout добавлен. Исполнение здесь не проверялось. |

### XS, раунд 4

| Исходный пункт | Состояние |
| --- | --- |
| P1-01: опасный OC_DATA_DIR и recursive chown | Частично: `/`, top-level и ненормализованные строки отвергаются. Допустимая глубина ещё не доказывает владение деревом — P1-09. |
| P1-02: smoke восстанавливал live state с окном записи | Частично: появился outer lock и `leaveStopped`. Используется неполный migrate profile и нет восстановления service state при ошибке — P1-01/P2-06. |
| P1-03: agent prompt loader обходил portable policy | Исправлен обычный file inventory; root-symlink вариант сохраняется — P1-05. |
| P1-04: archive validator не разрешал link chains | Исправлены простые цепочки. Segment resolution и canonical aliases неполны — P2-07. |
| P1-05: checkout deploy не проходил sensitive policy | Частично: scan добавлен, но whitelist по tracked имени не проверяет отправляемые байты; recipes-root entries тоже пропущены — P1-07. |
| P2-01: пустой локальный ledger удалял target history | Исправлен один сценарий отсутствующего local file при full backup. Общий импорт до migrate/share и надёжное представление forget отсутствуют — P1-04; exclusive republish — P2-04. |
| P2-02: failed restore не откатывал data/ledger | Добавлены cleanup чистого target и откат содержимого ledger. Отсутствие ledger не восстанавливается как отсутствие: это может создать ложное свидетельство forget — P1-04. |
| P2-03: два break-lock входили в critical section | Открыто при другом допустимом interleaving: новый directory можно переименовать вторым caller — P2-03. |
| P2-04: install сообщал running без readiness | Частично: declared services/health теперь проверяются. Default inventory, grace и общий deadline неполны — P2-09. |
| P2-05: control-ledger error становился empty | Частично: strict writers добавлены, но строгая проверка приходит после live mutation и запись остаётся in-place — P2-08. |
| P2-06: imports helper hooks оставались stale | Новый loader подхватывает простой acyclic relative import, но нарушает package origin и зацикливается на cycles — P2-01/P2-02; cache security — P1-08. |
| P3-01: malformed ports/variables ломали каталог | Исправлено для найденных shapes: ports/variables валидируются, broken manifests перечисляются отдельно. |
| P3-02: Windows runtime CI и floating Actions | Частично: Windows compile/package job и SHA в CI добавлены; runtime tests и publish workflow остаются вне исправления — P3-01. |

## P1-01 — Smoke round-trip удаляет приватное runtime-состояние даже при успешной проверке

**Evidence:** [smoke.ts:239](../tools/framework/commands/lifecycle/smoke.ts#L239),
[state.ts:273](../tools/framework/commands/lifecycle/state.ts#L273),
[archive.ts:119](../tools/framework/service/archive.ts#L119),
[state.ts:466](../tools/framework/commands/lifecycle/state.ts#L466),
[restore.ts:248](../tools/framework/commands/lifecycle/restore.ts#L248).

`roundTripCheck` вызывает `pull(ctx, [], { leaveStopped: true })`. Пустой argv выбирает
`migrate`: из архива исключаются все `privatePaths`, а также часть runtime metadata.
Следующий `push --force` заменяет весь data root этим архивом. Отдельный secrets sidecar
возвращает только `config/.env`, не произвольные recipe-private files. Check сравнивает
один `SMOKE-MARKER.md` и способен сообщить успех после потери другой части состояния.

**Условие и влияние:** у экземпляра есть generated credentials/state под `privatePaths`.
После обычного smoke их нет в активном data root; старые байты остаются только в
`.replaced-*`, а sidecars могут продолжать держать старые bind mounts. Это обратимо вручную,
но не является byte-identical round-trip и ломает последующий запуск. Outer lock не делает
неполный профиль полным. В декларации `smoke` также нет `destructive` gate.

**Рекомендация:** проверять restore в изолированном временном instance/root по полному backup.
Если live DR-проверка нужна отдельно, явно подтвердить её и сохранять весь набор данных
и lifecycle участников. Проверять инвариант сохранности inventory, включая private paths.

**Покрытие:** [smoke.check.ts:248](../tools/checks/runtime/lifecycle/smoke.check.ts#L248)
моделирует возврат marker; сохранение private subtree этим не доказано.

## P1-02 — Provisioning пишет через symlinks в target workspace без проверки границ

**Evidence:** [reconcile.ts:95](../tools/framework/commands/management/provision-agent/reconcile.ts#L95),
[reconcile.ts:104](../tools/framework/commands/management/provision-agent/reconcile.ts#L104),
[reconcile.ts:123](../tools/framework/commands/management/provision-agent/reconcile.ts#L123),
[transport.ts:347](../tools/framework/runtime/transport.ts#L347),
[transport.ts:480](../tools/framework/runtime/transport.ts#L480).

`syncRecipeFiles` и `writeWorkspacePromptFiles` проверяют source inventory, но target path
передают прямо в `mkdirp`/`writeFile`. Существующая ссылка с именем нужного файла не является
stale и не заменяется безопасным rename. Node `writeFile` и WSL `tee` следуют конечной
ссылке; ссылки в directory ancestors тоже не проверяются.

**Условие и влияние:** процесс внутри instance может оставлять ссылки в своём workspace,
после чего оператор выполняет provisioning. Ссылка может называться в координатах host
и указывать на доступный оператору файл вне data mount. Framework перезапишет его своими
правами, хотя instance не имел прямого доступа к этому host path. Возможна и случайная
порча внешнего дерева после ручного связывания workspace каталогов.

**Рекомендация:** перед target mutation проверять физическое containment всех ancestors;
файлы публиковать атомарной заменой, не следуя конечной ссылке. Для hostile concurrent
writer нужны descriptor-relative операции/no-follow, а не только разнесённые `realpath`
и запись. Применить одинаковый контракт к prompt writes и mirror deletion/shape changes.

**Покрытие:** source portable-policy regressions не проверяют уже существующий target alias.
Нужны отдельные сценарии file link и directory link на одноразовом target.

## P1-03 — Остатки private staging выходят за exact-file privacy boundary

**Evidence:** [private-config.ts:173](../tools/framework/security/private-config.ts#L173),
[private-config.ts:180](../tools/framework/security/private-config.ts#L180),
[transport.ts:47](../tools/framework/runtime/transport.ts#L47),
[archive.ts:82](../tools/framework/service/archive.ts#L82),
[verify.ts:52](../tools/framework/commands/lifecycle/verify.ts#L52).

Для декларации одного файла helper регистрирует только этот файл/boundary, затем пишет
соседний `<file>.clawforge-private-<random>`. Remote private writer создаёт ещё один
временный sibling. Если процесс прерван до rename/cleanup или cleanup не удался, остаются
реальные private bytes с другим именем. Literal exclusion не покрывает этот sibling.
Base exclusions и verifier знают только другую семью: `config/.env.clawforge-*`.

**Условие и влияние:** exact-file `privatePaths` в публичном subtree и прерванная/неудачная
запись. Следующий migrate способен включить staging file; под `workspace/` он проходит
share allow-list. Скан известных provider/identity значений не является сканом произвольных
recipe credentials. Права `600` не препятствуют штатному архиватору переносить эти байты.

**Рекомендация:** хранить staging в отдельном гарантированно приватном корне с тем же
filesystem для rename либо включить весь контролируемый temporary family в архивную
и verify-политику. Privacy boundary должна действовать с первого записанного байта,
включая crash leftovers, без расширения защиты на публичных соседей.

**Покрытие:** требуется сценарий остаточного staging для exact-file declaration после
неуспешной публикации; happy-path cleanup эту гарантию не доказывает.

## P1-04 — Migrate/share не учитывают privacy history, сохранившуюся только на target

**Evidence:** [archive.ts:482](../tools/framework/service/archive.ts#L482),
[recipe.ts:385](../tools/framework/service/recipe.ts#L385),
[private-paths-ledger.ts:261](../tools/framework/security/private-paths-ledger.ts#L261),
[restore.ts:276](../tools/framework/commands/lifecycle/restore.ts#L276),
[restore.ts:312](../tools/framework/commands/lifecycle/restore.ts#L312).

`installedRecipePrivatePaths()` объединяет только текущие manifests и operator-side ledger.
Target history импортируется при restore или при `publishPrivatePathsHistory`, который
вызывается только для full backup. Новый deployment, подключённый к существующим данным,
может сразу вызвать migrate/share, не выполнив ни restore, ни full backup.

**Условие и влияние:** локальный ledger и старая декларация потеряны/удалены, а target
по-прежнему содержит private files и свою history. Исключения пусты; в разрешённом share
subtree файл снова считается публичным. Наличие на target готовой security history не
помогает, поскольку соответствующий reader её вообще не спрашивает.

Исправление full-adoption тоже различает состояния ненадёжно: наличие пустого local file
считается доказательством explicit forget. Но failed restore всегда восстанавливает
`ledgerBefore` записью, даже если ledger до операции отсутствовал; это может создать
пустой файл без forget. Если новый local ledger уже содержит другие записи, target history
вообще не объединяется с ним. Удаление/утрата history и intentional forget должны быть
разными состояниями протокола, а не выводом из существования файла.

**Рекомендация:** до любой операции, опирающейся на privacy, строго согласовывать обе копии;
хранить явное поколение/инициализацию и tombstone для забытых путей. Rollback обязан
восстанавливать и отсутствие файла. До согласования migrate/share должны отказывать.

**Покрытие:** новый тест adoption вызывает только `publishPrivatePathsHistory`;
непосредственный migrate/share из свежего operator folder не покрыт.

## P1-05 — Symlink в самом `agent/` обходит containment общего portable walker

**Evidence:** [recipe-portable-content.ts:140](../tools/framework/security/recipe-portable-content.ts#L140),
[recipe-portable-content.ts:152](../tools/framework/security/recipe-portable-content.ts#L152),
[recipe-portable-content.ts:195](../tools/framework/security/recipe-portable-content.ts#L195),
[recipe-portable-content.ts:221](../tools/framework/security/recipe-portable-content.ts#L221),
[declaration.ts:96](../tools/framework/commands/management/provision-agent/declaration.ts#L96).

Новый agent loader использует общий walker, но тот вызывает `realpath(walkRoot)` и сразу
начинает обход. Принадлежность самого `realWalkRoot` к `realRoot` не проверяется. Containment
дочернего `real` проверяется только когда сам child является symlink. Если `agent/` — ссылка
наружу, обычные файлы внешнего каталога попадают в inventory как обычные children.

**Условие и влияние:** recipe содержит ссылку `agent/` на другой каталог с подходящим
`config.json`/prompt-файлами. Private instructions/content внешнего дерева могут попасть
в provisioning, checksums и set artifact. Исправление отдельных prompt symlinks этого
варианта не закрывает. Это source boundary; target write boundary — отдельный P1-02.

**Рекомендация:** проверять containment и privacy самого walk root до `readdir`, а также
каждого resolved path независимо от типа Dirent. Ошибка root должна останавливать всех
carriers одинаково. Не считать ENOENT произвольного descendant доказательством отсутствия
всего bundle.

**Покрытие:** [agent-bundle-portable-content.check.ts:214](../tools/checks/integration/agent/agent-bundle-portable-content.check.ts#L214)
проверяет внешний symlink-файл внутри обычного `agent/`, но не symlink-корень самого walk.

## P1-06 — `deploy --path` допускает destructive mirror в произвольный существующий root

**Evidence:** [deploy.ts:304](../tools/framework/commands/management/deploy.ts#L304),
[deploy.ts:309](../tools/framework/commands/management/deploy.ts#L309),
[deploy.ts:450](../tools/framework/commands/management/deploy.ts#L450),
[deploy.ts:468](../tools/framework/commands/management/deploy.ts#L468).

Значение `--path` не проходит проверку абсолютности, нормализации, ширины root или ownership
marker. После обычного `mkdir -p` первая rsync выполняет `--delete` в этом каталоге.
Проверка `remoteRecipesPath` ограничивает только расположение recipes относительно
выбранного remoteApp, а не безопасность самого remote root.

**Условие и влияние:** опечатка/неверный destination с правами записи на remote. Можно выбрать
корень filesystem, общий каталог сервисов или текущий remote directory и удалить чужое
содержимое, не совпавшее с framework checkout. Это не удалённое получение прав: опасность —
неограниченный радиус штатной операции с уже имеющимися правами. MCP `confirm` подтверждает
команду, но не доказывает принадлежность destination.

**Рекомендация:** до любого remote изменения разрешать `--delete` только в созданном для
deployment каталоге с проверенным marker/identity; отдельно проверять canonical path,
symlink ancestors и пересечения с data/backups. Adoption существующего дерева должен быть
явной операцией с показом затрагиваемого inventory.

**Покрытие:** проверки installed-package отказа и recipesDir containment не покрывают
destructive framework destination. Live deploy здесь не выполнялся.

## P1-07 — Deploy whitelist по tracked имени и неполный recipes-root scan пропускают private files

**Evidence:** [deploy.ts:197](../tools/framework/commands/management/deploy.ts#L197),
[deploy.ts:51](../tools/framework/commands/management/deploy.ts#L51),
[deploy.ts:355](../tools/framework/commands/management/deploy.ts#L355),
[deploy.ts:366](../tools/framework/commands/management/deploy.ts#L366),
[deploy.ts:504](../tools/framework/commands/management/deploy.ts#L504).

Новый checkout scan считает любой sensitive path допустимым, если это имя есть в
`git ls-files`. Текущие байты tracked файла с index не сравниваются. Заполненный локальными
значениями tracked `.env.example` поэтому освобождается от проверки, а rsync отправляет
рабочую копию. Индексное имя доказывает только наличие пути в index, не ревью текущих байтов.

Отдельно recipes scan обходит только entries с `isDirectory()`. Файл вроде
`recipes/shared.secrets.env` или `.env.local` прямо в recipes root не попадает ни в один
обход; последующая rsync отправляет весь root. Её `EXCLUDES` не содержит этих generic
patterns. В monorepo этот root обычно находится под `apps/`, который checkout scan пропускает.

**Влияние:** privacy-обещание deploy всё ещё зависит от расположения одного и того же имени
и от git status. На remote уезжают значения, которые операция обещает оставить локально.

**Рекомендация:** сформировать один проверенный delivery inventory и отправлять именно
его. Template exception должен требовать совпадения отправляемых байтов с проверенным
content identity, а recipes root проверяться целиком, включая files и links на верхнем уровне.

**Покрытие:** нужны dirty tracked template и sensitive file непосредственно под recipes root;
untracked file в checkout subtree не представляет эти два сценария.

## P1-08 — Hook loader исполняет существующий файл из предсказуемого общего temp cache

**Evidence:** [management/recipe.ts:183](../tools/framework/commands/management/recipe.ts#L183),
[management/recipe.ts:221](../tools/framework/commands/management/recipe.ts#L221),
[management/recipe.ts:228](../tools/framework/commands/management/recipe.ts#L228),
[management/recipe.ts:247](../tools/framework/commands/management/recipe.ts#L247).

Cache называется `clawforge-hook-cache` под системным tmpdir, хотя комментарий называет его
per-process. Директории создаются без private mode/ownership проверки. Origin/checksum
делают имена предсказуемыми по исходнику. Если файл уже существует, `access` достаточно,
чтобы отказаться от записи своих bytes и затем импортировать существующий файл; его
содержимое, тип, владелец и digest не проверяются.

**Условие и влияние:** POSIX host с общим временным каталогом и другой локальный пользователь,
успевший занять cache root до владельца deployment. Он может подготовить доступные каталоги
и ожидаемый cache entry. Framework исполнит чужой JavaScript с правами оператора и доступом
к его Context/секретам. Это локальная условная атака, а не удалённая уязвимость любого
deployment; на private user temp граница угроз другая. Эксплуатация не воспроизводилась.

**Рекомендация:** отдельный непредсказуемый `mkdtemp` с `0700`, source files `0600`, exclusive
creation/no-follow и cleanup. Не доверять persistent cache entry только по его имени.
Если persistent cache нужен, проверять ownership, immutable content identity и atomic publish.

**Покрытие:** cross-recipe cache test проверяет разные исходные пути, но не чужое существующее
содержимое cache filesystem и не POSIX multi-user boundary.

## P1-09 — Глубина OC_DATA_DIR не доказывает безопасность recursive ownership

**Evidence:** [env.ts:156](../tools/framework/core/env.ts#L156),
[datadir.ts:107](../tools/framework/runtime/datadir.ts#L107),
[datadir.ts:131](../tools/framework/runtime/datadir.ts#L131),
[datadir.ts:145](../tools/framework/runtime/datadir.ts#L145).

Новая проверка отсекает `/` и один segment ниже root, но пропускает системные/общие
каталоги глубже: например, `/var/lib`. `ensureDataDirs` при отличающемся owner любого
стандартного пути всё ещё выполняет recursive chown всего dataDir к фиксированному UID/GID.
Нет marker, доказывающего, что дерево создано/принято именно этим deployment.

Дополнительно `test -L dataDir` проверяет только конечный компонент. Ссылка в одном из
parents может перенаправлять внешне глубокий путь в совершенно другое дерево. Canonical
root после разрешения ancestors не проверяется. Для существующих standard subdirectories
также нет bootstrap-аналога restore layout validation перед последующими действиями.

**Условие и влияние:** неверная настройка либо старый symlink layout плюс необходимые права
оператора/sudo. Bootstrap может изменить ownership другого приложения или системного
поддерева. Это оставшаяся часть XS P1-01, не утверждение о новых привилегиях.

**Рекомендация:** проверять canonical destructive root и принадлежность deployment до mkdir,
chown/chmod. Существующие широкие деревья не усыновлять автоматически; ownership менять
точечно для известных созданных объектов. Depth check оставить как дополнительный guard.

**Покрытие:** string rejection для `/` и непосредственный symlink root не проверяют общий
root глубины 2 и symlink ancestor. Изменение прав в ходе аудита не выполнялось.

## P2-01 — Копирование hook modules в temp ломает package imports и относительные assets

**Evidence:** [management/recipe.ts:118](../tools/framework/commands/management/recipe.ts#L118),
[management/recipe.ts:214](../tools/framework/commands/management/recipe.ts#L214),
[management/recipe.ts:224](../tools/framework/commands/management/recipe.ts#L224),
[management/recipe.ts:247](../tools/framework/commands/management/recipe.ts#L247),
[README.md:555](../README.md#L555).

Загрузчик переписывает только относительные import specifiers и исполняет copy из tmpdir.
Bare imports (`@clawforge/framework/private-config`, зависимости application) и `#imports`
сохраняются, но разрешаются уже относительно другого package scope, где нет app node_modules
и package.json. `import.meta.url`/`import.meta.dirname` тоже указывают на cache, а рядом
не скопированы шаблоны и другие assets. Даже неизменённый первый запуск hook меняет semantics.

**Условие и влияние:** обычный поддерживаемый рецепт импортирует публичный framework helper
или читает соседний файл относительно модуля. CLI/MCP install/verify/onboard завершаются
ошибкой разрешения пакета/файла; это не только проблема hot reload. Относительный import
самого framework source дополнительно переносит его package scope и module-local paths.

**Рекомендация:** сохранить native origin/package resolution. Для freshness использовать
изолированный runtime с явным Context bridge либо корректный loader, учитывающий module
origin, package imports, assets и полный синтаксис. Регулярного выражения и переноса файла
недостаточно для сохранения семантики ESM.

**Покрытие:** [recipe-hook-freshness.check.ts:223](../tools/checks/integration/agent/recipe-hook-freshness.check.ts#L223)
использует маленький relative helper без package imports/assets; это не installed consumer.

## P2-02 — Циклический relative import зависает на взаимном ожидании Promise

**Evidence:** [management/recipe.ts:201](../tools/framework/commands/management/recipe.ts#L201),
[management/recipe.ts:204](../tools/framework/commands/management/recipe.ts#L204),
[management/recipe.ts:216](../tools/framework/commands/management/recipe.ts#L216),
[management/recipe.ts:238](../tools/framework/commands/management/recipe.ts#L238).

`rewrittenCopyPath` проверяет memo раньше `inProgress`. При корректном ESM cycle A → B → A
повторный вызов для A возвращает ещё не завершённый Promise A из memo, поэтому проверка
`inProgress` вообще не достигается. A ждёт B, B ждёт A. Обещанная комментарием деградация
к исходному back-reference не происходит.

**Влияние:** recipe hook не запускается, MCP call не завершается, instance lock остаётся
занятым. В CLI незавершённый top-level await также может закончиться аварийным завершением
процесса с оставшимся lock. Это возникает из обычного циклического module graph без
вредоносного кода и без выполнения самой функции hook.

**Рекомендация:** корректно сохранять native ESM cycles либо явно отвергать их до захвата
длительного lifecycle lock. Проверка active traversal должна предшествовать ожиданию memo,
но одна перестановка ещё не решает module origin из P2-01.

**Покрытие:** существующая freshness regression проверяет acyclic helper graph; нужны cycle
с экспортируемыми функциями и ограниченный deadline ожидания отказа/результата.

## P2-03 — Takeover lock всё ещё допускает двух владельцев после повторного появления directory

**Evidence:** [instance-lock.ts:159](../tools/framework/runtime/instance-lock.ts#L159),
[instance-lock.ts:275](../tools/framework/runtime/instance-lock.ts#L275),
[instance-lock.ts:368](../tools/framework/runtime/instance-lock.ts#L368),
[takeover.check.ts:100](../tools/checks/runtime/convergence/instance-lock/takeover.check.ts#L100).

Atomic rename не доказывает, что caller переименовал тот же lock, который прочитал.
Допустимое расписание: B прочитал старый holder и остановился до `mv`; A переименовал старый
directory, создал новый lock и вошёл в body; B продолжил, переименовал уже новый directory
A, создал свой и тоже вошёл в body. Ни generation, ни inode/marker наблюдавшегося lock не
сравниваются. Это классическое повторное использование pathname после его удаления.

Отдельно release делает read holder и remove directory разными операциями: takeover между
ними позволяет старому release удалить новый lock. Проверка operationId до remove не
атомарна относительно смены owner.

**Условие и влияние:** конкурентные callers с `--break-lock` либо takeover одновременно с
release. Общая гарантия исключительности нарушается; сами флаги не сериализуют клиентов.

**Рекомендация:** отдельный атомарный takeover/release протокол с проверяемым поколением
именно наблюдённого owner, либо стабильная advisory lock identity, которая не исчезает при
rename. Повторять один только `mkdir` после безусловного `mv` недостаточно.

**Покрытие:** новый test освобождает быстрый lock до возобновления stalled caller. Он проверяет
отсутствующий directory, но не описанное расписание с ещё работающим быстрым body.

## P2-04 — Повторный full backup пытается заново exclusive-create существующую history

**Evidence:** [private-paths-ledger.ts:271](../tools/framework/security/private-paths-ledger.ts#L271),
[transport.ts:352](../tools/framework/runtime/transport.ts#L352),
[transport.ts:46](../tools/framework/runtime/transport.ts#L46),
[private-history-restore.check.ts:205](../tools/checks/runtime/private-history-restore.check.ts#L205).

`publishPrivatePathsHistory` при непустом ledger пишет конечный history path через
`writePrivateFile`. У реальных transports это **создание**, а не замена: LocalTransport
открывает `wx`, WSL/SSH публикуют через `ln -T` без замены. После первого full backup файл
существует и следующая публикация отказывает. Adoption существующей target history
приходит к тому же exclusive create уже занятого path.

**Влияние:** повторный full backup deployment с privacy history не доходит до создания
архива. Ошибка не зависит от изменения содержимого ledger. При отсутствии capability
fallback `writeFile` ведёт себя иначе, что дополнительно расходится между transports.

**Рекомендация:** атомарная приватная замена через уникальный sibling + rename с сохранением
старой history при ошибке, либо skip, если проверенные bytes уже совпадают. Не удалять
старую историю перед записью новой.

**Покрытие:** fake `writePrivateFile` в новом adoption test просто присваивает body и
перезаписывает существующее значение; он не соблюдает exclusive-create контракт настоящего
Transport. Нужны два последовательных full backup и republish после adoption на реальном
private writer в одноразовом дереве.

## P2-05 — Capability для чтения/chown ошибочно выводится из writable destination

**Evidence:** [archive.ts:496](../tools/framework/service/archive.ts#L496),
[state.ts:249](../tools/framework/commands/lifecycle/state.ts#L249),
[datadir.ts:45](../tools/framework/runtime/datadir.ts#L45),
[datadir.ts:88](../tools/framework/runtime/datadir.ts#L88).

В dirty snapshot `createArchive` снова выбирает privileges только по writable archive
destination. Это **регрессия относительно HEAD**: из `382b086` удалён отдельный privilege
probe защищённого `auth-secrets`. После `ensureDataDirs` он принадлежит UID 1000 и имеет
`0700`; оператор с другим UID может создавать backup, но не читать всё его содержимое.

В `loadSecrets` остаётся другой случай того же неверного вывода: staging принадлежит
создавшему его оператору и writable, поэтому обычный `runMaybePrivileged(... chown 1000:1000)`
не эскалирует. Владение файлом не даёт unprivileged UID права передать его UID 1000.
`ensureSecretsFile`/`ensureDataDirs` уже используют `needsOwnerEscalation`, `loadSecrets` — нет.

**Условие и влияние:** POSIX оператор с UID/GID, отличающимися от fixed container identity.
Backup или `secrets --apply`/snapshot push завершается permission error в штатной операции.
Это особенно касается CI/SSH hosts с другим первым пользователем.

**Рекомендация:** выбирать privileges отдельно по требуемой capability и всем source/destination
paths; сохранить HEAD read fix, распространить owner check на все handoff вызовы. Проверки
должны моделировать другого UID и недоступный private subtree, а не только writable root.

## P2-06 — Ошибка smoke после pause оставляет ранее работавший gateway остановленным

**Evidence:** [smoke.ts:226](../tools/framework/commands/lifecycle/smoke.ts#L226),
[smoke.ts:239](../tools/framework/commands/lifecycle/smoke.ts#L239),
[smoke.ts:250](../tools/framework/commands/lifecycle/smoke.ts#L250),
[backup.ts:209](../tools/framework/commands/lifecycle/backup.ts#L209),
[state.ts:486](../tools/framework/commands/lifecycle/state.ts#L486).

Новый `leaveStopped` подавляет restart в finally backup, в том числе когда создание архива
упало. `roundTripCheck` сохраняет body error и очищает marker, но не запоминает исходное
service state и не возвращает gateway в него. Любая ошибка pull, удаления marker или
push до start оставляет экземпляр остановленным. При успешном пути push, напротив,
безусловно стартует instance, даже если до smoke он был остановлен.

**Влияние:** acceptance-команда меняет доступность production при промежуточной ошибке;
очистка marker/lock создаёт видимость завершённой уборки, но service state не восстановлено.
Эта регрессия появилась при закрытии окна live writes, она отдельна от profile data loss.

**Рекомендация:** явный lifecycle owner всей транзакции с сохранённым initial state и
обязательным compensation после ошибок. При неуспешном restore сначала вернуть проверенное
дерево, затем согласованно восстановить состояние службы; объединять ошибки cleanup/recovery.

**Покрытие:** [smoke.check.ts:332](../tools/checks/runtime/lifecycle/smoke.check.ts#L332)
проверяет marker cleanup и release, но не возврат initial running/stopped state.

## P2-07 — Archive link resolver нормализует `..` раньше перехода через вложенный symlink

**Evidence:** [archive.ts:251](../tools/framework/service/archive.ts#L251),
[archive.ts:284](../tools/framework/service/archive.ts#L284),
[archive.ts:319](../tools/framework/service/archive.ts#L319),
[archive.ts:337](../tools/framework/service/archive.ts#L337).

Resolver сворачивает весь symlink target в массив сегментов, удаляя предыдущий segment
на `..`, и лишь после этого ищет links в новом path. POSIX разрешает промежуточный symlink
до следующего `..`. Поэтому target вида `b/../safe` неэквивалентен lexical `safe`, если `b`
сам является ссылкой. Из графа пропадает hop, который может выводить path наружу.

Дополнительно normalization удаляет только один начальный `./`; внутренние `./`, повторные
slashes и варианты directory suffix остаются разными map keys, хотя filesystem считает
их одним path. `writesThrough` тоже использует raw prefix. Исправление простых A → B цепей
не доказывает эквивалентность реальному разрешению пути.

**Влияние и граница:** security gate может разрешить structurally unsafe layout или не
обнаружить цикл. **Фактическая запись наружу здесь не доказана**: она дополнительно зависит
от защиты используемого tar. Поэтому это P2 валидации, а не заявление о подтверждённой
tar exploitation. Ничего не распаковывалось.

**Рекомендация:** segment-by-segment resolution в правильном порядке, canonical aliases,
однозначное представление duplicate entries и limits; либо строго отклонять неоднозначные
link layouts. Добавить pure проверки symlink-before-`..`, alias paths и cycles, затем
отдельный безопасный fixture конкретного поддерживаемого tar.

## P2-08 — Strict control-ledger checks приходят после live changes, записи остаются in-place

**Evidence:** [provision-agent/index.ts:81](../tools/framework/commands/management/provision-agent/index.ts#L81),
[provision-agent/index.ts:88](../tools/framework/commands/management/provision-agent/index.ts#L88),
[apply.ts:299](../tools/framework/commands/orchestration/apply.ts#L299),
[apply.ts:356](../tools/framework/commands/orchestration/apply.ts#L356),
[install.ts:183](../tools/framework/set/artifacts/install.ts#L183),
[ledger.ts:178](../tools/framework/set/ownership/ledger.ts#L178).

Strict readers защищают `recordInstalledSet`/`recordOwned` от перезаписи повреждённого marker,
но orchestration сначала читает tolerant variant. Provisioning может создать mirror,
prompts и нового агента, и только затем упасть на strict ownership read. `apply --set`
выполняет apply steps до strict установленного marker. В итоге прежние bytes сохраняются,
но новое live state уже не соответствует marker, а созданный объект не записан как owned.

Сами ledger/installed-set writers всё ещё вызывают обычный `transport.writeFile` прямо
по конечному path. Прерванная запись может сделать marker повреждённым — тот самый сценарий,
который теперь требует ручного repair. Atomic publication отсутствует.

**Рекомендация:** strict state preflight под instance lock до первой live mutation, затем
atomic state publication с сохранением предыдущих валидных bytes. Observation должна
отличать absent от corrupt/unknown и передавать это как blocking problem, а не как пустой
ledger. Regression должна assert отсутствие live calls при corrupt marker, не только
сохранность marker bytes при вызове одного writer.

## P2-09 — Default readiness теряет упавшие services и не выдерживает заявленный grace period

**Evidence:** [runtime-docker.ts:571](../tools/framework/runtime/runtime-docker.ts#L571),
[management/recipe.ts:297](../tools/framework/commands/management/recipe.ts#L297),
[management/recipe.ts:338](../tools/framework/commands/management/recipe.ts#L338),
[management/recipe.ts:342](../tools/framework/commands/management/recipe.ts#L342).

Backend запрашивает `compose ps --format json` без `--all`. Default readiness выводит
required names из этого же ответа. Упавший/остановленный основной service может отсутствовать,
а один оставшийся running sidecar образует весь required set и даёт ready.

Кроме того, «5 секунд grace» используются только как верхний deadline неготового ответа:
первый ready result немедленно возвращается. Контейнер, который успел стать running и
упадёт через мгновение, по-прежнему проходит без наблюдения grace interval. Если
`serviceStates()` сам зависнет, deadline не действует до его возврата, а transport timeout
на этот compose call не задан. Несколько replicas одного service перезаписывают один key.

**Рекомендация:** получать expected services из декларации/Compose config, читать все
containers и агрегировать replicas; обеспечить устойчивый ready interval, когда он обещан,
и общий deadline каждой probe. Называть неизвестное состояние неизвестным, а не исключать
его из requirements.

**Покрытие:** новый test инжектирует `serviceStates` с уже известными required names;
Compose filtering, default inventory, transient first-ready и hung probe этим не проверяются.

## P2-10 — Recovery connection facts недостижим в двух штатных интерфейсах

**Evidence:** [entry/cli.ts:164](../tools/framework/entry/cli.ts#L164),
[env.ts:177](../tools/framework/core/env.ts#L177),
[recover-env/index.ts:72](../tools/framework/commands/recover-env/index.ts#L72),
[recover-env/facts.ts:27](../tools/framework/commands/recover-env/facts.ts#L27),
[openclawCommands.management.ts:240](../tools/framework/commands/interface/groups/openclawCommands.management.ts#L240).

CLI и MCP всегда создают полный Context до вызова recovery. Если `OC_DATA_DIR` отсутствует
или пуст, `toSettings` прекращает обработку раньше `recoverEnv`, хотя именно этот missing
fact функция обещает восстановить из container metadata. Unit check вызывает `recoverEnv`
на уже изготовленном Context и обходит препятствие реального entry point.

При валидном Context есть другая недоступность: parser поддерживает `--adopt-runtime`,
но общая декларация команды содержит только `dry-run`. MCP schema не даёт передать новый
флаг и отказывает неизвестному аргументу. Диагностика советует действие, которое агент
не может вызвать через соответствующий MCP tool.

**Рекомендация:** отдельный recovery bootstrap context, которому достаточно transport/project
identity и который не нуждается в восстанавливаемых coordinates; либо явно ограничить
контракт и дать поддерживаемый repair path. Добавить `adopt-runtime` в единый help/schema
и проверить обе формы через реальные CLI/MCP dispatchers, а не только функцию.

## P2-11 — Host root consent проверяет известный backend, а не effective identity

**Evidence:** [host/contexts.ts:84](../tools/framework/commands/interface/host/contexts.ts#L84),
[host/contexts.ts:101](../tools/framework/commands/interface/host/contexts.ts#L101),
[host/index.ts:75](../tools/framework/commands/interface/host/index.ts#L75).

`arrivesAsRoot` выставляется для известного Docker Desktop engine, но отсутствует у
`target` и `local`. Процесс, уже запущенный с UID 0, SSH target с root login или WSL target
с root default исполняет host-команду как root без `--root --confirm-root`. Два флага
контролируют запрошенное elevation, а не фактически полученные полномочия.

**Влияние и граница:** это оставшийся контрактный риск из первого XA-аудита, не privilege
escalation сам по себе. MCP `confirm` для произвольной команды не заменяет обещанное
отдельное root consent. Effective user в live окружении этого раунда не измерялся.

**Рекомендация:** определить/сообщать actual execution identity до исполнения команды и
применять root gate одинаково к contexts, либо явно сузить обещание до дополнительного
elevation. Добавить regression уже-root local/target без вызова опасных команд.

## P2-12 — Backup/restore по-прежнему не координируют recipe lifecycle

**Evidence:** [backup.ts:127](../tools/framework/commands/lifecycle/backup.ts#L127),
[restore.ts:317](../tools/framework/commands/lifecycle/restore.ts#L317),
[management/recipe.ts:83](../tools/framework/commands/management/recipe.ts#L83).

Предупреждение о running stacks полезно, но backup останавливает только главный service.
Recipe containers продолжают менять bind-mounted данные во время tar; после restore они
могут держать прежние inode из `.replaced-*`, пока главный service уже использует новое
дерево. Instance lock запрещает соседние framework operations, но не записи контейнеров.

**Условие и влияние:** recipe пишет persistent state под dataDir или монтирует заменяемые
пути. Full backup может быть несогласованным, restore — формально успешным с разными
поколениями данных у участников. Это открытый XA round 2 P2-04, не новая находка только
из-за отсутствия автоматизации.

**Рекомендация:** generic lifecycle participants с declared quiesce/resume/rebind, порядком,
timeout и compensation; строгий consistency режим должен отказывать, если необходимый
участник не поддерживает паузу. Конкретное поведение остаётся в app-owned recipe.

## P2-13 — Secret delivery не сохраняет все значения, которые принимает env parser

**Evidence:** [env.ts:80](../tools/framework/core/env.ts#L80),
[secrets.ts:108](../tools/framework/commands/management/secrets.ts#L108),
[secrets.ts:207](../tools/framework/commands/management/secrets.ts#L207),
[private-config.ts:262](../tools/framework/security/private-config.ts#L262).

`parseEnv` сохраняет пробелы внутри обрамляющих quotes. Но apply/dump и `upsertEnvValue`
пишут обратно raw `NAME=value` без сериализации. Например, синтетическое значение
`EXAMPLE_KEY=" sample "` разбирается с пробелами, записывается как `EXAMPLE_KEY= sample `,
и следующий `parseEnv` уже возвращает `sample`. Аналогично меняются значения с собственными
обрамляющими кавычками. Для этого вывода достаточно собственного parser, поведение внешней
dotenv-библиотеки не предполагается.

**Условие и влияние:** разрешённое parser значение содержит значимые leading/trailing spaces
или quotes. Переданный/восстановленный credential отличается от сохранённого в source of
truth, а операция сообщает доставку. URL-safe generated secrets обычно не затронуты, но
generic store принимает более широкий контракт.

**Рекомендация:** единый lossless env serializer с определённым форматом для каждой стороны
либо явный отказ неподдерживаемым значениям до любой записи. Добавить round-trip случаи
parser → apply/dump/upsert → parser, проверяя bytes и не печатая credential.

## P3-01 — Windows runtime release gate и pinning publish Actions ещё не завершены

**Evidence:** [ci.yml:42](../.github/workflows/ci.yml#L42),
[ci.yml:70](../.github/workflows/ci.yml#L70),
[publish.yml:25](../.github/workflows/publish.yml#L25),
[publish.yml:58](../.github/workflows/publish.yml#L58),
[publish.yml:73](../.github/workflows/publish.yml#L73).

В CI добавлен Windows job, но он выполняет только compile/lint/build/pack. Ни Windows ACL,
ни drive/path handling, ни другие доступные без Docker unit checks там не исполняются.
Отказ от всех runtime checks из-за WSL части оставляет основную платформу без автоматического
runtime gate, хотя checks можно разделить по capability.

SHA pinning добавлен только в `ci.yml`; publish pipeline с доступом к release token/OIDC
продолжает использовать floating major tags checkout/setup/upload/download Actions. В этом
аудите не проверялась актуальность сторонних Actions/advisories.

**Рекомендация:** выделить Windows-safe runtime subset и отдельные capability-based WSL
integration checks; закрепить Actions также в publish workflow, ограничить permissions
по job и автоматизировать обновление pins. Не обозначать compile-only job как доказательство
исправности Windows поведения.

## P3-02 — Новый recipe readiness contract не выведен в README/help/MCP description

**Evidence:** [recipe.ts:60](../tools/framework/service/recipe.ts#L60),
[recipe.ts:202](../tools/framework/service/recipe.ts#L202),
[README.md:552](../README.md#L552),
[openclawCommands.management.ts:258](../tools/framework/commands/interface/groups/openclawCommands.management.ts#L258).

Source и checks уже требуют новый `readiness.services`/`timeoutMs` и привязывают к readiness
вызов `afterStart`. В авторской инструкции и общей command description этой декларации,
defaults и причин отказа ещё нет. Пользователь инструмента не узнаёт, как включить строгую
проверку multi-service recipe, не читая внутренний TypeScript.

**Рекомендация:** описать generic schema и полный жизненный цикл prepare → build → up →
readiness → afterStart, семантику absent readiness и timeout/error output. Пример должен
оставаться domain-neutral. Одновременно убрать неверные обещания freshness/grace после
исправления P2-01/P2-02/P2-09; детали реализации не должны заменять контракт автора рецепта.

## Приоритет исправлений и критерии следующей приёмки

1. Убрать live migrate restore из smoke; закрыть target write containment и destructive
   destination guards. Эти изменения ограничивают радиус повреждения даже при остальных ошибках.
2. Замкнуть privacy policy на staging bytes, обе history copies, walk root и точный deploy
   inventory. Для каждого carrier доказывать одинаковое решение о конкретном файле.
3. Пересмотреть hook loading как модульный runtime: безопасный cache, native origin и cycles.
   Проверять реальный установленный consumer с публичными imports и соседними assets.
4. Сделать lock takeover/release одним атомарным протоколом; перенести strict state preflight
   перед mutations и публиковать ledgers атомарно. Проверять реальные interleavings с ещё
   работающим owner, а не только cleanup после уже завершившегося run.
5. Исправить повторный full backup и owner-dependent операции; сохранить HEAD security fixes
   при объединении текущего diff. Проверять второй запуск и фактический контракт Transport.
6. Закрыть service-state compensation, sidecar consistency, readiness deadline и recovery
   parity через CLI/MCP; описать поддерживаемые ограничения в help.
7. После исправлений выполнить целевые regressions и штатный набор на поддерживаемых
   платформах, затем build/pack/CI. **В этом раунде они не запускались**; прежние зелёные
   результаты не являются результатом проверки указанного выше source fingerprint.
