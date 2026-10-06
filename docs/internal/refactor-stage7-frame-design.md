# Этап 7, срез S1: execution frame — проектное решение

Дата: 2026-10-06. Основание: [план этапа 7](refactor-plan-stage7-2026-10-06.md) (S1, I12, §6),
[отчёт о сходимости](review-convergence-after-refactor-2026-10-06.md) (§4 семейство 1, §5.1, §6 S1),
[план рефакторинга](refactor-plan-2026-10-01.md) (этапы 2 и 4), [решение этапа 4](refactor-stage4-design.md),
[backlog P3](backlog-p3.md). Код прочитан на `main` = `0cdea4d` (`git show main:…`; worktree этого
проекта стоит на старом `d36e76c`, где `checkoutRootProgram` ещё нет — исполнители ветвятся от `main`).
Пути — от `tools/framework/`, если не сказано иное. Это проект: кода он не меняет; реализация — S1.2–S1.6
после согласования.

## 0. Решения коротко

* **Frame** — одно значение «как и где будет исполнена строка»: способ запуска (`Launch`, а не строка
  программы), хост, множество shell, каталог вставки, известные места (корень checkout, корень
  развёртывания), выбранное развёртывание. Живёт в новом `core/io/invocation/frame.ts` вместе со
  всеми конструкторами и переходами. `Invocation` v1 остаётся форматом передачи между процессами
  и проекцией frame для старых читателей; формат v1 и его writers **не меняются** (v2 не нужен).
* Написание программы — функция `spell(launch, shell, host, cwd)` по таблице (§2.2), а не решение по
  наличию `/`. `checkoutRootProgram`, `CWD_PROGRAMS`, `shimInvocation`, `defaultInvocation` и
  квотирование «по `/` в программе» удаляются.
* `Advice` расширяется, а не заменяется: `CommandAdvice.at` остаётся (`"checkout-root"`), поле
  `install?: boolean` заменяется на `shell?: Shell`; у `ShellAdvice` появляется необязательное
  `alternatives` (тексты для других shell). Рендерер один (`render.ts`); он читает frame процесса,
  как сейчас читает `invocation()`.
* Переходы (в корень checkout, в другое развёртывание, на цель, в другой shell) — тотальные функции
  `Frame → Frame`; неполнота выражена в рендерере тремя явными fallback-правилами (§2.3), не исключением.
* `entry/resolve.ts` получает `Launch` входом и возвращает решение с `AppFact` и местами; `bin.ts` и
  `tools/clawforge.ts` строят frame один раз и устанавливают его один раз.
* Долговечный вывод (cron, schtasks, установка автодополнения, строки для сервера) строится из
  собственного frame цели (`Cwd = unknown` → строка обязана содержать `cd`).
* Закон I12 — проверка `frame-law.check.ts`: render → токенизация моделью shell → настоящий резолвер
  на фейковой ФС → та же команда и то же развёртывание; на реальных bash/pwsh/cmd — под `requires(cap)`.
  Столбцы матрицы советов выводятся из producer'ов, а не пишутся руками.

## 1. Значение Frame

### 1.1. Типы

```ts
// core/io/invocation/frame.ts — данные, конструкторы, переходы; без I/O и без глобалей
import type { Shell } from "./advice.ts";
import type { AppSelection, InvocationAudience, InvocationMode } from "./index.ts";

export type HostPlatform = "posix" | "win32";

/** Чем запускают ClawForge. Корни — абсолютные пути на хосте frame. */
export type Launch =
  | { readonly kind: "system" }                                  // `clawforge` из PATH
  | { readonly kind: "checkout-shim"; readonly root: string }    // <checkout>/clawforge, bash
  | { readonly kind: "deployment-shim"; readonly root: string }  // <deployment>/clawforge от init, bash
  | { readonly kind: "npm-bin"; readonly root: string }          // <deployment>/node_modules/.bin/clawforge(.cmd|.ps1)
  | { readonly kind: "verbatim"; readonly program: string; readonly mode: InvocationMode }; // ручное значение env

export type Host =
  | { readonly kind: "operator"; readonly platform: HostPlatform }        // машина этого процесса
  | { readonly kind: "target"; readonly via: "ssh" | "local" | "wsl" };   // цель развёртывания, всегда POSIX

export type Cwd =
  | { readonly kind: "dir"; readonly path: string }   // каталог, где строку вставят
  | { readonly kind: "unknown" };                     // ssh-сессия, cron: $HOME — строка обязана сделать cd

export interface Places {
  readonly checkoutRoot?: string;
  readonly deploymentRoot?: string;
}

export type AppFact =
  | { readonly state: "none" }                                                   // решено: развёртывания нет
  | { readonly state: "selected"; readonly name: string; readonly by: AppSelection };

export interface Frame {
  readonly launch: Launch;
  readonly host: Host;
  readonly shells: readonly [Shell, ...Shell[]];   // где строку могут вставить; первый — основной
  readonly cwd: Cwd;
  readonly places: Places;
  readonly app: AppFact;
  readonly audience: InvocationAudience;           // как в v1; рендером не читается (backlog)
}
```

