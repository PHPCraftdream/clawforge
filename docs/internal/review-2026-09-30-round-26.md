# Ревью ClawForge, раунд 26 — после системной установки

Дата: 2026-09-30. База: `main` @ 46adab3 (= `origin/main`, CI run 36697394978 зелёный на всех
четырёх джобах). Предыдущие: XS-раунд 25 (`docs/internal/review-2026-09-30-xs-round-25.md`,
P0–P3 = 0 для 0e1b610) и последующие коммиты без повторного ревью — фиксы CI (4251592, cd91ea9,
c2b4256), эскалация приватной публикации (726c0d5), перенос отчётов (216a5fb), системная
установка (46adab3).

Запрос: удобство фреймворка, полнота инструментов, что улучшить, ошибки, неточности, плохой и
пахнущий код.

Метод: глобально установленный `clawforge` (`npm run install:system`) в свежей папке
приложения на Windows-хосте с WSL-целью: `init`, `help`, `bootstrap --check`, `status`,
`doctor`, `secrets`, `plan`, `logs`, `lock --check`, `backup list`, `backup install`,
`destroy`, `operations`, `inspect`, `expose status`, `watch status`, `recipe list`, `verify`,
`set validate`, `accept`, опечатка в команде, запуск из подпапки и вне приложения; команда,
которую `backup install` предлагает для планировщика, запущена в WSL как есть (с безвредным
`version` вместо `backup`). Сторожевой таймер ssh-транспорта (ветка без `timeout`) прогнан в
контейнере `node:24`. Статический разбор: изменения после раунда 25, размер файлов, тихие
`catch`, дубли, бюджет `tools/list`. Вывод, сделанный рассуждением, а не воспроизведением,
помечен «по коду».

Не проверялось: живой `bootstrap`/`up`/`backup` (цель не трогалась, данные не создавались),
ssh-цель на реальном сервере, macOS-хост вручную (только CI).

Шкала: P1 — ломает основное обещание; P2 — неверное поведение в реальном сценарии; P3 —
шероховатость, риск, гигиена.

## 1. Сводка

| # | Сев. | Где | Суть |
|---|------|-----|------|
| R26-01 | P2 | `operate/schedule.ts`, шим `init` | у развёртывания на глобальной команде плановые задания (`backup install`, `watch install`) не запускаются: WSL — `exec: node: not found`, Windows+ssh — путь к несуществующему `node_modules/…/bin.js`, cron — глобального каталога нет в PATH; воспроизведено (WSL) |
| R26-02 | P2 | `docs/guide/deploy-and-mcp.md`, `tools/framework/README.md` | инструкции `npm install @clawforge/framework` / `npm install -g …`, а пакет не опубликован (`npm view` → 404); ни слова, что путь пока недоступен |
| R26-03 | P2 | `entry/bin.ts` | в подпапке приложения глобальная команда пишет «no app.ts … run: clawforge init» — совет создаёт вложенное развёртывание; `app.ts` вверх не ищется, хотя MCP-загрузчик ищет; воспроизведено |
| R26-04 | P2 | `lock --check` | всегда код 0, даже с тремя расхождениями — как проверку в CI не использовать; на незапущенном экземпляре причина подана как «batch transport failed»; воспроизведено |
| R26-05 | P3 | подсказки CLI | 383 жёстких `./clawforge …` в `tools/framework`: с глобальной командой в cmd/PowerShell подсказки не работают, а сам шим — только bash |
| R26-06 | P3 | вывод `init`, шаблон `.env` | «./clawforge — единственный файл для коммита» (коммитятся и `mcp-launch.mjs`, `app.ts`, `config/…`); шапка `.env` говорит про `new-app`; ссылка `docs/guide/…` вне репозитория ни на что не указывает |
| R26-07 | P3 | `version`, установщик | не видно, какая копия фреймворка отработала (глобальная / локальная / шлюз репозитория) и откуда; установщик не замечает другой `clawforge` раньше в PATH |
| R26-08 | P3 | `destroy` | на ни разу не поднятом развёртывании — ошибка с советом «run ./clawforge bootstrap»; разрушать нечего, это не ошибка |
| R26-09 | P3 | `help` | «(destructive for some actions)» на 14 строках из 45; блок служебных команд без заголовка и с другой шириной колонки; строки до 172 символов |
| R26-10 | P3 | `runtime/transport/ssh.ts` | сторож без `timeout` убивает только сам процесс — его дети живут дальше; воспроизведено; контрактная проверка всех транспортов проверяет лишь одиночный процесс |
| R26-11 | P3 | `runtime/datadir.ts`, `private-target-file.ts` | `sudoForRead` дублирует проверку sudo из `sudoFor`; публикация приватного файла под sudo зондирует sudo трижды |
| R26-12 | P3 | `tools/checks` | 18 файлов проверок со своим `run`/`runGate`/`runScript` при наличии `kit/spawn.ts`; `system-install.check.ts` берёт MCP-запись по индексу |
| R26-13 | P3 | MCP `tools/list` | 32688 из 32768 байт — 80 байт запаса: следующая команда или флаг ломают бюджет |
| R26-14 | P3 | размер файлов | 15 файлов 655–700 строк при пределе 700, в том числе `commands/lifecycle/lifecycle.ts` (687) |
| R26-15 | P3 | `entry/delegate.ts` | `CLAWFORGE_DELEGATED` наследуют все потомки — `clawforge` из хука/`host` в другом приложении пропускает передачу; сбой запуска — тихий выход 1 (по коду) |
| R26-16 | P3 | удобство | глобальный режим: `app.ts` не находит типы `@clawforge/framework` в редакторе — нет ни `tsconfig`, ни опции локальной dev-зависимости |
| R26-17 | P3 | гигиена | `docs/internal` — 67 файлов без оглавления; в `worktrees/` остались рабочие деревья раундов 21–24 |

