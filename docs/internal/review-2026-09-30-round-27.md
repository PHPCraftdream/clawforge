# Ревью ClawForge, раунд 27 — после фиксов раунда 26

Дата: 2026-09-30. База: `main` @ 57dbc57 (код = d5ee523 = `origin/main`, CI run 36727890380
зелёный на всех четырёх джобах). Предыдущий: раунд 26
(`docs/internal/review-2026-09-30-round-26.md`, R26-01…R26-17 закрыты коммитами
7fb5695…d5ee523). Сами фиксы раунда 26 повторного ревью не проходили — это первое.

Запрос: ещё одно ревью — удобство, полнота инструментов, ошибки, неточности, плохой и
пахнущий код.

Метод: разбор `git diff e0c7a85..d5ee523` (50 файлов фреймворка: вход, передача управления,
подсказки, `init`, `version`, `lock`, транспорты, sudo, `destroy`, справка). Пробы — свежий
`dist/` этой ревизии (`npm run build`), запуск `node dist/entry/bin.js` как глобальной команды
в игнорируемых каталогах под `apps/` на Windows-хосте с WSL-целью: `help`, `--help`,
`help init`, `init`, `init --local`, `version --verbose`, `status`, `doctor`, `lock --check`
(в том числе из подпапки), `backup install`, `destroy` (с флагами и без), приложение
`new-app` в `apps/<name>` с `--app` и без, подпапка чекаута. Строки cron проверены вызовом
`cronLine` + `localizeHints` напрямую. Вывод, сделанный рассуждением, а не воспроизведением,
помечен «по коду». Каталоги проб удалены.

Не проверялось: живой `bootstrap`/`up` (цель не трогалась), Linux-хост с локальной целью
(строка cron показана через функции), ssh-цель на реальном сервере, macOS вручную.

Шкала: P1 — ломает основное обещание; P2 — неверное поведение в реальном сценарии; P3 —
шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| R27-01 | P2 | `core/io/invocation.ts` (`localizeHints` в `log`/`emit`), `backup install`, `watch install`, `deploy` | переписывание `./clawforge` задевает строки, которые копируют в другой shell: строка cron для `crontab -e` под глобальной командой — `clawforge 'backup'` (cron его не найдёт, `--apply` ставит другую строку), в чекауте с `--app` — `--app` дважды; подсказка для сервера после `deploy` — `clawforge`, которого там нет; воспроизведено |
| R27-02 | P2 | `init --local`, `docs/guide/deploy-and-mcp.md` | `init` советует `clawforge init --local`, а повторный `init` отказывает («already initialised», код 1) — совет недостижим; после `npm install` ссылка пропадает, и вернуть её нечем; воспроизведено |
| R27-03 | P2 | `entry/bin.ts` | вне приложения `clawforge help`, `--help`, `help init` — ошибка «no app.ts», код 1; первая команда после установки не показывает ни одной команды; работает только `init --help`; воспроизведено |
| R27-04 | P2 | `entry/delegate.ts:82`, `tools/clawforge.ts:303` | глобальная команда в чекауте: в `apps/<name>` `clawforge --app <name> …` → «unknown command: --app» (второй `--app`); в корне `clawforge --app <name> status` советует `clawforge bootstrap` — из корня это другое развёртывание (по умолчанию); воспроизведено |
| R27-05 | P3 | `entry/bin.ts`, `init` | в подпапке чекаута (`docs/`) совет «run: clawforge init» — развёртывание внутри чекаута; `init` в новом `apps/<name>` пишет `app.ts` установленного вида, который шлюз чекаута не загружает («Cannot find package '@clawforge/framework'»); воспроизведено копией |
| R27-06 | P3 | `instance/destroy.ts` | пробный `destroy --backups --snapshots` на ни разу не поднятом развёртывании падает на sudo для каталогов, которых нет; `sizeReport` просит sudo на запись ради `du`; «nothing to destroy», а затем «Pass --yes … for a real run»; воспроизведено |
| R27-07 | P3 | `lock --check` | «3 difference(s) from the lock», из них две — «instance is not running» (не расхождение, а невозможность сравнить); итог печатается дважды (`==>` и `error:`); воспроизведено |
| R27-08 | P3 | `entry/bin.ts`, MCP-загрузчик | подсказки говорят `clawforge`, когда работает локальный пакет приложения (MCP-загрузчик, `npx`/`node_modules/.bin`): без глобальной установки агент получит «command not found» — по коду |
| R27-09 | P3 | тексты | «…including the sudo install -d line if one is» — фраза оборвана; `init` пишет в каждый `app.ts` `name: "openclaw"` (у `new-app` — имя развёртывания), отсюда «openclaw — self-hosted…» в справке `app1` и одинаковый `openclaw-control` у всех MCP-серверов; комментарии скрипта автодополнения всегда `./clawforge` |