### 1.2. Зачем каждое поле

| Поле | Что убивает |
| --- | --- |
| `launch` вместо `program` | D1: `checkoutRootProgram` решает по `/` и оставляет `node_modules\.bin\clawforge` в корне checkout, где его нет. Переход в корень меняет `launch` по виду (`npm-bin → checkout-shim`), не строку. Также D9: квотирование аргументов по `program.includes("/")` (`renderArgument`) |
| `launch.root` | D10: из подкаталога подсказка `./clawforge` не разрешается (backlog P3 «local-package hint pasted from a subdirectory»; то же для корневого шима из `docs/`). Написание считается относительно `cwd` |
| `verbatim` | ручной `CLAWFORGE_INVOCATION` с произвольной программой: печатается как набран, переходам не подлежит, режим сохраняется для round-trip v1 |
| `host` | D5: `deploy` подсказывает серверу команду в написании локального вызова (`arguments.ts:49` `commandLine("bootstrap")` — у оператора `node_modules\.bin\clawforge`). Строка для цели строится с `host.kind = "target"` |
| `shells` | D4: `cd '<checkout>'` в одинарных кавычках ломается в cmd.exe; D6: строка установки автодополнения для pwsh пишется программой bash-шима. Shell — множество, потому что cmd и pwsh на Windows неотличимы по окружению процесса |
| `cwd` (`unknown`) | D5 и cron: «где окажется строка» на цели неизвестно, `cd` обязателен — сейчас это держится ручной склейкой `cd … &&` в `sync.ts`/`cronLine` |
| `places` | `at: "checkout-root"` сейчас означает «угадай корень по программе»; теперь место — путь, известный решению входа (`checkout`) |
| `app: AppFact` с `none` | D7: решение `gate-command` не несёт факта о развёртывании, и одна проза рендерится по-разному на консоли и в MCP; D8: пустой `OC_APP` считается выбором. Отсутствие — явное состояние, которое решение обязано назвать (тип не допускает пропуска) |
| `app.by` | D3: совет с явным `--app X`, напечатанный под программой, ищущей развёртывание по cwd, внутри Y отказывается как конфликт. Правило префикса (§2.3) читает `by` и `launch` |
| `audience` | только round-trip v1; поведение не меняется (backlog «audience/mode read by no surface») |

`Invocation` (v1) остаётся типом передачи: `handoverOf(frame): Invocation` — единственный писатель v1,
`launchFromHandover(inv, facts)` — единственный читатель (§4). `invocation()` сохраняется как
`handoverOf(currentFrame())` на время S1.2–S1.3 для `help-render.ts`/`prose.ts`; в S1.4 они читают frame.

## 2. Advice и рендерер

### 2.1. Расширение Advice (данные, `advice.ts`)

```ts
export interface CommandAdvice {
  readonly kind: "clawforge";
  readonly argv: readonly string[];
  readonly app?: string;
  readonly note?: string;
  readonly at?: "checkout-root";   // как сейчас; смысл: «написано для вставки в этом месте»
  readonly shell?: Shell;          // было install?: boolean — строка для вставки в названный shell
}
export interface ShellAdvice {
  readonly kind: "shell";
  readonly shell: Shell;           // основной shell; text — как сейчас, дословно
  readonly text: string;
  readonly note?: string;
  readonly alternatives?: Partial<Record<Shell, string>>;   // новое: тот же шаг в других shell
}
export function changeDirectory(path: string): ShellAdvice;  // §2.4
```

* Advice остаётся без путей и без глобалей: место — символ (`at`), путь даёт `frame.places`.
  JSON-контракт `next` (этап 4, 1.1) меняется только аддитивно: `alternatives`; `install` в `next`
  не попадал (строится только для заголовков автодополнения и токена `{install …}`) — проверить grep'ом
  `"install":` по golden в S1.4.
* `FRAMEWORK_EXPORT_SOURCES` (`./app`, `./mounts`, `./commands`, `./private-config`) и `exports` пакета
  не меняются: `Advice`/`Frame` — внутренние типы; новый `frame.ts` попадает в `dist` обычной сборкой.
* `command()`, `shellLine()`, `manual()` сохраняют сигнатуры; `command(argv, { install: true })` →
  `command(argv, { shell })`. Токен `{install completion <s>}` в прозе даёт `shell` из имени
  (`bash`/`zsh` → `posix`, `pwsh` → `pwsh`).

### 2.2. Написание программы

`spell(launch, shell, host, cwd): string | undefined`, единственный владелец литералов программы:

