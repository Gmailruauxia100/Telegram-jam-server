function readInteger(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    return fallback;
  }
  return value;
}

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: readInteger("PORT", 3000, 1, 65535),
  pathname: process.env.PATHNAME || "/jam",
  maxRooms: readInteger("MAX_ROOMS", 100, 1, 10000),
  maxConnections: readInteger("MAX_CONNECTIONS", 200, 1, 50000),
  maxMessageBytes: readInteger("MAX_MESSAGE_BYTES", 4096, 256, 65536),
  maxEventsPerSecond: readInteger("MAX_EVENTS_PER_SECOND", 10, 1, 1000),
  emptyRoomMs: readInteger("EMPTY_ROOM_MS", 300000, 1000, 86400000),
  inactiveRoomMs: readInteger("INACTIVE_ROOM_MS", 1800000, 1000, 86400000),
  maxRoomLifetimeMs: readInteger("MAX_ROOM_LIFETIME_MS", 21600000, 1000, 604800000),
  cleanupIntervalMs: readInteger("CLEANUP_INTERVAL_MS", 30000, 1000, 3600000),
  // Lobby size. The public server uses 5; self-hosters pick their own.
  maxParticipants: readInteger("MAX_PARTICIPANTS", 5, 2, 50),
  // How long a one-time invite ticket stays valid.
  inviteTtlMs: readInteger("INVITE_TTL_MS", 300000, 30000, 86400000),
  // A member whose connection is gone this long leaves the lobby (a lost creator passes its role on).
  memberGraceMs: readInteger("MEMBER_GRACE_MS", 120000, 5000, 3600000),
  // A host that lost its connection this long hands the host role to someone online.
  hostHandoffMs: readInteger("HOST_HANDOFF_MS", 15000, 1000, 600000),
  // Plugins older than this are refused with "client_outdated".
  minPluginVersion: process.env.MIN_PLUGIN_VERSION || "0.10.0",
  // Where the plugin's "Update" button leads when the server refuses a version.
  updateUrl: process.env.UPDATE_URL || "https://t.me/shit_plugins"
};
