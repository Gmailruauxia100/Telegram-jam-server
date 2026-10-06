# Self-hosting

The server is a single Node.js process with no database. A VPS with 1 GB RAM is plenty; the default limits keep it under ~200 MB.

## Requirements

- Linux with systemd, Node.js 18 or newer.
- A domain or subdomain pointing to the server, e.g. `jam.example.com`.
- A reverse proxy for TLS: Nginx or Caddy. Use the one you already have; do not run both on ports 80/443.

## 1. Get the code

```bash
sudo useradd --system --home /opt/telegram-jam --shell /usr/sbin/nologin telegram-jam
sudo git clone https://github.com/<you>/telegram-jam.git /opt/telegram-jam
cd /opt/telegram-jam/server
sudo npm ci --omit=dev
sudo cp .env.example .env
sudo chown -R telegram-jam:telegram-jam /opt/telegram-jam
```

## 2. Configure

Edit `/opt/telegram-jam/server/.env`. The defaults are fine for most setups:

| Variable | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Listen address. Keep it on localhost behind the proxy. |
| `PATHNAME` | `/jam` | WebSocket path. Plugins assume `/jam` and pack shorter invite codes for it. |
| `MAX_ROOMS` / `MAX_CONNECTIONS` | `100` / `200` | Hard limits. |
| `MAX_EVENTS_PER_SECOND` | `10` | Per-connection rate limit. |
| `EMPTY_ROOM_MS` / `INACTIVE_ROOM_MS` / `MAX_ROOM_LIFETIME_MS` | 5 min / 30 min / 6 h | Room expiry. |
| `MIN_PLUGIN_VERSION` | `0.9.0` | Older plugins are refused and shown an update dialog. |
| `LATEST_PLUGIN_VERSION` | `MIN_PLUGIN_VERSION` | Newest published plugin; older plugins show "a new version is available". |
| `UPDATE_URL` | `https://t.me/shit_plugins` | Where the plugin's **Update** button leads. `t.me` links open inside Telegram. |

## 3. Run as a service

```bash
sudo cp /opt/telegram-jam/deploy/telegram-jam.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-jam
systemctl status telegram-jam
```

## 4. Reverse proxy

**Caddy** (gets certificates automatically): add `deploy/Caddyfile.example` to your Caddyfile with your domain and reload Caddy.

**Nginx**: copy `deploy/nginx.conf.example` to `/etc/nginx/sites-available/telegram-jam`, replace `jam.example.com`, get a certificate (`sudo certbot certonly --nginx -d jam.example.com`), enable the site and run `sudo nginx -t && sudo systemctl reload nginx`.

Both `/jam` (WebSocket) and `/` (landing page and `/health`) must be proxied. Keep `proxy_read_timeout` well above 25 s: the plugin pings every 25 s, and Nginx's default 60 s timeout would otherwise close idle Jams.

## 5. Check it

```bash
curl https://jam.example.com/health
# {"ok":true,"rooms":0,"clients":0,"server_version":"0.9.0","protocol":2,
#  "min_plugin_version":"0.9.0","latest_plugin_version":"0.9.0","update_url":"https://t.me/shit_plugins"}
```

Then set `wss://jam.example.com/jam` as **Jam server address** in the plugin and start a Jam. Guests do not need to change anything: the invite code carries your server address.

## Updating

```bash
cd /opt/telegram-jam
sudo -u telegram-jam git pull
cd server && sudo -u telegram-jam npm ci --omit=dev
sudo systemctl restart telegram-jam
```

A restart drops active rooms; participants just start a new Jam.

After publishing a new plugin in the channel, set `LATEST_PLUGIN_VERSION` to its version and restart: users get "a new version is available" with a button to the channel. To force everyone to update (for example after a protocol change), also raise `MIN_PLUGIN_VERSION`.

## Troubleshooting

- **Jam ends after about a minute**: the proxy closes idle WebSockets. Raise `proxy_read_timeout` (Nginx) or check other proxies/CDNs in front.
- **"Could not connect to the Jam server"**: check `systemctl status telegram-jam`, the proxy config for `/jam`, and that the address starts with `wss://` and ends with `/jam`.
- **502 from Nginx**: the service is not running or listens on another port than `proxy_pass`.
- Logs: `journalctl -u telegram-jam -f`.
