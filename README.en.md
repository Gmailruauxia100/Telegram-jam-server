# Telegram Jam

[Русский](README.md) · **English**

Listen to music together in Telegram, like Spotify Jam. Two people in a private chat get the same track, pause and position in their Telegram players at the same time.

Telegram Jam is an [exteraGram](https://exteragram.app) plugin plus a small self-hostable sync server.

## How it works

- Tracks are ordinary Telegram audio messages. When the host plays a track that the guest does not have yet (from a profile or another chat), the plugin sends a copy into the Jam chat. Copies are deleted when the Jam ends (optional).
- The server only relays room state: which track, playing or paused, position, revision. It never receives audio, calls, messages or Telegram account data. Rooms live in RAM and vanish when the Jam ends.
- Playback starts on a shared server clock, so both players start together.

## Features

- Start a Jam from the chat menu; the invite is a one-tap command.
- Play any track: from the Jam chat, from a profile music list or from another chat.
- Host and guest roles. The host can let the guest control the player.
- Local panel in Telegram's browser: seek bar, play/pause, ±10 s, participants, guest-control toggle, leave or end the Jam.
- The invite code carries the host's server address, so the guest connects to the right server with no setup.
- Update check: the server announces the latest and minimum plugin versions; outdated plugins see an update dialog that opens the plugin channel.
- Russian and English interface, following the Telegram app language.

## Install

1. Get `telegram_jam.plugin` from the [@shit_plugins](https://t.me/shit_plugins) channel (or `plugin/` in this repository).
2. Tap the file in exteraGram and install it. Both participants need the plugin.
3. The default server is `wss://jam.ltyt.me/jam`. To use your own, change **Jam server address** in the plugin settings (see [Self-hosting](docs/self-hosting.md), in Russian).

## Usage

1. Open a private chat and choose **Start Jam** in the chat menu (or send `!startjam`).
2. The other person taps the `!acceptjam <code>` command in the invite, copies it and sends it.
3. Play any track. It starts for both of you once the other client has it.
4. Open **Jam panel** from the chat menu to seek, pause, change who controls the player, leave or end the Jam.

Commands (the `!` prefix is configurable):

| Command | What it does |
|---|---|
| `!startjam` | Create a Jam and send an invite |
| `!acceptjam <code>` | Join a Jam; the server comes from the code |
| `!declinejam` | Decline an invite |
| `!jamstatus` | Show role, control mode and server |
| `!leavejam` | Leave; a leaving host hands over to the guest |
| `!endjam` | End the Jam for both (host only) |

## Settings

| Setting | Default | Notes |
|---|---|---|
| Jam server address | `wss://jam.ltyt.me/jam` | Used when you create a Jam. Guests take the host's server from the invite. |
| Default control | Host only | Whether a new Jam lets the guest control the player. |
| Delete track copies after Jam | On | Removes the copies and service messages the plugin sent. |
| Panel port | any free port | Fixed local port for the panel, e.g. `8765`. Falls back to a free port if busy. |

## Repository layout

- `plugin/` - the exteraGram plugin.
- `server/` - Node.js WebSocket server (`npm test` runs the test suite).
- `deploy/` - Nginx, Caddy and systemd examples.
- `docs/` - [protocol](docs/protocol.md), [self-hosting](docs/self-hosting.md), [privacy](docs/privacy.md) (in Russian).

## Development

```bash
cd server
npm install
npm test
```

The plugin is a single Python file for the exteraGram plugin engine. It needs `websocket-client`, which the engine installs from `__requirements__`.
