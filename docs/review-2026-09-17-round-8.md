# Общее ревью ClawForge — раунд 8

Дата: 2026-09-17. Проверенный HEAD: `faa2dcb31a18384364932ea06922b4f41d2655a6`.
Предыдущий отчёт: [раунд 7](review-2026-09-17-round-7.md).

## Итог

Последние исправления исключают credential-staging из архивов и закрывают воспроизведённые сценарии reentrancy из раунда 7. В этом проходе подтверждена **одна новая P1**: `set try` создаёт собственный gateway credential без private-file защиты. С `--keep` этот файл остаётся рядом с сохранённым trial deployment.

P0 — критическая авария; P1 — исправить до релиза; P2 — существенный ограниченный сценарий; P3 — удобство. Новых P0/P2/P3 в проверенной области не зафиксировано. До устранения P1 рекомендацию к релизу не даю. Это не доказательство отсутствия иных дефектов; коммит содержит только отчёт.

Область: текущие изменения archive/verify/lock, set try и его teardown/credentials, set artifacts/evidence, lifecycle backup/restore, apply/rollback/journal, recipe provisioning, CLI/MCP и deploy boundary. Использованы чтение исходников, полный штатный набор, изолированное воспроизведение, реальный filesystem round-trip и новый MCP-прогон приложения.

## Проверка исправлений раунда 7

| Находка | Результат |
| --- | --- |
| P1-01: migrate включал credential-staging | Общие excludes теперь покрывают `.env.clawforge-*`. Новый реальный WSL/tar fixture подтвердил исключение final .env и вложенного имени private writer из migrate. Полученный архив прошёл verifySnapshot(migrate). |
| P2-01: одинаковый path на разных targets считался одним lock | Resource key включает transport description и lock path. Регрессионная проверка второго transport получает отдельный lock. Для встроенных transports descriptions различают local/WSL distro/SSH host. Требование уникальности descriptions пользовательских adapters отдельно не гарантировано интерфейсом. |
| P2-02: отложенный descendant сохранял владение | Scope хранит изменяемый lease, release и finally отзывают его. Проверка позднего descendant при competing lock проходит. Все возможные композиции ручных runOwning/release этим не исчерпаны. |

## P1-01 — Gateway token временного set try записывается без private-file защиты

**Источник:** [set-try.ts](../tools/framework/commands/sets/set-try.ts), создание tempDir и `.env` в setTryInScope; [set-try-env.ts](../tools/framework/commands/sets/set-try-env.ts), buildEnv.

Trial создаёт deployment под `sets/.tries/<name>`, генерирует gateway token и записывает его обычным `writeFile` в `.env`. Здесь не вызываются createPrivateFile/protectPrivateDirectory и не задаются приватные права. Context читается напрямую, поэтому общий путь подготовки deployment `.env` этот файл не защищает. `--keep` сохраняет deployment; без keep окно доступа существует до cleanup.

**Воспроизведение:** использован настоящий buildSet → setTry с `--keep` на временном deployment. Создание artifact и host-файлов было настоящим; transport/runtime заменены существующим lifecycle fixture, поэтому Docker, модель и живое приложение не запускались. На родительском Windows-каталоге заранее задано наследуемое разрешение Guests. После успешного setTry проверены retained `.env` и его настоящий ACL через icacls:

- `KEPT_TRIAL_HAS_GATEWAY_TOKEN=true`;
- `KEPT_TRIAL_ENV_GRANTS_GUESTS=true`;
- `PRIVATE_FILE_CHECK_REPORTS_EXPOSURE=true` — собственная unprotectedPrivateFile фреймворка признала файл незащищённым.

Token сгенерирован только для fixture, его значение не выводилось. Чтение от отдельного Windows-account не выполнялось; доказан разрешающий ACL. Все fixture-файлы, включая сохранённый trial, удалены после проверки.

**Последствие:** пользователь с разрешённым доступом к каталогу может получить gateway credential trial-экземпляра. По коду этот экземпляр способен получать необходимые provider values из основного deployment, поэтому слово «временный» не делает доступ к нему безопасным. Работающий trial с реальными ключами и доступ постороннего к нему в тесте не создавались; утечка credentials живого приложения не установлена.

**Исправление:** создавать trial deployment/credential-файл с тем же private-file контрактом, что обычный deployment: защищённый каталог и `.env` до записи token. Сохранить диагностику Windows/WSL boundary. Проверить успешный keep, обычный teardown и отказ bootstrap; после ошибки не должен оставаться незамеченный широко доступный credential.