P0 и P1 нет.

## 2. Подробно

### R27-01 (P2). Переписывание подсказок задевает строки для другого shell

R26-05 перенёс замену `./clawforge` → префикс вызова в слой вывода: всё, что уходит через
`log`/`info`/`emit`, переписывается регуляркой `HINT`. Под неё попадают и строки, которые
пользователь должен скопировать в другое место как есть. Вызов `cronLine` + `localizeHints`:

- глобальная команда (`clawforge`), развёртывание `app1`:
  `0 * * * * cd '/srv/app1' && clawforge 'backup' >/dev/null 2>&1 # clawforge-backup:app1`.
  `backup install` без `--apply` печатает её со словами «add it yourself with `crontab -e`».
  `--apply` же ставит исходную `./clawforge 'backup'`: показанное и установленное расходятся, а
  показанное под PATH cron (`/usr/bin:/bin`) не найдёт глобальный `clawforge` — ровно механизм
  R26-01. То же в `watch install` (`watch/install.ts:117`).
- шлюз чекаута с `--app staging` (префикс `./clawforge --app staging`):
  `cd '/repo' && ./clawforge --app staging '--app' 'staging' 'backup'` — `--app` дважды.
  Исключение для подсказок со своим `--app` не срабатывает: аргументы в строке cron в кавычках.
- `deploy` (`deploy/sync.ts:141`, `deploy/index.ts:67`) под глобальной командой:
  `bring it up there with: cd /opt/oc && clawforge --app staging bootstrap` — на сервере
  зеркало чекаута с `./clawforge`, глобальной установки там может не быть.

Предложение: переписывать только подсказки для этого терминала. Строки для другого
shell/хоста/планировщика выводить сырыми (`info`-аналог `emitRaw`) или строить их так, чтобы
`HINT` их не узнавал. Проверка: `cronLine` под префиксами `clawforge` и
`./clawforge --app x` выводится без изменений.

### R27-02 (P2). `init --local` — совет, которым нельзя воспользоваться

После `clawforge init` без локального пакета:
`editors cannot resolve @clawforge/framework types without a local install: clawforge init --local`.
Повторный `clawforge init --local` в той же папке:
`error: <app>\app.ts already exists — this directory is already initialised`, код 1. Флаг
работает только при самом первом `init`, а об этом узнают уже после него. Документация
(`deploy-and-mcp.md`: «Opt in with `clawforge init --local`») подаёт его как выбор в любой
момент и сама предупреждает, что следующий `npm install` уберёт ссылку — вернуть её после
этого тоже нечем.

Предложение: `--local` ничего не пишет, только печатает строку `npm install`. Пусть на уже
инициализированной папке он печатает её и выходит с 0, не трогая файлы. Проще — печатать
строку сразу в выводе `init`, без флага.

### R27-03 (P2). `help` вне приложения — ошибка

В пустой папке:

```
$ clawforge help            → error: no app.ts in <dir> … run: clawforge init   (код 1)
$ clawforge --help          → то же, код 1
$ clawforge help init       → то же, код 1
$ clawforge init --help     → справка init
```

