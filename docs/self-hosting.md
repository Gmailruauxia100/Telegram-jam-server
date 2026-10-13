# Свой сервер

Сервер — один процесс Node.js без базы данных. Хватит VPS с 1 ГБ памяти: с лимитами по умолчанию он занимает до ~200 МБ.

## Что нужно

- Linux с systemd, Node.js 18 или новее.
- Домен или поддомен, указывающий на сервер, например `jam.example.com`.
- Обратный прокси для TLS: Nginx или Caddy. Используй тот, что уже стоит; не запускай оба на портах 80/443.

## 1. Скачать код

```bash
sudo useradd --system --home /opt/telegram-jam --shell /usr/sbin/nologin telegram-jam
sudo git clone https://github.com/<you>/telegram-jam.git /opt/telegram-jam
cd /opt/telegram-jam/server
sudo npm ci --omit=dev
sudo cp .env.example .env
sudo chown -R telegram-jam:telegram-jam /opt/telegram-jam
```

## 2. Настроить

Настройки лежат в `/opt/telegram-jam/server/.env`. Для большинства случаев подходят значения по умолчанию:

| Переменная | По умолчанию | Что значит |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Адрес, который слушает сервер. За прокси оставь localhost. |
| `PATHNAME` | `/jam` | Путь WebSocket. Плагин рассчитан на `/jam` и для него делает код приглашения короче. |
| `MAX_ROOMS` / `MAX_CONNECTIONS` | `100` / `200` | Жёсткие лимиты. |
| `MAX_EVENTS_PER_SECOND` | `10` | Лимит сообщений в секунду на одно соединение. |
| `EMPTY_ROOM_MS` / `INACTIVE_ROOM_MS` / `MAX_ROOM_LIFETIME_MS` | 5 мин / 30 мин / 6 ч | Когда удаляются пустые, неактивные и все комнаты. |
| `MAX_PARTICIPANTS` | `5` | Сколько человек может быть в лобби (2–50). |
| `INVITE_TTL_MS` | `300000` (5 мин) | Сколько живёт одноразовый билет приглашения. |
| `MEMBER_GRACE_MS` | `120000` (2 мин) | Через сколько отключившийся участник выбывает из лобби; если это создатель, его роль переходит к хосту. |
| `HOST_HANDOFF_MS` | `15000` (15 с) | Через сколько хост без связи отдаёт роль хоста участнику в сети. |
| `MIN_PLUGIN_VERSION` | `0.10.0` | Плагины старее не пускаются и показывают окно с отказом. |
| `UPDATE_URL` | `https://t.me/shit_plugins` | Куда ведёт кнопка **Обновить** в этом окне. Ссылки `t.me` открываются прямо в Telegram. |

### Сколько человек в лобби

Размер лобби задаёт сервер, а не плагин. Чтобы пускать больше (или меньше) людей:

1. Открой `/opt/telegram-jam/server/.env` (если файла нет — скопируй `.env.example`).
2. Поменяй строку `MAX_PARTICIPANTS=5`, например на `MAX_PARTICIPANTS=10`. Допустимо от 2 до 50.
3. Перезапусти сервер: `sudo systemctl restart telegram-jam`.
4. Проверь `curl https://jam.example.com/health`: в ответе должно быть `"max_participants":10`. То же покажет кнопка **Проверить сервер** в настройках плагина.

Новое значение действует для лобби, созданных после перезапуска. Плагин ничего настраивать не нужно: он берёт лимит у сервера. На публичном `wss://jam.ltyt.me/jam` лимит 5 и не меняется — для большего лобби нужен свой сервер.

Каждый гость получает треки через личный чат с создателем лобби, поэтому чем больше людей, тем больше копий трека создатель отправляет. Telegram ограничивает частоту отправки, так что больше 10–15 человек ставить не стоит.

## 3. Запустить как службу

```bash
sudo cp /opt/telegram-jam/deploy/telegram-jam.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-jam
systemctl status telegram-jam
```

## 4. Обратный прокси

**Caddy** (сам получает сертификат): добавь блок из `deploy/Caddyfile.example` в свой Caddyfile, подставь домен и перезагрузи Caddy.

**Nginx**: скопируй `deploy/nginx.conf.example` в `/etc/nginx/sites-available/telegram-jam`, замени `jam.example.com`, получи сертификат (`sudo certbot certonly --nginx -d jam.example.com`), включи сайт и выполни `sudo nginx -t && sudo systemctl reload nginx`.

Проксировать нужно и `/jam` (WebSocket), и `/` (страница сервера и `/health`). `proxy_read_timeout` держи больше 10 секунд (плагин пингует сервер раз в 10 секунд); значения Nginx по умолчанию (60 секунд) хватает. Если связь всё же оборвётся, плагин переподключится сам.

## 5. Проверить

```bash
curl https://jam.example.com/health
# {"ok":true,"rooms":0,"clients":0,"server_version":"0.11.0","protocol":3,
#  "min_plugin_version":"0.10.0","max_participants":5,"update_url":"https://t.me/shit_plugins"}
```

Потом укажи `wss://jam.example.com/jam` в поле **Адрес Jam-сервера** в плагине и запусти Jam. Гостям ничего менять не нужно: адрес твоего сервера зашит в код приглашения.

## Обновление

```bash
cd /opt/telegram-jam
sudo -u telegram-jam git pull
cd server && sudo -u telegram-jam npm ci --omit=dev
sudo systemctl restart telegram-jam
```

Перезапуск сбрасывает активные комнаты: участникам нужно просто запустить Jam заново.

О новых версиях плагина пользователей предупреждает [функция проверки обновлений](../cloud/update-info/README.md): достаточно выпустить релиз на GitHub. Сервер в этом не участвует. Чтобы заставить всех обновиться (например, после изменения протокола), подними `MIN_PLUGIN_VERSION` и перезапусти сервер.

## Если что-то не работает

- **Jam обрывается примерно через минуту** — прокси закрывает неактивные WebSocket-соединения. Увеличь `proxy_read_timeout` (Nginx) или проверь другие прокси и CDN перед сервером.
- **«Не удалось подключиться к Jam-серверу»** — проверь `systemctl status telegram-jam`, настройку `/jam` в прокси и что адрес начинается с `wss://` и заканчивается на `/jam`.
- **502 от Nginx** — служба не запущена или слушает не тот порт, что указан в `proxy_pass`.
- Логи: `journalctl -u telegram-jam -f`.
