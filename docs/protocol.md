# WebSocket Protocol

Connect through `wss://your-domain.example/jam`. Messages are UTF-8 JSON objects and must not exceed 4 KiB by default.

Every client message has a `type` field. Every server response has a `type` field and may include the original `request_id`.

## Versions

On connect the server sends `hello`:

```json
{"type":"hello","server_time_ms":1760000000000,"max_rooms":100,
 "server_version":"0.9.0","protocol":2,
 "min_plugin_version":"0.9.0","latest_plugin_version":"0.9.0",
 "update_url":"https://t.me/shit_plugins"}
```

`create_room`, `join_room` and `resume_room` must include `"client_version":"0.9.0"` (and `"protocol":2`). A missing or lower version than `min_plugin_version` is refused:

```json
{"type":"error","code":"client_outdated","client_version":"0.8.1",
 "server_version":"0.9.0","protocol":2,"min_plugin_version":"0.9.0",
 "latest_plugin_version":"0.9.0","update_url":"https://t.me/shit_plugins"}
```

The plugin shows an update dialog with both versions; **Update** opens `update_url` (the plugin channel by default). `GET /health` includes the same version fields.

## Create A Room

Client:

```json
{"type":"create_room","request_id":"local-id","client_version":"0.9.0","protocol":2}
```

Server:

```json
{
  "type":"room_created",
  "request_id":"local-id",
  "room_id":"...",
  "leader_token":"...",
  "invite_code":"...",
  "expires_at":1760000000000
}
```

The plugin sends the short one-time `invite_code` to the other person in a visible Telegram invitation. The room ID and leader token never appear in the invitation. Tokens must not be logged or placed in public URLs.

## Join A Room

Client:

```json
{"type":"join_room","invite_code":"<raw secret from the packed code>"}
```

The invite code is single-use: 10 random bytes, base64url.

### Invite code in the chat

The plugin does not send the raw `invite_code`. It packs the code together with the server address, so the guest connects to the host's server even if their own settings point elsewhere (the guest's settings are not changed):

```
base64url( header(1) | secret(n) | address XOR keystream | tag(2) )
```

- `header`: `0x80` marker, `0x40` for `ws://` (otherwise `wss://`), `0x20` when the path is the default `/jam` (then it is omitted), low 5 bits are `n`;
- `address`: `host[:port]` plus the path when it is not `/jam`;
- `keystream`: `SHA-256("telegram-jam:" | secret | counter)` blocks;
- `tag`: first 2 bytes of `SHA-256("telegram-jam-tag:" | header | secret | address)`, rejects partially copied codes.

This hides the address from a casual reader and keeps the code around 38 characters for `wss://jam.example.com/jam`. It is obfuscation, not access control: anyone holding the whole code can join, exactly as before, and the code stops working after the first join. Codes that do not decode are treated as legacy raw codes for the server in the guest's settings. A successful join returns a `guest_token`; keep it locally for reconnecting to the same room.

## Resume A Room

Client:

```json
{"type":"resume_room","room_id":"...","role":"leader","token":"..."}
```

`role` is `leader` or `guest`. The server broadcasts `peer_presence` whenever a participant connects or disconnects.

## Playback State

The leader can always update playback state. The guest can do it too while `control_mode` is `both`:

```json
{
  "type":"set_state",
  "room_id":"...",
  "leader_token":"...",
  "state":{
    "track":{
      "id":"telegram-message-reference",
      "dialog_id":123456,
      "message_id":42,
      "title":"Track title",
      "duration_ms":210000
    },
    "playing":true,
    "position_ms":42000,
    "start_at_server_ms":1760000000000,
    "revision":3
  }
}
```

The server validates and broadcasts this state as `room_state`. It does not download, proxy, or inspect the track. `dialog_id` and `message_id` let each plugin instance find the same already-visible Telegram audio message in the shared private chat.

## Track Readiness

Before the leader starts a new track, the plugin sends `offer_track` to the guest:

```json
{
  "type":"offer_track",
  "room_id":"...",
  "leader_token":"...",
  "track":{"id":"...","dialog_id":123456,"message_id":42,"title":"Track title","duration_ms":210000}
}
```

The guest checks its local Telegram message cache/database and reports exactly one status:

```json
{"type":"track_status","room_id":"...","track_id":"...","status":"ready"}
```

or:

```json
{"type":"track_status","room_id":"...","track_id":"...","status":"missing"}
```

The server forwards that status to the leader. Only after `ready` does the leader send `set_state` with a shared start time. This avoids starting a track before the second client can resolve it.

## Track Fields

Besides `id`, `dialog_id`, `message_id`, `title`, `document_id` and `duration_ms`, a track may include:

- `source` - `chat` (picked inside the Jam chat, default), `profile` (started from a profile music list or another chat and copied into the Jam chat), or `external`;
- `temporary` - `true` when the message is a service copy the plugin deletes after the Jam;
- `performer` - optional artist name, up to 128 characters.

The server drops any other fields before storing or forwarding a track.

## Revisions

The server owns `state.revision`. Each accepted `set_state` gets `max(previous + 1, client revision)`, so revisions always grow even when both participants control the player. The broadcast `room_state` also carries `state.updated_by` (`leader` or `guest`). `position_ms` is clamped to `duration_ms`.

## Control Mode

`set_control_mode` is leader-only and takes `leader` or `both`. Everyone receives `control_mode`. If the leader switches back to `leader` while a guest-offered track is still waiting for readiness, the server cancels it:

```json
{"type":"track_cancelled","room_id":"...","track_id":"...","reason":"control_mode_changed"}
```

## Other Messages

- `get_state` - returns the current `room_state`.
- `ping` - returns `pong` with server time. The plugin sends it every 25 seconds so reverse proxies do not drop idle connections.
- `end_room` - leader-only; closes the room for both participants.
- `leave_room` - leaves the room. When the leader leaves while the guest is online, the guest becomes the leader (`role_changed`).
- `end_for_all` - either participant closes the room for both; used when the related call ends.

## Limits

- two participants per room;
- one active track state per room;
- up to 100 rooms and 200 WebSocket connections by default;
- no more than 10 client events per second;
- room state is limited to 4 KiB messages;
- empty rooms expire after 5 minutes, inactive rooms after 30 minutes, and all rooms after 6 hours.