Установщик пишет «in an app folder: clawforge init, then … help», но первое, что пробует
человек после установки, — `clawforge --help`. Вне приложения нет даже списка того, что
здесь доступно (`init`, `version`, `completion`).

Предложение: вне развёртывания `help`/`--help` показывают команды шлюза и строку «полный
список — в папке приложения после `clawforge init`», `help <команда шлюза>` — её справку,
код 0.

### R27-04 (P2). Глобальная команда в чекауте теряет или удваивает `--app`

Развёртывание `apps/r27probe` создано `./clawforge new-app r27probe`.

- В `apps/r27probe`: `clawforge --app r27probe lock --check` →
  `error: unknown command: --app`. `delegateToOwnFramework` передаёт шлюзу
  `["--app", basename(appRoot), ...argv]`, а `argv` уже начинается с `--app r27probe`. Шлюз
  сам печатает подсказки вида `./clawforge --app r27probe …`, и в этой папке их естественно
  набрать с `clawforge`.
- В корне чекаута: `clawforge --app r27probe status` →
  `nothing deployed yet — run clawforge bootstrap`. Из корня эта команда обратится к
  развёртыванию по умолчанию (`openclaw`), а не к `r27probe`. Шлюз напрямую советует
  `./clawforge --app r27probe bootstrap`. Причина: `tools/clawforge.ts:303` добавляет
  `--app <name>` в префикс, только если передачи не было (`invokedAs === undefined`).

Предложение: `delegate.ts` не добавляет `--app`, если `argv` уже начинается с `--app`
(с тем же именем; с другим — внятная ошибка). Шлюз при передаче и явном не-умолчательном
развёртывании ставит префикс `${invokedAs} --app ${name}` — после первой правки такая
подсказка работает и из `apps/<name>`.

### R27-05 (P3). Глобальная команда в других местах чекаута

- `<checkout>/docs`: `clawforge status` → «no app.ts in <checkout>\docs … run: clawforge
  init». Совет создаёт развёртывание внутри исходников фреймворка.
- `clawforge init` в новом `<checkout>/apps/<name>`: `app.ts` ещё нет, передачи шлюзу нет,
  `init` глобального пакета пишет `app.ts` с импортами `@clawforge/framework/...`. Дальше
  каждая команда уходит в шлюз чекаута, и он отказывает:
  `cannot load deployment "<name>": Cannot find package '@clawforge/framework' imported from
  …/apps/<name>/app.ts` (воспроизведено копией приложения после `init`).

Предложение: `findAppRoot`/`bin.ts` узнают чекаут (тот же `checkoutGate` вверх по
дереву). `init` внутри чекаута отказывает с советом `./clawforge new-app <name>`, остальные
команды говорят «это чекаут ClawForge: `./clawforge` в его корне».

### R27-06 (P3). Пробный `destroy`

- `destroy --backups --snapshots` (без `--yes`) на ни разу не поднятом развёртывании с
  каталогами по умолчанию `/srv/app1/…`:
  `error: /srv needs root and sudo asks for a password, which cannot be typed here`, код 1.
  Каталогов нет, но пробный прогон для каждого вызывает `prepareDestroyTarget` → `sudoFor`
  (права на удаление в родителе). Ветка `--yes` на неподнятом развёртывании отсутствующие
  каталоги уже пропускает, пробная — нет. Проверочный скрипт `SAFE_DESTROY_SCRIPT` для
  отсутствующей цели и так выходит с 0 без привилегий.
- `sizeReport` берёт `sudoFor` (запись) ради `du -sk`. Нужно чтение — `sudoForRead`.
- Просто `destroy` там же: `nothing to destroy: never bootstrapped …`, затем
  `dry run — nothing removed. Pass --yes and --confirm-name <deployment name> for a real run`
  — зовёт к «настоящему» прогону, который ничего не сделает.

