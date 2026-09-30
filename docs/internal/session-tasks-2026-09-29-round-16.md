# Сессионные задачи: ревью раунда 16

Основание: [статическое ревью XS, раунд 16](review-2026-09-29-xs-round-16.md).

| Задача | Приоритет | Статус |
| --- | --- | --- |
| R16-01: loader рецептов в установленном npm-пакете | P2 | закрыта: source/dist URL и packed-consumer hook проверены |
| R16-02: учитывать security gate в acceptance receipt | P2 | закрыта: blocking gate исключает verified, legacy projection честно понижается |
| R16-03: общая read/merge/write транзакция crontab | P2 | закрыта: target account flock удерживается до записи |
| R16-04: фактический `started` в restore JSON | P3 | закрыта: outcome разделяет восстановленные данные и запуск gateway |

После объединения прошли 176 check-файлов; capability-пропуски: GNU userland (2),
Linux host (3), SSH loopback (1). Account lock отдельно проверен через WSL с реальным
flock и искусственным crontab, включая concurrency и освобождение после аварии.
Typecheck, Oxlint, build, pack dry-run и actionlint прошли. Исправления фиксируются
локальным коммитом перед новым статическим ревью.