## 2. Подробно

### R26-01 (P2). Плановые задания у развёртывания на глобальной команде не запускаются

`init` пишет `./clawforge`; без локального пакета шим теперь передаёт управление
`command -v clawforge`. `schedule.ts` решает, как запускать задание, по наличию шима:

- WSL-цель: `backup install` печатает
  `wsl.exe -d Ubuntu-24.04 --exec bash -lc "cd -- '<app>' && './clawforge' 'backup'"`. Та же строка
  с `version` вместо `backup`, запущенная как есть:
  `<npm-prefix>/clawforge: 15: exec: node: not found`, код 127. Шим сам нашёл `node.exe`, но
  отдаёт управление npm-шиму, а тот ищет `node` в PATH дистрибутива.
- Windows + ssh-цель: `windowsNodeInvocation` видит шим и планирует
  `node <app>\node_modules\@clawforge\framework\dist\entry\bin.js --project-root …` — такого
  файла в глобальном режиме нет (по коду).
- cron на Linux-цели: `./clawforge` под PATH cron (`/usr/bin:/bin`) не находит глобальный
  каталог npm (`~/.npm-global/bin`, nvm) — по коду.

Итог: `backup install` / `watch install` сообщают об успехе, а задания молча не работают.
Предложение: планировщику записывать абсолютные пути — `process.execPath` и `bin.js` той копии,
что реально выполняется (после передачи — локальной), а шиму при передаче глобальной копии
запускать её `bin.js` найденным им самим `node`, а не npm-шим.

### R26-02 (P2). Документация ведёт на неопубликованный пакет

`docs/guide/deploy-and-mcp.md` («Installing in a separate repository (npm)») и
`tools/framework/README.md` начинают с `npm install @clawforge/framework`; раздел о системной
установке упоминает и `npm install -g @clawforge/framework`. `npm view @clawforge/framework` →
404: первый релиз ещё не выпущен (`RELEASE.md`). Пользователь падает на первом шаге. Нужна
пометка «пока не опубликован — `npm run install:system` из клона» или ссылка на локальную
сборку (`npm pack` + `npm install <tgz>`).

### R26-03 (P2). Подпапка приложения → совет создать вложенное развёртывание

```
<app>/recipes$ clawforge status
error: no app.ts in <app>/recipes
error: this directory has not been initialised as an OpenClaw deployment yet — run: clawforge init
```

`clawforge init` здесь создаст второе развёртывание внутри `recipes/` первого. MCP-загрузчик
(`BOOTSTRAP` в `integration/mcp/project.ts`) уже поднимается вверх до `app.ts`; CLI этого не
делает. Предложение: искать `app.ts` вверх (до корня ФС или границы git), а при отказе не
советовать `init`, если выше есть `app.ts`.

