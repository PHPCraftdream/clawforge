# Сессионные задачи: ревью раунда 22

Основание: [статическое ревью XS, раунд 22](review-2026-09-30-xs-round-22.md).

| Задача | Приоритет | Статус |
| --- | --- | --- |
| R22-01: однозначная recipe pair identity | P2 | закрыта: SHA-256 сериализованной пары, безопасный cutover и настоящий Docker smoke |
| R22-02: restore/push ownership preflight | P2 | закрыта: inventory до stop/move/extract под lock, report использует подтверждённую observation |

Воспроизведена конкатенационная коллизия пары namespace/recipe. До restore fix
автономный public API witness с настоящими POSIX файлами/tar показал для legacy,
foreign и unknown policy в restore/no-start/push: данные уже B, gateway stopped,
события stop/mv/tar и потерянный current secrets file. После fix те же девять
сценариев сохраняют A, running state, sentinel secrets и не имеют mutation events.

После fix прошёл и настоящий WslTransport/Docker smoke с controlled HTTP/data
gateway и остановленными Compose recipe containers: все девять policy refusals,
lock-free preview, cutover → восстановление B/start/HTTP health, truthful no-start
и push с установкой snapshot secrets. Это не upstream OpenClaw. Свои контейнеры
и временные trees удалены в finally.

Linux clean node:24 verification прошёл: recipe identity и restore ownership
(2 check-файла), typecheck/Oxlint. Исправлена типизация восстановления предыдущего
selected deployment и удалён before-bug mode из permanent regression. Restore
checks сгруппированы по layout limit; fixture namespace теперь валиден независимо
от basename/случайного mkdtemp suffix. Адресный layout/restore/backup набор прошёл
(3 файла), typecheck/Oxlint прошли. Build и pack dry-run прошли.

Полный recipe smoke прошёл на настоящем WslTransport/Docker для same-basename
и неоднозначной пары из ревью: actual A/B HTTP/bind/volume data, status/logs,
reinstall/remove/--volumes, own backup discovery/quiesce, foreign/stopped predecessor
refusals, explicit cutover и default lifecycle. Свои containers/volumes/networks/temp
trees и все throwaway scripts удалены; image не удалялся.

Общий набор: 179 из 183 выполненных check-файлов прошли; 7 capability-пропусков
(GNU userland — 2, Linux host — 4, SSH loopback — 1). Четыре отказа были неполными
fixture contexts: явно заданы валидные Docker namespaces; symlink boundary fixture
выбирает свой deployment/пустой recipes root перед обязательным preflight.
Адресный повтор всех четырёх файлов прошёл; typecheck/Oxlint прошли.
Исправления и результаты фиксируются перед раундом 23.

После коммита `9e1762d` свежий общий прогон прошёл: 183 check-файла,
7 capability-пропусков с тем же breakdown. Финальный Linux clean node:24
прогон restore ownership/recipe identity/lifecycle hooks/pull privacy прошёл:
4 check-файла, typecheck и Oxlint. Это полный passing-after результат.