| `launch` | `posix` | `cmd` | `pwsh` на POSIX-хосте | `pwsh` на win32 |
| --- | --- | --- | --- | --- |
| `system` | `clawforge` | `clawforge` | `clawforge` | `clawforge` |
| `checkout-shim(r)` | `rel(cwd, r)/clawforge` | — | как posix | — |
| `deployment-shim(r)` | `rel(cwd, r)/clawforge` | — | как posix | — |
| `npm-bin(r)` | `rel/node_modules/.bin/clawforge` | `rel\node_modules\.bin\clawforge` | — (не строится) | как cmd |
| `verbatim(p)` | `p` | `p` | `p` | `p` |

`rel` — `.` если `cwd = r` (даёт `./clawforge` и `node_modules\.bin\clawforge` без префикса, как сейчас),
цепочка `..` если `cwd` внутри `r`, иначе абсолютный путь (квотируется правилом аргумента). При `cwd = unknown`
`rel` не вычисляется: рендерер префиксует `cd <root>` и пишет `./clawforge` (2.3, правило P). Квотирование аргументов — по
`frame.shells`, не по программе: `[posix]` → `shellQuote`; `[cmd, pwsh]` → нынешнее правило «двойные,
при `$`/backtick одинарные» (backlog 8–9 остаются как есть).

Множество shell строит один конструктор `pasteShells(launch, host, msys)`: шимы → `[posix]`; цель → `[posix]`;
`system`/`npm-bin`/`verbatim` на POSIX → `[posix]`, на win32 при `MSYSTEM` в окружении (Git Bash) → `[posix]`,
иначе `[cmd, pwsh]`. Инвариант конструктора: текущий `launch` имеет написание во всех `shells` (иначе
shell исключается). Поэтому строка в текущем frame всегда одна.

### 2.3. Правила рендера

`renderAdvice(advice, frame = currentFrame(), options?) : string` — сигнатура и тотальность прежние;
`renderAdviceRows(advice, frame): readonly string[]` — для слотов (`formatError`, `nextActions` MCP).

1. **Frame совета.** `f = frame`; `at` → `f = toCheckoutRoot(f)`; `shell` → `f = forShell(f, shell)`;
   `app` (≠ выбранному) → правило выбора ниже. Только этот шаг меняет frame; переходы в §3.
2. **Выбор развёртывания** (`selector(f, advice) : string[]`):
   * у совета нет `app`: нынешнее правило (`by ∈ {flag, env, sole}` → `--app <name>`; команды шлюза
     и `deploymentFree` — ничего; `none`, `cwd`, `default` — ничего);
   * `advice.app = f.app.name` и `by = cwd` → ничего; иначе совпадение → `--app <name>`;
   * **случай 4**: `advice.app ≠` выбранному, `launch` ищет развёртывание по cwd (`system`,
     `deployment-shim`, `npm-bin`), `cwd` внутри другого развёртывания и известен `places.checkoutRoot` →
     `--project-root <checkoutRoot>/apps/<app>` (bin.ts читает его первым токеном и передаёт шлюзу с
     `--app <app>`, `resolve.ts:resolveInstalledEntry`, `frameworkOwner`). Одна строка во всех shell;
   * иначе `--app <app>` (как сейчас).
3. **Fallback при отсутствии написания** (после перехода): (a) все `f.shells` пишутся одинаково → одна
   строка; (b) пишутся по-разному → основной shell (`shells[0]`); (c) ни один не пишется (bash-шим в
   `[cmd, pwsh]`) → posix-написание с примечанием `IN_BASH_NOTE` — Git Bash документированный путь
   checkout на Windows (README). Для `at: "checkout-root"` в слоте, если основная строка — не
   `checkout-shim`, `renderAdviceRows` добавляет строку bash-шима с `IN_BASH_NOTE` — это нынешняя
   «вторая строка» из `resolve.ts`/`delegate.ts`, перенесённая в рендерер (вывод не меняется).
4. **Правило P (место на цели).** `f.cwd = unknown` или (`host = target` и `cwd ≠` корню запуска) → строка
   `cd <q(root)> && <команда>`; допустимо только при `shells = [posix]` (так строятся все frame цели).
5. **ShellAdvice.** `text` дословно, если `advice.shell ∈ f.shells` или нет `alternatives` (семантика этапа 4
   сохранена); иначе — `alternatives[s]` для `s ∈ f.shells` (одна строка на различный текст; при двух —
   с примечанием shell).

### 2.4. Переход каталога в разных shell

`changeDirectory(p)` строит одну `ShellAdvice`: `shell: "posix"`, `text: cd <shellQuote(p)>`,
`alternatives.cmd = alternatives.pwsh = pushd "<p>"`, если в `p` нет `"`, `%`, `$`, backtick (`pushd`
меняет диск в cmd и есть псевдоним `Push-Location` в pwsh 5.1/7); иначе `alternatives.pwsh =
Set-Location -LiteralPath '<p с '' >'`, а `cmd` не задаётся (fallback 5 печатает posix-текст). Заменяет
`shellLine("posix", `cd ${shellQuote(checkout)}`)` в `integration/gate.ts:checkoutSubfolderReport` (D4).
Справедливость написаний подтверждается только реальными shell в S1.6 (не проверено здесь).

