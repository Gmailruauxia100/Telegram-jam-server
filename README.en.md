# Telegram Jam

[Русский](README.md) · **English**

Listen to music together in Telegram, like Spotify Jam. Up to 5 people hear the same track, with pause, seeking and position synced in the regular Telegram player.

Telegram Jam is an [exteraGram](https://exteragram.app) plugin plus a small self-hostable sync server.

## How it works

- One person creates the lobby: the **creator**. Each guest is invited in their private chat with the creator, and tracks travel through those chats: whoever lacks a track gets a copy from the creator's plugin. Copies are deleted when the Jam ends (optional).
- The **host** controls the player, kicks members and hands over the host role. The creator starts as host; the role can go to anyone.
- If the host leaves or is offline for more than 15 seconds, another online member becomes host. If the creator leaves, the lobby goes on and the creator role (inviting and sharing tracks) moves to the host. The lobby closes only when nobody is left or someone presses "End Jam".
- If the connection drops, the plugin reconnects by itself (for up to 90 seconds) and returns to the same lobby. If Telegram crashes or is closed, the plugin rejoins after it starts again, as long as the lobby is alive (an offline member is kept for 2 minutes).
- The panel opens inside Telegram, like a mini app.
- The server only relays room state: members, which track, playing or paused, position. It never receives audio, calls, messages or Telegram account data. Rooms live in RAM and vanish when the Jam ends.
- Playback starts on a shared server clock, so both players start together.

## Features

- Lobbies of up to 5 people on the public server. On your own server, set `MAX_PARTICIPANTS` in `server/.env` (2–50) and restart it; see [self-hosting](docs/self-hosting.md#сколько-человек-в-лобби).
- Start a Jam from the chat menu; "Invite to Jam" adds more people. Invite codes work once and for 5 minutes.
- Everyone sees who joins and leaves. The host can hand over the host role, kick members and unban them.
- Play any track: from the Jam chat, from a profile music list or from another chat.
- The host can let everyone control the player.
- Panel right inside Telegram: seek bar, play/pause, ±10 s, members, block list. Optionally a "🎵 Jam" tab among chat folders.
- The invite code carries the server, the room code and a one-time ticket, so guests connect with no setup.
- Update check: the plugin looks for a new version on start (can be turned off), and the server refuses plugins that are too old.
- Russian and English interface, following the Telegram app language.

## Install

1. Get `telegram_jam.plugin` from the [@shit_plugins](https://t.me/shit_plugins) channel (or `plugin/` in this repository).
2. Tap the file in exteraGram and install it. Both participants need the plugin.
3. The default server is `wss://jam.ltyt.me/jam`. To use your own, change **Jam server address** in the plugin settings (see [Self-hosting](docs/self-hosting.md), in Russian).

## Usage

1. Open a private chat and choose **Start Jam** in the chat menu (or send `!startjam`).
2. The other person taps the `!acceptjam <code>` command in the invite, copies it and sends it. The code works once and for 5 minutes.
3. To add people, open a private chat with each and choose **Invite to Jam**.
4. Play any track. It starts for everyone once each client has it (up to a 20 second wait).
5. **Jam panel** in the chat menu: seek, pause, members, host transfer, kick and block list.

Commands (the `!` prefix is configurable):

| Command | What it does |
|---|---|
| `!startjam` | Create a lobby and invite this person |
| `!invitejam` | Invite this person to your lobby (creator only) |
| `!acceptjam <code>` | Join a lobby; the server comes from the code |
| `!declinejam` | Decline an invite |
| `!jamstatus` | Show role, members and server |
| `!leavejam` | Leave; the lobby goes on without you |
| `!endjam` | End the Jam for everyone (host or creator) |

## Settings

| Setting | Default | Notes |
|---|---|---|
| Jam server address | `wss://jam.ltyt.me/jam` | Used when you create a lobby. Guests take the server from the invite. |
| Check server | — | Connect to the configured server and show ping, version, lobby size and whether it accepts this plugin. |
| Default control | Host only | Whether everyone may control the player in a new lobby. |
| Delete track copies after Jam | On | Removes the track copies and invites the plugin sent. |
| Jam tab in folders | Off | Experimental: while in a Jam, a tab among chat folders opens the panel. Needs chat folders. |
| Panel port | any free port | Fixed local port for the panel, e.g. `8765`. Falls back to a free port if busy. |
| Check for updates | On | Look for a new version on start. Only notifies. "Check now" is next to it. |

## Repository layout

- `plugin/` - the exteraGram plugin.
- `server/` - Node.js WebSocket server (`npm test` runs the test suite).
- `deploy/` - Nginx, Caddy and systemd examples.
- `cloud/update-info/` - the update-check function for Yandex Cloud (in Russian).
- `docs/` - [protocol](docs/protocol.md), [self-hosting](docs/self-hosting.md), [privacy](docs/privacy.md) (in Russian).

## Development

```bash
cd server
npm install
npm test
```

The plugin is a single Python file for the exteraGram plugin engine. It needs `websocket-client`, which the engine installs from `__requirements__`.
