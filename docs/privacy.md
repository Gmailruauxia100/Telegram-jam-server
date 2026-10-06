# Privacy

Telegram Jam server stores only temporary in-memory room data required to synchronize playback:

- random room IDs and opaque access-token hashes;
- participant connection state;
- track reference and optional display title supplied by the clients;
- playback position, play/pause status, revision, and timestamps;
- the plugin version, used only to tell outdated clients to update.

It does not receive, proxy, store, or analyze:

- audio files or audio streams;
- Telegram login sessions, API tokens, phone numbers, or contacts;
- Telegram call audio;
- chat messages, except room data deliberately sent by the plugin;
- music-service credentials.

Rooms are removed from memory on explicit end, inactivity timeout, empty-room timeout, or process restart. The server uses no database.