Предложение: в пробном прогоне отсутствующая цель — «absent» без sudo; присутствующая —
проверка с правами чтения; строку про `--yes` печатать, только если есть что удалять.

### R27-07 (P3). Формулировки `lock --check`

На неподнятом развёртывании:

```
==> 3 difference(s) from the lock
    GATEWAY_DOWN  openclaw plugins list not read: instance is not running — start it or bootstrap first
    GATEWAY_DOWN  openclaw skills list not read: instance is not running — start it or bootstrap first
    LOCK_MISSING  no config/deployment.lock.json — this instance's composition is not pinned
error: 3 difference(s) from the lock
```

Две «разницы» из трёх — невозможность прочитать, а не расхождение. Итог выводится дважды:
`log` и сообщение `dieWithExitCode`. Код 1 верный.

Предложение: считать отдельно «не с чем сравнить: экземпляр не запущен» и расхождения. В
`error:` — одна короткая итоговая строка, а не повтор заголовка.

### R27-08 (P3). `clawforge` в подсказках при локальном пакете (по коду)

`bin.ts` ставит префикс `clawforge`, если его не передал шим
(`CLAWFORGE_INVOKED_AS=./clawforge`). Без шима идут:

- MCP-загрузчик (`INSTALLED_LAUNCHER` импортирует локальный `bin.js` в том же процессе);
- `npx clawforge` / `node_modules/.bin/clawforge`.

В приложении только с локальной зависимостью и без глобальной установки ответы MCP советуют
`clawforge bootstrap`. Агент выполняет это в shell и получает «command not found».

Предложение: префикс по умолчанию — по `classifyCopy`: `local` → `./clawforge` (шим `init`
пишет всегда), `global` → `clawforge`.

### R27-09 (P3). Тексты и согласованность

- `deployment-template.ts:90`: «…reports exactly what it needs, including the sudo install -d
  line if one is» — фраза оборвана («if one is needed»).
- `init.ts:35` пишет в каждый `app.ts` `name: "openclaw"`, `new-app` — имя развёртывания. У
  приложения `app1` справка начинается с «openclaw — self-hosted OpenClaw instance»,
  «control-mcp — expose openclaw's commands», `serverInfo` MCP у всех таких приложений —
  `openclaw-control`. Имя папки уже проверено `safeName` — его и писать.
- `completion.ts:142,154,186`: скрипт идёт через `emitRaw`, поэтому его комментарии
  («Install: source <(./clawforge completion bash)») всегда про `./clawforge`, и под
  глобальной командой тоже.

## 3. Что хорошо

- Фиксы раунда 26 держатся: подпапка приложения находит развёртывание (`lock --check` из
  `sub/deeper`), вложенный `init` запрещён, `destroy` без флагов на пустом месте — код 0,
  `lock --check` — код 1, «instance is not running» вместо «batch transport failed».
- `version --verbose` честно называет копию и путь; `realpath.native` убрал 8.3-имена.
- Кэш sudo на контекст (`sudoAvailability`) убрал тройное зондирование, не кэшируя сбои
  транспорта.
- Сторож ssh без `timeout` гасит группу или дерево; локальный — дерево через `ps`, не отрывая
  ребёнка от Ctrl+C; контрактная проверка покрывает ребёнка.
- Справка стала короче и ровнее: одна колонка, `!`/`*` с легендой, раздел «Framework:».
- `backup install` на WSL-цели печатает рабочую команду для планировщика с `'./clawforge'` в
  кавычках — `HINT` её не трогает.

## 4. Порядок работ

1. R27-01 — показанное должно совпадать с установленным; заодно проверка, что строки для
   других shell не переписываются.
2. R27-03, R27-02 — первые минуты после установки: `--help` и типы в редакторе.
3. R27-04, R27-05 — глобальная команда в чекауте (сначала `delegate.ts`, потом префикс).
4. R27-06, R27-07 — пробный `destroy` и `lock --check`.
5. R27-08, R27-09 — по мере касания кода.