## 3. Переходы

Все — чистые, тотальные `Frame → Frame` в `frame.ts`; неполнота уходит в правила 2.3.

| Функция | Результат |
| --- | --- |
| `toCheckoutRoot(f)` | нет `places.checkoutRoot` → `f` (тождество; закон §7 это ловит); `launch' = system`, если был `system`, иначе `checkout-shim(checkoutRoot)`; `cwd' = dir(checkoutRoot)` (или `unknown`, если был); `app` с `by = cwd` → `by = flag` (из корня cwd развёртывание не выбирает); `shells` прежние |
| `forApp(f, name)` | выбор §2.3 п.2 как значение: `app' = {selected, name, by: flag}`; признак случая 4 вычисляется из `f` при рендере, отдельного поля нет |
| `forShell(f, s)` | `shells' = [s]`; `npm-bin` при `s = posix` остаётся (`node_modules/.bin/clawforge` — npm пишет sh-обёртку); прочее без изменений, недостающее написание — fallback (c) |
| `onTarget(t)` | конструктор, не переход: `{ launch: checkout-shim(remotePath) \| deployment-shim(dir), host: target, shells: [posix], cwd: unknown, places, app: {by: flag} \| {by: cwd} }` (§6) |

Проверки (`tools/checks/foundation/invocation/frame.check.ts`, ожидания — литералы, не вызовы продукта):

* `toCheckoutRoot` для каждого `launch` × `cwd ∈ {root, docs/, apps/demo, apps/demo/recipes}` × платформа:
  `npm-bin` win32 → строка `./clawforge new-app <name>  (in bash)`; `system` → `clawforge …` + строка
  шима; `checkout-shim` из `apps/demo` → `./clawforge`; без `checkoutRoot` → тождество.
* `forApp`: таблица (launch × cwd внутри Y/вне развёртываний/корень × `advice.app ∈ {нет, Y, X}`) →
  ожидаемый префикс (`""`, `--app X`, `--project-root /co/apps/X`).
* `forShell`: `{install completion pwsh}` под `checkout-shim` на win32 → posix + `(in bash)`, под
  `npm-bin` → `node_modules\.bin\clawforge completion pwsh`, под posix-bash → `node_modules/.bin/…`.
* Свойства: идемпотентность (`toCheckoutRoot∘toCheckoutRoot = toCheckoutRoot`), `forShell` не меняет
  `app`/`places`; `handoverOf` → `launchFromHandover` = исходный `launch` для каждого producer'а (§4).

## 4. Producers и совместимость

### 4.1. Один набор конструкторов (`frame.ts`)

| Producer | Сейчас | Станет |
| --- | --- | --- |
| корневой шим checkout (`./clawforge` → `tools/clawforge.ts`, env не пишет) | `{SHIM_PROGRAM, checkout}` литералом в `clawforge.ts` | `checkoutGateFrame(facts, handover?)`: `checkout-shim(monorepoRoot)`, `cwd = process.cwd()` |
| шим `init` (`init.ts:SHIM`) | v1 `./clawforge`/`checkout` + legacy | текст байт в байт тот же; JSON-фрагмент берётся из `handoverJson("deployment-shim")` |
| MCP launcher checkout (`mcp/project.ts`) | v1 `../../clawforge`/flag/mcp + legacy | то же, фрагмент из `frame.ts`; sha256 канонического текста не меняется |
| MCP launcher installed | env не пишет | без изменений (frame = `defaultLaunch`) |
| `defaultInvocation` (`entry/root.ts`) | program/mode по копии и платформе | `defaultLaunch(copy, roots, host, msys)`: global → `system`; checkout-копия → `checkout-shim(checkout ?? copy.path)`; локальный пакет → `[posix]` ? `deployment-shim(appRoot)` : `npm-bin(appRoot)` |
| fallback входа | `invocation()` по умолчанию `./clawforge` | убирается: frame до установки не читается (ratchet §8) |
| строгий читатель + legacy | `parseInvocation`, `parseLegacyInvokedAs` | остаются парсерами текста в `Invocation`; затем один адаптер `launchFromHandover` |
| bin.ts retry / delegate spawn | `serializeInvocation(invocation())` | `serializeInvocation(handoverOf(frame))`, frame — параметр |

`launchFromHandover(inv, facts: { cwd, checkoutRoot?, fs: FsProbe })` — классификация по файлу, на который
указывает программа, а не по написанию:

| v1/legacy `program` | Результат |
| --- | --- |
| `clawforge` | `system` |
| относительный путь, `resolve(cwd, p)` — `<checkoutRoot>/clawforge` | `checkout-shim(checkoutRoot)` |
| относительный путь, рядом лежит `app.ts` | `deployment-shim(dirname)` |
| `mode = local-package` и путь в `node_modules/.bin` | `npm-bin(корень пакета)` |
| иначе | `verbatim(program, mode)` |

