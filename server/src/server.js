import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";

const landingPage = readFileSync(new URL("../public/index.html", import.meta.url));
const serverVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const PROTOCOL_VERSION = 2;

export function compareVersions(left, right) {
  const parse = (value) => String(value ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function validVersion(value) {
  return typeof value === "string" && /^\d{1,4}(\.\d{1,4}){0,3}$/.test(value);
}

function opaqueToken() {
  return randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("base64url");
}

function sameToken(token, expectedHash) {
  return typeof token === "string" && hashToken(token) === expectedHash;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validState(value) {
  if (!isPlainObject(value) || !validTrack(value.track)) {
    return false;
  }
  return (
    typeof value.playing === "boolean" &&
    Number.isInteger(value.position_ms) && value.position_ms >= 0 &&
    Number.isInteger(value.start_at_server_ms) && value.start_at_server_ms >= 0 &&
    Number.isInteger(value.revision) && value.revision >= 0
  );
}

function validTrack(track) {
  if (!isPlainObject(track)) {
    return false;
  }
  return (
    boundedString(track.id) &&
    boundedString(track.title || "untitled") &&
    Number.isSafeInteger(track.dialog_id) && track.dialog_id > 0 &&
    Number.isSafeInteger(track.message_id) && track.message_id !== 0 &&
    (track.document_id === undefined || boundedString(track.document_id, 32)) &&
    (track.duration_ms === undefined || (Number.isInteger(track.duration_ms) && track.duration_ms >= 0)) &&
    (track.source === undefined || TRACK_SOURCES.has(track.source)) &&
    (track.temporary === undefined || typeof track.temporary === "boolean") &&
    (track.performer === undefined || boundedString(track.performer, 128))
  );
}

const TRACK_SOURCES = new Set(["chat", "profile", "external"]);

// Store only known track fields so clients cannot push arbitrary payloads
// through the room state. "source" lets clients tell tracks started from a
// profile/another chat apart from tracks picked inside the Jam chat.
function sanitizeTrack(track) {
  const clean = {
    id: track.id,
    title: boundedString(track.title) ? track.title : "Аудио",
    dialog_id: track.dialog_id,
    message_id: track.message_id,
    source: TRACK_SOURCES.has(track.source) ? track.source : "chat",
    temporary: track.temporary === true
  };
  if (track.document_id !== undefined) {
    clean.document_id = track.document_id;
  }
  if (track.duration_ms !== undefined) {
    clean.duration_ms = track.duration_ms;
  }
  if (boundedString(track.performer, 128)) {
    clean.performer = track.performer;
  }
  return clean;
}

function publicState(room) {
  return {
    type: "room_state",
    room_id: room.id,
    state: room.state,
    control_mode: room.controlMode,
    participants: {
      leader: room.leaderName,
      guest: room.guestName,
      leader_connected: Boolean(room.leaderSocket),
      guest_connected: Boolean(room.guestSocket)
    },
    server_time_ms: Date.now()
  };
}

export function createJamServer(config) {
  const minPluginVersion = config.minPluginVersion || "0.0.0";

  const latestPluginVersion = compareVersions(config.latestPluginVersion, minPluginVersion) > 0
    ? config.latestPluginVersion
    : minPluginVersion;

  function versionInfo() {
    return {
      server_version: serverVersion,
      protocol: PROTOCOL_VERSION,
      min_plugin_version: minPluginVersion,
      latest_plugin_version: latestPluginVersion,
      update_url: config.updateUrl || ""
    };
  }

  function clientAllowed(socket, message) {
    if (validVersion(message.client_version) && compareVersions(message.client_version, minPluginVersion) >= 0) {
      return true;
    }
    send(socket, {
      type: "error",
      code: "client_outdated",
      request_id: message.request_id,
      client_version: validVersion(message.client_version) ? message.client_version : null,
      ...versionInfo()
    });
    return false;
  }

  const rooms = new Map();
  const inviteCodes = new Map();
  const clients = new Set();
  const cleanupTimer = setInterval(cleanExpiredRooms, config.cleanupIntervalMs);
  cleanupTimer.unref();

  const httpServer = createServer((request, response) => {
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
        "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
      });
      response.end(landingPage);
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size, ...versionInfo() }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: config.pathname,
    maxPayload: config.maxMessageBytes,
    perMessageDeflate: false
  });

  function send(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  function sendError(socket, code, requestId) {
    send(socket, { type: "error", code, request_id: requestId });
  }

  function broadcast(room, payload, except = null) {
    for (const socket of [room.leaderSocket, room.guestSocket]) {
      if (socket && socket !== except) {
        send(socket, payload);
      }
    }
  }

  function broadcastPresence(room) {
    broadcast(room, {
      type: "peer_presence",
      room_id: room.id,
      leader_connected: Boolean(room.leaderSocket),
      guest_connected: Boolean(room.guestSocket),
      leader_name: room.leaderName,
      guest_name: room.guestName,
      server_time_ms: Date.now()
    });
  }

  function detach(socket) {
    const { roomId, role } = socket.session || {};
    if (!roomId || !role) {
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }
    if (role === "leader" && room.leaderSocket === socket) {
      room.leaderSocket = null;
    }
    if (role === "guest" && room.guestSocket === socket) {
      room.guestSocket = null;
    }
    socket.session = null;
    room.lastActivityAt = Date.now();
    if (!room.leaderSocket && !room.guestSocket) {
      rooms.delete(room.id);
      if (room.inviteCodeHash) {
        inviteCodes.delete(room.inviteCodeHash);
      }
      return;
    }
    broadcastPresence(room);
  }

  function deleteRoom(room, reason) {
    rooms.delete(room.id);
    if (room.inviteCodeHash) {
      inviteCodes.delete(room.inviteCodeHash);
    }
    const payload = { type: "room_ended", room_id: room.id, reason };
    for (const socket of [room.leaderSocket, room.guestSocket]) {
      if (socket) {
        socket.session = null;
        send(socket, payload);
      }
    }
  }

  function cleanExpiredRooms() {
    const now = Date.now();
    for (const room of rooms.values()) {
      const empty = !room.leaderSocket && !room.guestSocket;
      if (
        now - room.createdAt >= config.maxRoomLifetimeMs ||
        now - room.lastActivityAt >= config.inactiveRoomMs ||
        (empty && now - room.lastActivityAt >= config.emptyRoomMs)
      ) {
        deleteRoom(room, "expired");
      }
    }
  }

  function attach(socket, room, role) {
    detach(socket);
    if (role === "leader") {
      if (room.leaderSocket && room.leaderSocket !== socket) {
        room.leaderSocket.close(4002, "leader_replaced");
      }
      room.leaderSocket = socket;
    } else {
      if (room.guestSocket && room.guestSocket !== socket) {
        room.guestSocket.close(4003, "guest_replaced");
      }
      room.guestSocket = socket;
    }
    socket.session = { roomId: room.id, role };
    room.lastActivityAt = Date.now();
    broadcastPresence(room);
  }

  function promoteGuest(room, departingSocket) {
    const promotedSocket = room.guestSocket;
    if (!promotedSocket) {
      return false;
    }
    const promotedToken = opaqueToken();
    room.leaderSocket = promotedSocket;
    room.guestSocket = null;
    room.leaderTokenHash = hashToken(promotedToken);
    room.guestTokenHash = null;
    room.leaderName = room.guestName || "Ведущий";
    room.guestName = null;
    promotedSocket.session = { roomId: room.id, role: "leader" };
    departingSocket.session = null;
    room.lastActivityAt = Date.now();
    send(departingSocket, { type: "room_left", room_id: room.id, reason: "leader_transferred" });
    send(promotedSocket, {
      type: "role_changed",
      room_id: room.id,
      role: "leader",
      leader_token: promotedToken,
      state: room.state,
      control_mode: room.controlMode,
      participants: { leader: room.leaderName, guest: room.guestName }
    });
    broadcastPresence(room);
    return true;
  }

  function rateAllowed(socket) {
    const now = Date.now();
    const window = socket.rateWindow || { startedAt: now, count: 0 };
    if (now - window.startedAt >= 1000) {
      socket.rateWindow = { startedAt: now, count: 1 };
      return true;
    }
    window.count += 1;
    socket.rateWindow = window;
    return window.count <= config.maxEventsPerSecond;
  }

  function roomFromMessage(socket, message, requireLeader = false) {
    const room = rooms.get(message.room_id);
    if (!room) {
      sendError(socket, "room_not_found", message.request_id);
      return null;
    }
    if (requireLeader) {
      if (!sameToken(message.leader_token, room.leaderTokenHash)) {
        sendError(socket, "leader_required", message.request_id);
        return null;
      }
    } else if (socket.session?.roomId !== room.id) {
      sendError(socket, "not_joined", message.request_id);
      return null;
    }
    room.lastActivityAt = Date.now();
    return room;
  }

  function handleMessage(socket, message) {
    if (!isPlainObject(message) || !boundedString(message.type, 64)) {
      sendError(socket, "invalid_message");
      return;
    }
    if (!rateAllowed(socket)) {
      sendError(socket, "rate_limited", message.request_id);
      return;
    }

    if (message.type === "ping") {
      send(socket, { type: "pong", request_id: message.request_id, server_time_ms: Date.now() });
      return;
    }

    if (["create_room", "join_room", "resume_room"].includes(message.type) && !clientAllowed(socket, message)) {
      return;
    }

    if (message.type === "create_room") {
      if (rooms.size >= config.maxRooms) {
        sendError(socket, "server_busy", message.request_id);
        return;
      }
      const leaderToken = opaqueToken();
      // 10 bytes (80 bits) is plenty for a single-use, short-lived invite and
      // keeps the plugin's packed invite code short.
      const inviteCode = randomBytes(10).toString("base64url");
      const now = Date.now();
      const room = {
        id: randomUUID(),
        leaderTokenHash: hashToken(leaderToken),
        inviteCodeHash: hashToken(inviteCode),
        guestTokenHash: null,
        leaderSocket: null,
        guestSocket: null,
        state: null,
        revision: 0,
        pendingTrack: null,
        pendingTrackOwnerRole: null,
        controlMode: message.control_mode === "both" ? "both" : "leader",
        leaderName: boundedString(message.display_name, 64) ? message.display_name : "Ведущий",
        guestName: null,
        createdAt: now,
        lastActivityAt: now
      };
      rooms.set(room.id, room);
      inviteCodes.set(room.inviteCodeHash, room.id);
      attach(socket, room, "leader");
      send(socket, {
        type: "room_created",
        request_id: message.request_id,
        room_id: room.id,
        leader_token: leaderToken,
        invite_code: inviteCode,
        control_mode: room.controlMode,
        participants: { leader: room.leaderName, guest: room.guestName },
        expires_at: now + config.maxRoomLifetimeMs
      });
      return;
    }

    if (message.type === "join_room") {
      if (!boundedString(message.invite_code, 64)) {
        sendError(socket, "invite_invalid", message.request_id);
        return;
      }
      const inviteCodeHash = hashToken(message.invite_code);
      const room = rooms.get(inviteCodes.get(inviteCodeHash));
      if (!room) {
        sendError(socket, "invite_invalid", message.request_id);
        return;
      }
      if (room.guestTokenHash || room.inviteCodeHash !== inviteCodeHash) {
        sendError(socket, "invite_invalid", message.request_id);
        return;
      }
      const guestToken = opaqueToken();
      room.guestTokenHash = hashToken(guestToken);
      room.guestName = boundedString(message.display_name, 64) ? message.display_name : "Участник";
      inviteCodes.delete(room.inviteCodeHash);
      room.inviteCodeHash = null;
      attach(socket, room, "guest");
      send(socket, {
        type: "room_joined",
        request_id: message.request_id,
        room_id: room.id,
        guest_token: guestToken,
        state: room.state,
        control_mode: room.controlMode,
        participants: { leader: room.leaderName, guest: room.guestName },
        expires_at: room.createdAt + config.maxRoomLifetimeMs
      });
      if (room.pendingTrack) {
        send(socket, { type: "track_offer", room_id: room.id, track: room.pendingTrack });
      }
      return;
    }

    if (message.type === "resume_room") {
      const room = rooms.get(message.room_id);
      const role = message.role;
      const validLeader = role === "leader" && sameToken(message.token, room?.leaderTokenHash);
      const validGuest = role === "guest" && sameToken(message.token, room?.guestTokenHash);
      if (!room || (!validLeader && !validGuest)) {
        sendError(socket, "resume_invalid", message.request_id);
        return;
      }
      attach(socket, room, role);
      send(socket, {
        type: "room_resumed",
        request_id: message.request_id,
        room_id: room.id,
        role,
        state: room.state,
        control_mode: room.controlMode
      });
      return;
    }

    if (message.type === "get_state") {
      const room = roomFromMessage(socket, message);
      if (room) {
        send(socket, { ...publicState(room), request_id: message.request_id });
      }
      return;
    }

    if (message.type === "set_state") {
      const room = roomFromMessage(socket, message, false);
      if (!room) {
        return;
      }
      const isLeader = socket.session?.role === "leader" && sameToken(message.leader_token, room.leaderTokenHash);
      if (!isLeader && room.controlMode !== "both") {
        sendError(socket, "leader_required", message.request_id);
        return;
      }
      if (!validState(message.state)) {
        sendError(socket, "invalid_state", message.request_id);
        return;
      }
      // The server owns revision numbers: both participants may control the
      // player, so locally generated revisions can collide or go backwards.
      const incoming = message.state;
      const track = sanitizeTrack(incoming.track);
      let positionMs = incoming.position_ms;
      if (track.duration_ms) {
        positionMs = Math.min(positionMs, track.duration_ms);
      }
      room.revision = Math.max(room.revision + 1, incoming.revision);
      room.state = {
        track,
        playing: incoming.playing,
        position_ms: positionMs,
        start_at_server_ms: incoming.start_at_server_ms,
        revision: room.revision,
        updated_by: socket.session.role
      };
      room.pendingTrack = null;
      room.pendingTrackOwnerRole = null;
      broadcast(room, publicState(room));
      return;
    }

    if (message.type === "set_control_mode") {
      const room = roomFromMessage(socket, message, true);
      if (!room) {
        return;
      }
      if (!["leader", "both"].includes(message.control_mode)) {
        sendError(socket, "invalid_control_mode", message.request_id);
        return;
      }
      room.controlMode = message.control_mode;
      if (room.controlMode === "leader" && room.pendingTrackOwnerRole === "guest") {
        const cancelledId = room.pendingTrack?.id;
        room.pendingTrack = null;
        room.pendingTrackOwnerRole = null;
        broadcast(room, {
          type: "track_cancelled",
          room_id: room.id,
          track_id: cancelledId,
          reason: "control_mode_changed"
        });
      }
      broadcast(room, {
        type: "control_mode",
        room_id: room.id,
        control_mode: room.controlMode,
        server_time_ms: Date.now()
      });
      return;
    }

    if (message.type === "offer_track") {
      const room = roomFromMessage(socket, message, false);
      if (!room) {
        return;
      }
      const isLeader = socket.session?.role === "leader" && sameToken(message.leader_token, room.leaderTokenHash);
      if (!isLeader && room.controlMode !== "both") {
        sendError(socket, "leader_required", message.request_id);
        return;
      }
      if (!validTrack(message.track)) {
        sendError(socket, "invalid_track", message.request_id);
        return;
      }
      room.pendingTrack = sanitizeTrack(message.track);
      room.pendingTrackOwnerRole = socket.session.role;
      const recipient = socket.session.role === "leader" ? room.guestSocket : room.leaderSocket;
      if (recipient) {
        send(recipient, { type: "track_offer", room_id: room.id, track: room.pendingTrack });
      }
      send(socket, { type: "track_offered", request_id: message.request_id, room_id: room.id });
      return;
    }

    if (message.type === "track_status") {
      const room = roomFromMessage(socket, message);
      if (!room || !room.pendingTrackOwnerRole || socket.session?.role === room.pendingTrackOwnerRole) {
        if (room) {
          sendError(socket, "track_status_not_allowed", message.request_id);
        }
        return;
      }
      if (!room.pendingTrack || message.track_id !== room.pendingTrack.id || !["ready", "missing"].includes(message.status)) {
        sendError(socket, "invalid_track_status", message.request_id);
        return;
      }
      const owner = room.pendingTrackOwnerRole === "leader" ? room.leaderSocket : room.guestSocket;
      if (owner) {
        send(owner, {
          type: "track_status",
          room_id: room.id,
          track_id: message.track_id,
          status: message.status
        });
      }
      return;
    }

    if (message.type === "end_room") {
      const room = roomFromMessage(socket, message, true);
      if (room) {
        deleteRoom(room, "ended_by_leader");
      }
      return;
    }

    if (message.type === "leave_room") {
      const room = roomFromMessage(socket, message);
      if (room) {
        if (socket.session?.role === "leader" && room.guestSocket) {
          promoteGuest(room, socket);
          return;
        }
        detach(socket);
        send(socket, { type: "room_left", room_id: room.id });
      }
      return;
    }

    if (message.type === "end_for_all") {
      const room = roomFromMessage(socket, message);
      if (room) {
        deleteRoom(room, "ended_by_participant");
      }
      return;
    }

    sendError(socket, "unknown_type", message.request_id);
  }

  wss.on("connection", (socket) => {
    if (clients.size >= config.maxConnections) {
      socket.close(1013, "server_busy");
      return;
    }
    clients.add(socket);
    socket.session = null;
    socket.rateWindow = null;

    socket.on("message", (raw, isBinary) => {
      if (isBinary || raw.length > config.maxMessageBytes) {
        socket.close(1009, "message_too_large");
        return;
      }
      try {
        handleMessage(socket, JSON.parse(raw.toString("utf8")));
      } catch {
        sendError(socket, "invalid_json");
      }
    });
    socket.on("close", () => {
      detach(socket);
      clients.delete(socket);
    });
    socket.on("error", () => {});
    send(socket, { type: "hello", server_time_ms: Date.now(), max_rooms: config.maxRooms, ...versionInfo() });
  });

  return {
    rooms,
    clients,
    async listen() {
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      return httpServer.address();
    },
    async close() {
      clearInterval(cleanupTimer);
      for (const socket of clients) {
        socket.close(1001, "server_shutdown");
      }
      await new Promise((resolve) => httpServer.close(resolve));
    }
  };
}