### R26-04 (P2). `lock --check` не проверяет

На свежем развёртывании: `==> 3 difference(s) from the lock` (два `CLI_READ_FAILED`,
`LOCK_MISSING`) и код 0. В `commands/management/lock.ts` ветка `checkOnly` всегда `return`.
Флаг с именем `--check` не годится как ворота в CI без разбора JSON. Кроме того, на
незапущенном экземпляре `CLI_READ_FAILED … (batch transport failed)` скрывает настоящую причину —
«не запущен / не поднят». Предложение: ненулевой код при расхождениях (как `git diff
--exit-code`), `NOT_RUNNING` вместо `CLI_READ_FAILED`, когда контейнера нет.

### R26-05 (P3). Подсказки знают только `./clawforge`

`git grep -c '\./clawforge '` по `tools/framework` — 383. С глобальной установкой в cmd и
PowerShell `./clawforge` не работает (шим — bash), а все подсказки, `Usage:`, `nextActions`
и справка советуют именно его. Предложение: одно место, знающее, как вызвали CLI (`clawforge`,
`./clawforge`, `./clawforge --app <name>`), и подстановка из него.

### R26-06 (P3). Неточности в том, что пишет `init`

- «./clawforge is the only framework-adjacent file meant to be committed — commit it,
  .gitignore already excludes the rest»: `.gitignore` не исключает `mcp-launch.mjs` (его
  коммитят намеренно, см. `project.ts`), а также `app.ts`, `config/desired-state.json`,
  `package.json`.
- Шапка `.env`: «`./clawforge new-app <name>` copies this into the deployment» — в установленном
  режиме файл пишет `init`.
- «see docs/guide/requirements.md#windows-acl-and-the-wsl-boundary» — относительный путь
  репозитория; в папке приложения такого файла нет. Нужна ссылка на GitHub.

### R26-07 (P3). Какая копия отработала — не видно

После передачи управления (`entry/delegate.ts`) `clawforge version` печатает только
`clawforge 0.1.0` — не сказано, глобальная это копия, локальная зависимость приложения или шлюз
репозитория, и где она лежит. Установщик проверяет, что каталог shim-ов в PATH, но не то, что
`clawforge` из PATH — именно он (другой `clawforge` раньше в PATH останется незамеченным).
Предложение: `version --verbose` (или `--json`) с полями `source`/`path`; в установщике —
сравнить `where`/`command -v clawforge` с установленным shim-ом.

### R26-08 (P3). `destroy` на пустом месте

`clawforge destroy` на ни разу не поднятом развёртывании: `error: … never been bootstrapped —
run ./clawforge bootstrap`, код 1. Совет поднять экземпляр, чтобы его удалить, абсурден.
Ожидаемо: «nothing to destroy» и код 0 (или отдельный код), флаги `--data`/`--backups` по-прежнему
отрабатывают для существующих каталогов.

### R26-09 (P3). Шум в `help`

14 из 45 строк списка заканчиваются «(destructive for some actions)», строки `recipe`, `expose`,
`incident` — 154–172 символа, в обычном терминале переносятся. Служебный блок (`init`, `version`,
`completion`, `control-mcp`, `help`) идёт без заголовка и с шириной колонки 12/16 вместо 21.
Предложение: одна пометка-символ и легенда внизу, заголовок «Framework:», общая ширина колонки.

### R26-10 (P3). Сторож ssh без `timeout` не гасит дерево процессов

Ветка для целей без `timeout` (`withRemoteDeadline`) шлёт `kill` только `$p`. В контейнере
`sh -c "sleep 40 & sleep 40"` под сторожем с дедлайном 1 с: оболочка убита (код 143), оба
`sleep 40` живы. GNU `timeout` убивает группу. Поддерживаемые цели — Linux, поэтому P3.
Контрактная проверка транспортов (`scenarios/contract.ts`) проверяет лишь `exec sleep 20` —
одиночный процесс, а не дерево, для всех трёх транспортов.

### R26-11 (P3). Дубли вокруг sudo

