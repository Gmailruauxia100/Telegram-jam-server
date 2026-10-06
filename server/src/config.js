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
  // Plugins older than this are refused with "client_outdated".
  minPluginVersion: process.env.MIN_PLUGIN_VERSION || "0.9.0",
  // Newest published plugin; newer than the user's one shows "update available".
  latestPluginVersion: process.env.LATEST_PLUGIN_VERSION || process.env.MIN_PLUGIN_VERSION || "0.9.0",
  // Where the plugin's "Update" button leads: the channel the plugin is published in.
  updateUrl: process.env.UPDATE_URL || "https://t.me/shit_plugins"
};
