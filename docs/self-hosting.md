# Свой сервер

Сервер — один процесс Node.js без базы данных. Хватит VPS с 1 ГБ памяти: с лимитами по умолчанию он занимает до ~200 МБ.

## Что нужно

- Linux с systemd, Node.js 18 или новее.
- Домен или поддомен, указывающий на сервер, например `jam.example.com`.
- Обратный прокси для TLS: Nginx или Caddy. Используй тот, что уже стоит; не запускай оба на портах 80/443.

## 1. Скачать код

```bash
sudo useradd --system --home /opt/telegram-jam --shell /usr/sbin/nologin telegram-jam
sudo git clone https://github.com/Gmailruauxia100/Telegram-jam-server.git /opt/telegram-jam
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
| `MIN_PLUGIN_VERSION` | `0.9.0` | Плагины старее не пускаются и показывают окно обновления. |
| `LATEST_PLUGIN_VERSION` | `MIN_PLUGIN_VERSION` | Последняя опубликованная версия; у кого старее, увидят «Вышла новая версия». |
| `UPDATE_URL` | `https://t.me/shit_plugins` | Куда ведёт кнопка **Обновить**. Ссылки `t.me` открываются прямо в Telegram. |

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

Проксировать нужно и `/jam` (WebSocket), и `/` (страница сервера и `/health`). `proxy_read_timeout` держи заметно больше 25 секунд: плагин пингует сервер раз в 25 секунд, а с таймаутом Nginx по умолчанию (60 секунд) неактивные Jam могут обрываться.

## 5. Проверить

```bash
curl https://jam.example.com/health
# {"ok":true,"rooms":0,"clients":0,"server_version":"0.9.0","protocol":2,
#  "min_plugin_version":"0.9.0","latest_plugin_version":"0.9.0","update_url":"https://t.me/shit_plugins"}
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

Когда выкладываешь новую версию плагина в канал, пропиши её в `LATEST_PLUGIN_VERSION` и перезапусти сервер: у пользователей появится «Вышла новая версия» с кнопкой в канал. Чтобы заставить всех обновиться (например, после изменения протокола), подними ещё и `MIN_PLUGIN_VERSION`.

## Если что-то не работает

- **Jam обрывается примерно через минуту** — прокси закрывает неактивные WebSocket-соединения. Увеличь `proxy_read_timeout` (Nginx) или проверь другие прокси и CDN перед сервером.
- **«Не удалось подключиться к Jam-серверу»** — проверь `systemctl status telegram-jam`, настройку `/jam` в прокси и что адрес начинается с `wss://` и заканчивается на `/jam`.
- **502 от Nginx** — служба не запущена или слушает не тот порт, что указан в `proxy_pass`.
- Логи: `journalctl -u telegram-jam -f`.