`sudoForRead` (726c0d5) повторяет из `sudoFor` проверку `command -v sudo` и `sudo -n true`.
`publishPrivateTargetFile` под sudo: `sudoFor(dirname)`, затем `runMaybePrivileged(…, force)` —
снова `command -v sudo` и `sudo -n true`; на WSL каждый зонд — отдельный `wsl.exe`. Общий
кэшируемый на контекст «sudo доступен без пароля?» убрал бы и дубль, и лишние вызовы.

### R26-12 (P3). Повторяющиеся помощники в проверках

18 файлов в `tools/checks` объявляют свой `run`/`runGate`/`runScript` (spawn с cwd, сбор
вывода, таймаут, обход `.cmd` на Windows), хотя есть `kit/spawn.ts`. `installed-consumer.check.ts`
и `system-install.check.ts` по-разному решают запуск npm на Windows. В
`system-install.check.ts` MCP-запись берётся как `Object.values(projectMcpEntries())[1]` —
зависит от порядка ключей; надёжнее по имени (`CLAWFORGE_CONTROL_MCP_NAME`).

### R26-13 (P3). Бюджет `tools/list` исчерпан

`mcp-mirror.check.ts`: `tools/list is 32688 bytes (budget 32768)`. 80 байт — меньше одного
описания аргумента. Следующая команда или флаг остановят CI. Нужна структурная экономия
(например, общие описания аргументов вынести в `help`, короче `description` у многодейственных
команд), а не очередное точечное сокращение.

### R26-14 (P3). Давление на предел 700 строк

`git ls-files 'tools/*.ts' | xargs wc -l`: 15 файлов в диапазоне 655–700, в том числе
`runtime-image-identity.check.ts` ровно 700 и `commands/lifecycle/lifecycle.ts` 687. Любая
правка там закончится вынужденным разбиением под давлением, а не по смыслу. Стоит заранее
разрезать по смысловым границам.

### R26-15 (P3). `CLAWFORGE_DELEGATED` живёт дольше, чем нужно (по коду)

`runInstead` кладёт `CLAWFORGE_DELEGATED=1` в окружение потомка, и его наследует всё, что тот
запустит: хук рецепта или `host`, вызвавший `clawforge` в другом приложении, пропустит передачу
и соберёт две копии фреймворка в одном процессе — ровно то, от чего передача защищает. Флаг
стоит передавать аргументом или снимать в дочернем `bin.ts` сразу после чтения. Там же:
`spawnSync` с ошибкой запуска (`result.error`) даёт `exit(1)` без сообщения.

### R26-16 (P3). Типы в редакторе при глобальной установке

`init` без локального пакета пишет `app.ts` с `import … from "@clawforge/framework/app"`:
запускается (самоссылка через хук разрешения), но редактор типы не находит — весь `app.ts`
красный. Варианты: `clawforge init --local` (добавить dev-зависимость), либо `tsconfig.json` с
`paths` на глобальный пакет.

### R26-17 (P3). Гигиена

`docs/internal` — 67 отчётов и планов без оглавления; искать «что открыто сейчас» приходится
по датам. В игнорируемом `worktrees/` лежат деревья агентов раундов 21–24 (`r21_*` … `r24_*`) —
решение за владельцем.

## 3. Что хорошо

- Сообщения об ошибках называют причину и следующий шаг: опечатка → «did you mean: status»;
  `bootstrap --check` даёт точную строку `sudo install -d`; `doctor` → код 1 и «Next: …».
- Разделение наблюдения и вердикта выдержано: `status`/`inspect` — 0, `doctor` — 1 при
  блокирующей проблеме; `plan` честно говорит, что `apply` ничего не выполнит.
- `backup install` на WSL-цели не ставит молча задание, а объясняет почему и печатает команду
  для внешнего планировщика — хорошая практика (жаль, что сама команда в глобальном режиме не
  работает — R26-01).
- Системная установка: одна команда, копия, а не ссылка; локальная зависимость приложения
  по-прежнему главнее — версия приложения не уплывает от глобальной.

## 4. Порядок работ

1. R26-01, R26-03 — глобальный режим обещает «работает в любой папке», сейчас есть две дыры.
2. R26-04 — `lock --check` как ворота.
3. R26-02, R26-06 — документация и вывод `init`.
4. R26-13, R26-14 — снять давление бюджетов до следующей функции.
5. Остальные P3 — по мере касания кода.