## Дополнительная проверка backup/restore

В отдельном временном data root WSL выполнены настоящие createArchive, tar и restoreArchive. Runtime.stop заменён пустой функцией, restore вызван с force/noStart: это файловый round-trip без остановки или замены живого приложения и без проверки запуска контейнера из восстановленных данных.

- Migrate исключил `config/.env` и вложенный `.env.clawforge-...clawforge-private-...`; verifySnapshot(migrate) прошёл.
- Full-backup сохранил synthetic credential-файл.
- После изменения бинарного content.bin выполнен restore; SHA-256 восстановленного файла совпал с исходным.
- Credential-файл присутствовал после full restore.
- Fixture, архивы и aside-копия тестовых данных удалены по завершении.

Это расширяет предыдущие проверки реальным восстановлением байтов, но не заменяет production disaster-recovery rehearsal с базой, контейнером и provider authentication.

## Практическая проверка приложения через MCP

После сборки текущего HEAD выполнен новый реальный stdio MCP-прогон по существующему `.mcp.json`: initialize → initialized → tools/list → последовательные tools/call. Прямого ClawForge connector среди инструментов текущей сессии нет, поэтому использован программный клиент по подготовленной конфигурации. Автоматическое обнаружение серверов интерфейсом не проверялось.

| Действие | Результат раунда 8 |
| --- | --- |
| Обнаружение | 33 control tools и 9 channel tools |
| inspect | healthy=true, changed=false, problems=[]; 20,1 с |
| up | Существующий gateway Running и healthy; 2,0 с |
| recipe {} и action=list | Оба запроса успешно показывают agent/MCP bundle без confirm |
| lock --check | changed=false, problems=[] |
| pull --share | Stop/archive/start/verify прошли; 177 entries, около 88 KiB; 21,7 с |
| Права нового snapshot | 600, отдельно проверено stat на target |
| Retention | Штатно удалён один старый snapshot сверх лимита 10 |
| status после backup | Runtime healthy; healthz/startupz/readyz = 200 |
| conversations_list / permissions_list_open | Пустые списки, без readiness-ошибок |
| main через control-MCP cli | status=ok; payload и visible text = REVIEW-OK; 13,2 с |

Main получил один диагностический запрос в отдельной новой сессии: вернуть REVIEW-OK без инструментов, изменений файлов и внешних сообщений. Model-use был явным через confirm; usage — 16 805 токенов. Диалог через MCP → CLI → gateway/model подтверждён. Channel conversations по-прежнему отсутствуют; другие агенты в раунде не проверялись.

Share-verifier проверил известные provider/gateway и identity-секреты без вывода значений. Внешняя symlink plugin dependency диагностирована как нефатальная. Успешный scan не исключает персональные данные или неизвестные ему ключи в workspace. Новая P1 проверялась отдельно от этого штатного backup.

## Удобство использования

Для текущего администрирования пользоваться удобно: tools обнаруживаются, есть полезные описания, inspect/lock возвращают структурированные findings, а share-backup выполняет согласованный цикл и подтверждает здоровье gateway. Изолированный restore также восстановил данные ожидаемым образом.

Диалог пока требует знания аргументов универсального CLI: agent, session-id, timeout и JSON. Отдельный agent-call с явным model-use и коротким результатом был бы удобнее. Backup/status остаются текстовыми; artifact/profile/verification fields хотелось бы получать структурированно. Inspect занимает заметное время; приведённые времена относятся к одному запуску, не к benchmark. Постоянный helper в этом раунде не использовался.

## Проверки и ограничения

- `npm test` с WSL-проверками: 77 check-файлов прошли; штатных падений не было.
- tsgo, Oxlint, build 80 файлов и actionlint обоих workflows прошли.
- ACL-воспроизведение: настоящий Windows filesystem, реальный build/setTry orchestration, моделируемый trial runtime. Не запускается реальный trial с чужими разрешениями.
- Файловое восстановление: настоящий WSL/tar/restore, синтетические данные, моделируемый stop, noStart.
- Живые изменения: share-backup/snapshot, штатная retention-ротация, краткая остановка/запуск gateway и одна отдельная сессия main. Старый snapshot удалён согласно retention; его восстановимость отдельно не проверялась.
- SSH, restore поверх живого deployment, реальная смена ключей и npm publish не выполнялись.
- Исходники продукта не менялись. Настоящие секреты и приватные пути компьютера в отчёт не включены.