### 4.2. Окно совместимости

Пакет не выпущен (`0.1.0`, тегов нет), но предрелизные tarball'ы писали шимы и launcher'ы в чужие репозитории.
Поколения, найденные в истории `init.ts`/`project.ts`:

| Поколение | Что пишет | Чтение после S1 |
| --- | --- | --- |
| G0 шим до `710cf66` | ничего | `defaultLaunch` |
| G1 шим `710cf66` | `CLAWFORGE_INVOKED_AS=./clawforge` | legacy → `deployment-shim` |
| G2 шим `a7d027e` | v1 `./clawforge`/`installed` + legacy | строгий парс отвергает (installed + `./`) → legacy → `deployment-shim` |
| G3 шим `a841c16`… | v1 `./clawforge`/`checkout` + legacy | v1 → `deployment-shim` |
| L1 launcher `f620c8a` | legacy `../../clawforge --app <name>` | → `checkout-shim`, app flag |
| L2 launcher `a7d027e`… | v1 + legacy | v1 → `checkout-shim` |
| crontab | `cd <root> && ./clawforge [--app n] job … # marker` | строка цели не меняется байт в байт (§6) |

Решение: весь 0.x читает G0–G3 и L1–L2; writers пишут G3/L2 (v1 + legacy) без изменений — старый
фреймворк в `node_modules` чужого репозитория читает новый шим. `INVOCATION_VERSION` остаётся 1; новых
полей v1 не получает (строгий парс старых версий отверг бы их). Тексты G0–G3/L1–L2 закрепляются fixture'ами
в законе (§7). Отказ от legacy-writer'а — решение владельца к 1.0 (backlog, строка 13 остаётся).

## 5. Вход: resolver frame-in/decision-out

`entry/resolve.ts` (метрика «модули, решающие режим» = 1 — это `frame.ts`; resolve решает место и развёртывание):

* `CheckoutEntryInput`: `handedOver`/`handedProgram` → `launch: Launch | undefined` (из адаптера; `undefined` —
  нет передачи). `appFact` использует `resolvesByCwd(launch)` вместо строкового `CWD_PROGRAMS`.
* `ocApp` нормализуется конструктором `appFromEnv(value)`: пустое/пробельное → не задано (D8).
* Каждое решение несёт `frame: { places, app: AppFact }`: `run` — выбранное; `gate-command` — ведущий `--app`
  (`by: flag`) или `none` (D7: консоль `clawforge --app demo list` и MCP-вызов `list` из процесса,
  обслуживающего `demo`, рендерят прозу одинаково — с `--app demo`); отказы — `none` и `checkoutRoot`.
* `InstalledEntryInput` получает `launch`; три чтения `invocation().program` для «второй строки» (`resolve.ts`
  у init в checkout и в `missingAppDecision`, `delegate.ts:appConflictRefusal`) исчезают: советы — один
  `command(…, { at: "checkout-root" })`, строку шима добавляет рендерер (2.3 п.3). Эхо `--app <typed>` в
  `appConflictRefusal` не зависит от frame: `typed` уже прошёл `safeName`, квотирование не нужно.
* `scaffold.ts:gitInitAdvice` — `renderAdvice(command(["lock"], { app: name, at: "checkout-root" }))` без
  чтения `invocation()`.

`bin.ts`, один раз и в этом порядке: `takeDelegationFlag` → `readHandover(env)` (чтение и удаление обеих
переменных; адаптер) → факты (`cwd`, платформа, `MSYSTEM`, копия пакета — `frameworkPackage()` до решения)
→ `resolveInstalledEntry({ …, launch })` → `frame = completeFrame(launch ?? defaultLaunch(copy, decision roots), decision.frame)`
→ `installFrame(frame)` → отказы/исполнение. Двойной `setInvocation` (до и после решения) исчезает, потому
что решение больше не рендерит. `delegateToOwnFramework(…, frame)` и `retryWithTypeStripping(frame)` сериализуют
переданный frame. `tools/clawforge.ts` — так же; `setInvocation({ ...invocation(), app })` заменяется
`completeFrame`.

## 6. Долговечный вывод

