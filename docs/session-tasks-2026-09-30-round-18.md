# Сессионные задачи: ревью раунда 18

Основание: [статическое ревью XS, раунд 18](review-2026-09-30-xs-round-18.md).

| Задача | Приоритет | Статус |
| --- | --- | --- |
| R18-01: скрыть credential query в egress endpoint/detail | P1 | закрыта: единая очистка публичных URL и probe detail, исходный URL сохранён для probe |
| R18-02: сериализовать heartbeat publication и release | P2 | закрыта: общий mutation guard, single-flight refresh и cancellation/drain перед удалением |

Профильный набор: 10 check-файлов прошли. Общий набор: 178 из 179
выполненных check-файлов прошли; layout отказал из-за восьмой записи в
instance-lock. Heartbeat-проверки сгруппированы в подкаталог; адресный повтор
layout и обеих heartbeat-проверок прошёл (3 файла). Capability-пропуски:
GNU userland (2), Linux host (3), SSH loopback (1).

Исправлена типизация string/Uint8Array stdin в новой egress fixture.
Typecheck, Oxlint, build и pack dry-run прошли. Отдельные smoke-сценарии
подтвердили очистку endpoint/detail и передачу lock следующему владельцу
после задержанной heartbeat-записи с последующим удалением lock.
Smoke lock использовал управляемый transport; живые SSH/WSL target не проверялись.
Документация и changelog обновлены. Исправления фиксируются локально
перед ревью раунда 19.