| Вывод | Сейчас | Станет |
| --- | --- | --- |
| cron (`schedule.ts:posixTargetInvocation`, watch/backup install) | `{cwd, SHIM_PROGRAM, args}` ручной сборкой | `scheduledInvocation(onTarget(…), argv)`: ssh → `checkout-shim(remotePath)`, `--app n`; local-posix + шим развёртывания → `deployment-shim(dir)`, без `--app`; иначе `checkout-shim(monorepoRoot)`, `--app n`. `cronLine` и маркеры — без изменений; golden и `schedule.check.ts` требуют байтового совпадения строк |
| schtasks (`printSchedulingInstructions`) | вход для WSL через `clientInvocation` | внутренняя строка — frame цели (`via: wsl`), внешняя — `cmdExeLine` как сейчас; модель закона разворачивает `/tr` → `bash -lc` |
| установка автодополнения (`installLine`, заголовки bash/zsh/pwsh, `{install …}`) | программа текущего вызова, `\` → `/` | `renderAdvice(command(argv, { shell }))` через `forShell`; если написания нет (checkout на Windows для pwsh) — fallback (c) `./clawforge completion pwsh  (in bash)` в заголовке (D6) |
| строки для сервера (`deploy/sync.ts:remoteLine`, `arguments.ts:49`) | `cd <q> && ` + `shimInvocation(name)`; в installed-режиме `commandLine("bootstrap")` текущего вызова | `onTarget({ via: ssh, launch: checkout-shim(remotePath), app: flag })` + правило P — текст `remoteLine` прежний; `arguments.ts` — `onTarget({ launch: deployment-shim(<скопированный каталог>), cwd: dir })` → `./clawforge bootstrap` (D5) |
| файлы (`init.ts`/`scaffold.ts`, «Run it with:») | `shimInvocation()` | frame шима этого развёртывания (`deployment-shim`/`checkout-shim` с `cwd = root`), текст прежний |

`shimInvocation` удаляется: все его потребители выше получают собственный frame.

## 7. Закон I12

### 7.1. Проверка

`tools/checks/surfaces/frame-law.check.ts` (группа surfaces, не exclusive, без записи в checkout):

1. **Producer'ы** — реестр `FRAME_PRODUCERS` в `tools/checks/golden/frames.ts`: каждый строится **реальным**
   конструктором на фейковой ФС из `golden/matrix.ts` (корень `/clawforge-checkout`, `/home/u/app`, …):
   корневой шим (cwd: корень, `docs/`, `apps/demo`), launcher checkout (env из `mcpLauncherContent`, извлечённый
   разбором текста, как `invocation-hints.check.ts`), шим `init` (env из `SHIM`), `defaultLaunch` (global,
   checkout-копия, локальный пакет posix/win32/Git Bash), legacy-значения G1/L1 и v1 G2/G3/L2 как fixture-строки,
   ручной `verbatim` с пробелом (`/opt/claw forge/clawforge`). Выбор развёртывания: default, `--app`, `OC_APP`,
   sole, cwd, пустой `OC_APP`.
2. **Строки** — `ADVICE_ROWS` (`golden/advice.ts`), отказы входа, токены прозы, долговечные строки §6.
3. Для каждой пары и каждого `s ∈ frame.shells` (и `s` из `advice.shell`): `renderAdviceRows` → **модель
   токенизации shell** (`tools/checks/kit/shells.ts`: posix — кавычки/`\`/`&&`; cmd — `"`-переключение, `%`,
   `&|<>^`; pwsh — `'`/`"`/`` ` ``/`$`) → `[cd?, program, ...args]` → программа разрешается на фейковой ФС в
   точку входа (шлюз checkout / `bin.js` / system) → **настоящий** `resolveCheckoutEntry` либо
   `resolveInstalledEntry` + `frameworkOwner` + `handoverArgv` в названном `cwd` и env (тот же `OC_APP`).
4. **Ожидание независимо от рендера**: команда — `advice.argv`; развёртывание — `advice.app` ?? выбранное в
   producer'е ?? `none` для команд шлюза; каталог — `places.checkoutRoot` для `at`, иначе `cwd` producer'а.
   Решение должно быть `run`/`gate-command` с этими значениями; отказ (в т.ч. `app-conflict`) — провал.
   Строки с заполнителями `<…>` подставляются примером из спецификации (правило P4 этапа 4).

### 7.2. Реальные shell (`requires(cap)`)

Модель токенизации сама проверяется вставкой в настоящий shell: временный каталог вне checkout с заглушками
`clawforge` (sh), `clawforge.cmd`, `clawforge.ps1`, `./clawforge`, `node_modules/.bin/clawforge{,.cmd,.ps1}`,
печатающими JSON `{cwd, argv}`. Подмножество — по одной строке каждой формы написания (≈ 40 строк, не вся
матрица): `requires("bash")` — `bash -c`; `requires("pwsh")` — `pwsh -NoProfile -Command`; новая способность
`cmd` (только `windows-host`, проба `cmd /d /c exit 0`) — `cmd /d /s /c`. Сверяется: заглушка запущена та,
что выбрала модель, `argv` и `cwd` совпадают с моделью. Отсутствующая способность видна как пропуск (I11).

### 7.3. Матрица и golden

`MATRIX_COLUMNS` в `golden/advice.ts` строится из `FRAME_PRODUCERS` (столбец «shim init (./clawforge,
installed)» исчезает: его не производит ни один writer — G2 отвергается строгим парсом). `expected/advice-matrix.txt`
и `entry-matrix.txt` перегенерируются в шагах, где меняется вывод; diff — часть ревью шага.

### 7.4. Отрицательные контроли (реестр S0.3)

| Правка в изолированной копии | Падает |
| --- | --- |
| вернуть `checkoutRootProgram` (`program.includes("/") ? SHIM : program`) в `toCheckoutRoot` | закон: `npm-bin` win32 в корне (D1) |
| случай 4 рендерит `--app X` | закон: `app-conflict` из `apps/Y` (D3) |
| `changeDirectory` без `alternatives` | закон под cmd (модель) и `requires("cmd")` (D4) |
| `arguments.ts` рендерит текущим frame | закон: строка цели под `node_modules\.bin` (D5) |
| `forShell` оставляет программу текущего frame | закон: `{install completion pwsh}` под checkout win32 (D6) |
| `gate-command` без `app` | закон: консоль и MCP рендерят прозу по-разному (D7) |
| `appFromEnv` принимает `""` | закон: пустой `OC_APP` → отказ вместо default (D8) |
| адаптер: `./clawforge` → `system` | `frame.check.ts` round-trip и закон (G1/G3) |
| `posixTargetInvocation` берёт launch оператора | закон: cron-строка (`cd` + программа на цели) |
| квотирование по `program.includes("/")` | закон: `verbatim` с пробелом под `[cmd, pwsh]` |

## 8. Ratchet'ы

Добавить в `architecture.check.ts` / `baseline.json`:

* `frameReads`: вызовы `invocation()`/`currentFrame()` вне `core/io/invocation/*`, `core/io/help-render.ts`,
  `core/io/log.ts`. Сейчас: `entry/resolve.ts` (3), `entry/delegate.ts` (3), `entry/bin.ts` (1),
  `integration/deployment/scaffold.ts` (1), `tools/clawforge.ts` (1) → цель 0 (S1.3).
* `frameInstalls`: места `installFrame(`/`setInvocation(` в продукте = 2 (`bin.ts`, `tools/clawforge.ts`).
* `modeDeciders`: модули с литералом `mode: "…"` / `kind: "checkout-shim" | …` (`Launch`) вне `frame.ts` → 1
  модуль (`frame.ts`); writers `init.ts`/`project.ts` интерполируют `handoverJson`.
* `programSpellingDecisions`: `.program.includes(`, `.program ===`, `.program.startsWith(` вне адаптера → 0.
* retired symbols: `checkoutRootProgram`, `shimInvocation`, `defaultInvocation`, `CWD_PROGRAMS`,
  `WINDOWS_BIN_PROGRAM` (экспорт; литерал — в таблице `spell`), поле `install`.
* Удаляются проверки, которые закон заменяет: «row 2 startsWith(SHIM_PROGRAM)» в `advice-matrix.check.ts`
  (строки 433–480) — сравнение написаний вместо разрешения.

## 9. Шаги

Порядок последовательный; каждый — один коммит с зелёным `npm run gate`. Изменение вывода — diff golden и пункт CHANGELOG.

**S1.2. Тип и конструкторы.** Файлы: `core/io/invocation/{frame.ts (новый), index.ts, render.ts, prose.ts}`,
`entry/root.ts`, `integration/deployment/init.ts`, `integration/mcp/project.ts`, `tools/clawforge.ts`, `entry/bin.ts`
(только построение через конструкторы; frame ставится в обёртку над `setInvocation`), `tools/checks/foundation/invocation/frame.check.ts`,
`golden/advice.ts` (столбцы из producer'ов). `checkoutRootProgram` удаляется: `at` → `toCheckoutRoot`; квотирование
по `shells`. Diff golden: столбец `local package (win32)` для `at: "checkout-root"`: `node_modules\.bin\clawforge
new-app <name>` → `./clawforge new-app <name>  (in bash)` одной строкой; исчезает столбец «shim init … installed»;
подсказки из подкаталогов: `../clawforge …` (если О4 принят). CHANGELOG: «Checkout refusals printed by npm's
Windows bin wrapper no longer name `node_modules\.bin\clawforge` at the checkout root, where it does not exist»;
«Hints printed from a subfolder spell the entry relative to that folder».

**S1.3. Resolver без глобалей.** Файлы: `entry/{resolve,delegate,bin}.ts`, `tools/clawforge.ts`,
`integration/deployment/scaffold.ts`, `golden/matrix.ts`, ratchet'ы `frameReads`/`frameInstalls`/`modeDeciders`.
Diff: пустой `OC_APP` выбирает как незаданный (было `invalid deployment name ""`); `clawforge --app demo list`
рендерит прозу команд развёртывания с `--app demo`, как MCP. CHANGELOG: оба пункта.

**S1.4. Подсказка с местом и shell.** Файлы: `core/io/invocation/{advice,render,prose}.ts`, `core/io/log.ts`
(`renderAdviceRows`), `integration/mcp/call.ts`, `core/command/execute.ts` (`nextActions`), `integration/gate.ts`
(`changeDirectory`), `integration/deployment/remove.ts`, `integration/completion/{index,bash,pwsh}.ts` (`shell`
вместо `install`). Diff: строка `cd` для cmd/pwsh (`pushd "<checkout>"`); `remove-app` из `apps/Y` под
`clawforge` — `clawforge --project-root <co>/apps/X destroy`. CHANGELOG: «The checkout-subfolder refusal prints
a `cd` line each shell accepts»; «Advice naming another deployment, printed inside a deployment by the
system-wide command, runs there instead of being refused as an `--app` conflict».

**S1.5. Долговечный вывод.** Файлы: `commands/operate/schedule.ts`, `commands/operate/watch/install.ts`,
`commands/lifecycle/backup/install.ts`, `commands/management/deploy/{sync,arguments}.ts`,
`integration/completion/*`, `integration/deployment/{init,scaffold}.ts`; retired `shimInvocation`. Diff: cron,
schtasks, `remoteLine` — нет (байтовое совпадение — условие шага); `deploy` в installed-режиме →
`./clawforge bootstrap`; заголовок pwsh-скрипта из checkout на Windows → `(in bash)`. CHANGELOG: оба пункта.

**S1.6. Закон.** Файлы: `tools/checks/surfaces/frame-law.check.ts`, `tools/checks/kit/shells.ts`,
`tools/checks/kit/capabilities/capabilities.ts` (`cmd`), `golden/frames.ts`, записи в реестре контролей
(§7.4), удаление заменённых ассертов `advice-matrix.check.ts`. Diff вывода продукта — нет. CHANGELOG: нет
(внутреннее), запись в реестр находок.

## 10. Риски, отвергнутые альтернативы, вопросы

**Риски.** (1) Байтовая неизменность cron/`remoteLine`/шимов — иначе повторная установка пишет «изменение» и
sha256 launcher'а перестаёт совпадать: условие шага S1.5 и golden. (2) Относительное написание из подкаталога
(О4) меняет много строк golden за раз — отдельный коммит-diff в S1.2. (3) `MSYSTEM` как признак Git Bash
наследуется не всегда (Windows `node.exe` из WSL-bash его не видит) — тогда frame `[cmd, pwsh]` и строка с `\`,
как сейчас; не хуже текущего. (4) Закон медленный при полном произведении: модель — в памяти, реальные shell —
≈ 40 строк; бюджет — как у `advice-matrix.check.ts` плюс запуск shell.

**Отвергнуто.** v2 формата передачи с полями shell/cwd — старые фреймворки отвергли бы новый шим целиком,
а всё нужное выводится из v1 и фактов входа. Отдельный тип совета `cd` — конкурирующая ветка рендерера;
`alternatives` у `ShellAdvice` расширяет существующую. Определение shell по родительскому процессу — дорого и
ненадёжно на Windows. `cd … &&` префикс для операторских строк — `&&` нет в Windows PowerShell 5.1. Одна
«безопасная во всех shell» строка для любых путей — не существует (отчёт §6 S1).

**Вопросы владельцу.**
* О1. Написание checkout для cmd/pwsh на Windows: нет (fallback «in bash», рекомендую) или `node tools\clawforge.ts`
  (новый публичный вход).
* О2. Случай 4 через `--project-root <абсолютный путь>` в подсказке (рекомендую: одна строка во всех shell) или
  две строки `cd` + команда.
* О3. Пустой `OC_APP`: «не задано» (рекомендую, как пустой `CLAWFORGE_INVOCATION`) или единый явный отказ.
* О4. Относительное написание из подкаталогов (`../clawforge`) — закрывает строку backlog P3; принять ли diff.
* О5. Лишняя строка bash-шима под `clawforge` в корне checkout — оставить (нет diff, рекомендую) или убрать.
* О6. Порядок: закон с базой нарушений (ratchet) уже в S1.2, а S1.6 только обнуляет базу и добавляет
  реальные shell — рекомендую, иначе S1.2–S1.5 идут без проверки I12.
* О7. Окно совместимости: читать G0–G3/L1–L2 весь 0.x, legacy-writer до решения о 1.0.

**Не проверено.** Ничего не запускалось (только `git show`/`grep`). Не подтверждены: `pushd "<p>"` и
`Set-Location -LiteralPath` в cmd/pwsh 5.1/7; запуск `node_modules\.bin\clawforge` в pwsh без `.\`; наследование
`MSYSTEM` до `node.exe`; что `--project-root` из ручной строки проходит все ветки `bin.ts` для несуществующего
`app.ts`; что `install` никогда не попадал в JSON `next`; точное число мест `commandLine` (135 вызовов), которым
понадобится `renderAdviceRows`, — оценено только по слотам `formatError`/`nextActions`.
