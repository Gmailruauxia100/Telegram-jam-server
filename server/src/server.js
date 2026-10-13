import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";

const landingPage = readFileSync(new URL("../public/index.html", import.meta.url));
const serverVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const PROTOCOL_VERSION = 3;

const TRACK_SOURCES = new Set(["chat", "profile", "external"]);
const CONTROL_MODES = new Set(["leader", "both"]);
const MAX_OPEN_TICKETS = 10;
const MAX_BANS = 50;

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

function opaqueToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("base64url");
}

function sameToken(token, expectedHash) {
  return typeof token === "string" && Boolean(expectedHash) && hashToken(token) === expectedHash;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function displayName(value, fallback) {
  return boundedString(value, 64) ? value : fallback;
}

function validTrack(track) {
  if (!isPlainObject(track)) {
    return false;
  }
  return (
    boundedString(track.id) &&
    (track.title === undefined || typeof track.title === "string") &&
    Number.isSafeInteger(track.dialog_id) && track.dialog_id > 0 &&
    Number.isSafeInteger(track.message_id) && track.message_id !== 0 &&
    (track.document_id === undefined || boundedString(track.document_id, 32)) &&
    (track.duration_ms === undefined || (Number.isInteger(track.duration_ms) && track.duration_ms >= 0)) &&
    (track.source === undefined || TRACK_SOURCES.has(track.source)) &&
    (track.temporary === undefined || typeof track.temporary === "boolean") &&
    (track.performer === undefined || boundedString(track.performer, 128))
  );
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

// Store only known track fields so clients cannot push arbitrary payloads
// through the room. "source" tells profile tracks apart from chat tracks.
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

export function createJamServer(config) {
  const minPluginVersion = config.minPluginVersion || "0.0.0";
  const maxMembers = Math.max(2, config.maxParticipants || 5);
  const ticketTtlMs = config.inviteTtlMs || 300000;
  const memberGraceMs = config.memberGraceMs || 120000;
  const hostHandoffMs = config.hostHandoffMs ?? 15000;

  function versionInfo() {
    return {
      server_version: serverVersion,
      protocol: PROTOCOL_VERSION,
      min_plugin_version: minPluginVersion,
      max_participants: maxMembers,
      update_url: config.updateUrl || ""
    };
  }

  const rooms = new Map();
  const roomCodes = new Map();
  const clients = new Set();
  const cleanupTimer = setInterval(cleanExpired, config.cleanupIntervalMs);
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
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  function sendError(socket, code, requestId, extra = {}) {
    send(socket, { type: "error", code, request_id: requestId, ...extra });
  }

  function broadcast(room, payload, exceptId = null) {
    for (const member of room.members.values()) {
      if (member.id !== exceptId) {
        send(member.socket, payload);
      }
    }
  }

  function snapshot(room) {
    return {
      room_id: room.id,
      creator_id: room.creatorId,
      host_id: room.hostId,
      control_mode: room.controlMode,
      max_participants: maxMembers,
      members: [...room.members.values()].map((member) => ({
        id: member.id,
        name: member.name,
        connected: Boolean(member.socket)
      })),
      banned: [...room.bans.values()].map((ban) => ({ id: ban.id, name: ban.name })),
      state: room.state
    };
  }

  function broadcastUpdate(room, event = null) {
    broadcast(room, { type: "room_update", room: snapshot(room), event, server_time_ms: Date.now() });
  }

  function clientAllowed(socket, message) {
    if (validVersion(message.client_version) && compareVersions(message.client_version, minPluginVersion) >= 0) {
      return true;
    }
    sendError(socket, "client_outdated", message.request_id, {
      client_version: validVersion(message.client_version) ? message.client_version : null,
      ...versionInfo()
    });
    return false;
  }

  function newMember(socket, room, name, memberKey) {
    const token = opaqueToken();
    const member = {
      id: opaqueToken(6),
      name,
      tokenHash: hashToken(token),
      keyHash: memberKey ? hashToken(room.id + ":" + memberKey) : null,
      socket: null
    };
    room.members.set(member.id, member);
    attach(socket, room, member);
    return { member, token };
  }

  function attach(socket, room, member) {
    detach(socket);
    if (member.socket && member.socket !== socket) {
      member.socket.session = null;
      member.socket.close(4002, "replaced");
    }
    member.socket = socket;
    member.disconnectedAt = null;
    if (room.handoffTimer && room.hostId === member.id) {
      clearTimeout(room.handoffTimer);
      room.handoffTimer = null;
    }
    socket.session = { roomId: room.id, memberId: member.id };
    room.lastActivityAt = Date.now();
  }

  // Socket closed or replaced: the member stays in the room (it can resume).
  function detach(socket) {
    const { roomId, memberId } = socket.session || {};
    socket.session = null;
    const room = roomId && rooms.get(roomId);
    const member = room?.members.get(memberId);
    if (!member || member.socket !== socket) {
      return;
    }
    member.socket = null;
    member.disconnectedAt = Date.now();
    room.lastActivityAt = Date.now();
    if (![...room.members.values()].some((item) => item.socket)) {
      return;
    }
    broadcastUpdate(room, { kind: "presence", member_id: member.id, name: member.name });
    if (room.hostId === member.id) {
      scheduleHandoff(room, member);
    }
  }

  // The host lost its connection: if it does not come back soon, someone else
  // who is online takes over so the lobby is never left without control.
  function scheduleHandoff(room, host) {
    if (room.handoffTimer) {
      clearTimeout(room.handoffTimer);
    }
    room.handoffTimer = setTimeout(() => {
      room.handoffTimer = null;
      if (!rooms.has(room.id) || room.hostId !== host.id || host.socket) {
        return;
      }
      passHost(room, host.id, "host_lost");
    }, hostHandoffMs);
    room.handoffTimer.unref?.();
  }

  // Next host: the creator if online, otherwise whoever joined earliest and is online.
  function nextHost(room, excludeId) {
    const candidates = [...room.members.values()].filter((item) => item.id !== excludeId);
    const creator = candidates.find((item) => item.id === room.creatorId && item.socket);
    return creator || candidates.find((item) => item.socket) || candidates[0] || null;
  }

  function passHost(room, excludeId, reason) {
    const next = nextHost(room, excludeId);
    if (!next || next.id === room.hostId) {
      return null;
    }
    room.hostId = next.id;
    broadcastUpdate(room, { kind: "host_changed", member_id: next.id, name: next.name, reason });
    return next;
  }

  function deleteRoom(room, reason) {
    if (room.handoffTimer) {
      clearTimeout(room.handoffTimer);
      room.handoffTimer = null;
    }
    rooms.delete(room.id);
    roomCodes.delete(room.code);
    for (const member of room.members.values()) {
      if (member.socket) {
        send(member.socket, { type: "room_ended", room_id: room.id, reason });
        member.socket.session = null;
      }
    }
  }

  // Removes a member for good. When the creator goes, the lobby carries on
  // and the creator role (inviting, relaying tracks) moves to the next host.
  function removeMember(room, member, reason) {
    const others = [...room.members.values()].filter((item) => item.id !== member.id);
    if (member.id === room.creatorId && !others.some((item) => item.socket)) {
      deleteRoom(room, reason === "kicked" ? "creator_kicked" : "creator_left");
      return;
    }
    room.members.delete(member.id);
    if (member.socket) {
      send(member.socket, { type: "room_left", room_id: room.id, reason });
      member.socket.session = null;
    }
    let creatorChanged = false;
    if (member.id === room.creatorId) {
      const heir = (room.members.get(room.hostId)?.socket && room.members.get(room.hostId)) || nextHost(room, member.id);
      room.creatorId = heir.id;
      creatorChanged = true;
    }
    if (room.hostId === member.id || creatorChanged && !room.members.get(room.hostId)) {
      if (room.handoffTimer) {
        clearTimeout(room.handoffTimer);
        room.handoffTimer = null;
      }
      room.hostId = creatorChanged ? room.creatorId : (nextHost(room, member.id)?.id || room.creatorId);
    }
    if (room.pendingTrack) {
      room.pendingTrack.statuses.delete(member.id);
      if (room.pendingTrack.ownerId === member.id) {
        room.pendingTrack = null;
      } else {
        maybeAllReady(room);
      }
    }
    broadcastUpdate(room, {
      kind: reason === "kicked" ? "kicked" : "left",
      member_id: member.id,
      name: member.name,
      host_id: room.hostId,
      host_name: room.members.get(room.hostId)?.name || null,
      creator_changed: creatorChanged
    });
  }

  function cleanExpired() {
    const now = Date.now();
    for (const room of rooms.values()) {
      for (const [hash, ticket] of room.tickets) {
        if (ticket.expiresAt <= now) {
          room.tickets.delete(hash);
        }
      }
      // Members that did not come back in time leave; a lost creator ends the lobby.
      for (const member of [...room.members.values()]) {
        if (!member.socket && member.disconnectedAt && now - member.disconnectedAt >= memberGraceMs && rooms.has(room.id)) {
          removeMember(room, member, "left");
        }
      }
      if (!rooms.has(room.id)) {
        continue;
      }
      const empty = ![...room.members.values()].some((member) => member.socket);
      if (
        now - room.createdAt >= config.maxRoomLifetimeMs ||
        now - room.lastActivityAt >= config.inactiveRoomMs ||
        (empty && now - room.lastActivityAt >= config.emptyRoomMs)
      ) {
        deleteRoom(room, "expired");
      }
    }
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

  function context(socket, message) {
    const room = rooms.get(message.room_id);
    const member = room?.members.get(socket.session?.memberId);
    if (!room || !member || socket.session?.roomId !== room.id) {
      sendError(socket, room ? "not_joined" : "room_not_found", message.request_id);
      return null;
    }
    room.lastActivityAt = Date.now();
    return { room, member };
  }

  function isHost(room, member) {
    return room.hostId === member.id;
  }

  function canControl(room, member) {
    return isHost(room, member) || room.controlMode === "both";
  }

  function issueTicket(room) {
    if (room.tickets.size >= MAX_OPEN_TICKETS) {
      const oldest = [...room.tickets.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      room.tickets.delete(oldest[0]);
    }
    const ticket = opaqueToken(6);
    const ticketId = opaqueToken(4);
    const expiresAt = Date.now() + ticketTtlMs;
    room.tickets.set(hashToken(ticket), { id: ticketId, expiresAt });
    return { ticket, ticketId, expiresAt };
  }

  function maybeAllReady(room) {
    const pending = room.pendingTrack;
    if (!pending) {
      return;
    }
    const waiting = [...room.members.keys()].filter((id) => id !== pending.ownerId && pending.statuses.get(id) !== "ready");
    if (waiting.length === 0) {
      const owner = room.members.get(pending.ownerId);
      send(owner?.socket, { type: "track_ready_all", room_id: room.id, track_id: pending.track.id });
    }
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
      const now = Date.now();
      let code = opaqueToken(6);
      while (roomCodes.has(code)) {
        code = opaqueToken(6);
      }
      const room = {
        id: randomUUID(),
        code,
        creatorId: null,
        hostId: null,
        members: new Map(),
        tickets: new Map(),
        bans: new Map(),
        controlMode: message.control_mode === "both" ? "both" : "leader",
        state: null,
        revision: 0,
        pendingTrack: null,
        createdAt: now,
        lastActivityAt: now
      };
      rooms.set(room.id, room);
      roomCodes.set(code, room.id);
      const { member, token } = newMember(socket, room, displayName(message.display_name, "Хост"), message.member_key);
      room.creatorId = member.id;
      room.hostId = member.id;
      const ticket = issueTicket(room);
      send(socket, {
        type: "room_created",
        request_id: message.request_id,
        room_id: room.id,
        room_code: room.code,
        member_id: member.id,
        token,
        ticket: ticket.ticket,
        ticket_id: ticket.ticketId,
        ticket_expires_at: ticket.expiresAt,
        room: snapshot(room),
        expires_at: now + config.maxRoomLifetimeMs
      });
      return;
    }

    if (message.type === "join_room") {
      if (!boundedString(message.room_code, 32) || !boundedString(message.ticket, 64)) {
        sendError(socket, "invite_invalid", message.request_id);
        return;
      }
      const room = rooms.get(roomCodes.get(message.room_code));
      const ticketHash = hashToken(message.ticket);
      const ticket = room?.tickets.get(ticketHash);
      if (!room || !ticket || ticket.expiresAt <= Date.now()) {
        sendError(socket, "invite_invalid", message.request_id);
        return;
      }
      const memberKey = boundedString(message.member_key, 128) ? message.member_key : null;
      const keyHash = memberKey ? hashToken(room.id + ":" + memberKey) : null;
      if (keyHash && [...room.bans.values()].some((ban) => ban.keyHash === keyHash)) {
        sendError(socket, "banned", message.request_id);
        return;
      }
      if (keyHash && [...room.members.values()].some((member) => member.keyHash === keyHash)) {
        sendError(socket, "already_joined", message.request_id);
        return;
      }
      if (room.members.size >= maxMembers) {
        sendError(socket, "room_full", message.request_id, { max_participants: maxMembers });
        return;
      }
      room.tickets.delete(ticketHash);
      const { member, token } = newMember(socket, room, displayName(message.display_name, "Гость"), memberKey);
      send(socket, {
        type: "room_joined",
        request_id: message.request_id,
        room_id: room.id,
        member_id: member.id,
        token,
        room: snapshot(room),
        expires_at: room.createdAt + config.maxRoomLifetimeMs
      });
      broadcastUpdate(room, { kind: "joined", member_id: member.id, name: member.name, ticket_id: ticket.id });
      if (room.pendingTrack) {
        send(socket, { type: "track_offer", room_id: room.id, track: room.pendingTrack.track, owner_id: room.pendingTrack.ownerId });
      }
      return;
    }

    if (message.type === "resume_room") {
      const room = rooms.get(message.room_id);
      const member = room?.members.get(message.member_id);
      if (!member || !sameToken(message.token, member.tokenHash)) {
        sendError(socket, "resume_invalid", message.request_id);
        return;
      }
      attach(socket, room, member);
      send(socket, { type: "room_resumed", request_id: message.request_id, room: snapshot(room) });
      broadcastUpdate(room, { kind: "presence", member_id: member.id, name: member.name });
      return;
    }

    const ctx = context(socket, message);
    if (!ctx) {
      return;
    }
    const { room, member } = ctx;

    if (message.type === "get_state") {
      send(socket, { type: "room_update", request_id: message.request_id, room: snapshot(room), event: null, server_time_ms: Date.now() });
      return;
    }

    if (message.type === "create_invite") {
      // Tickets travel through the creator's private chats, so only it can invite.
      if (member.id !== room.creatorId) {
        sendError(socket, "creator_required", message.request_id);
        return;
      }
      if (room.members.size >= maxMembers) {
        sendError(socket, "room_full", message.request_id, { max_participants: maxMembers });
        return;
      }
      const ticket = issueTicket(room);
      send(socket, {
        type: "invite_created",
        request_id: message.request_id,
        room_id: room.id,
        room_code: room.code,
        ticket: ticket.ticket,
        ticket_id: ticket.ticketId,
        ticket_expires_at: ticket.expiresAt
      });
      return;
    }

    if (message.type === "set_state") {
      if (!canControl(room, member)) {
        sendError(socket, "host_required", message.request_id);
        return;
      }
      if (!validState(message.state)) {
        sendError(socket, "invalid_state", message.request_id);
        return;
      }
      const incoming = message.state;
      const track = sanitizeTrack(incoming.track);
      room.revision = Math.max(room.revision + 1, incoming.revision);
      room.state = {
        track,
        playing: incoming.playing,
        position_ms: track.duration_ms ? Math.min(incoming.position_ms, track.duration_ms) : incoming.position_ms,
        start_at_server_ms: incoming.start_at_server_ms,
        revision: room.revision,
        updated_by: member.id
      };
      room.pendingTrack = null;
      broadcast(room, { type: "room_state", room_id: room.id, state: room.state, server_time_ms: Date.now() });
      return;
    }

    if (message.type === "offer_track") {
      if (!canControl(room, member)) {
        sendError(socket, "host_required", message.request_id);
        return;
      }
      if (!validTrack(message.track)) {
        sendError(socket, "invalid_track", message.request_id);
        return;
      }
      const track = sanitizeTrack(message.track);
      room.pendingTrack = { track, ownerId: member.id, statuses: new Map() };
      broadcast(room, { type: "track_offer", room_id: room.id, track, owner_id: member.id }, member.id);
      send(socket, { type: "track_offered", request_id: message.request_id, room_id: room.id });
      maybeAllReady(room);
      return;
    }

    if (message.type === "track_status") {
      const pending = room.pendingTrack;
      if (!pending || message.track_id !== pending.track.id || !["ready", "missing"].includes(message.status)) {
        sendError(socket, "invalid_track_status", message.request_id);
        return;
      }
      if (member.id === pending.ownerId) {
        sendError(socket, "track_status_not_allowed", message.request_id);
        return;
      }
      pending.statuses.set(member.id, message.status);
      const payload = { type: "track_status", room_id: room.id, track_id: pending.track.id, member_id: member.id, status: message.status };
      // The owner waits for readiness; the creator relays copies to members who miss the track.
      send(room.members.get(pending.ownerId)?.socket, payload);
      if (room.creatorId !== pending.ownerId) {
        send(room.members.get(room.creatorId)?.socket, payload);
      }
      maybeAllReady(room);
      return;
    }

    if (message.type === "set_control_mode") {
      if (!isHost(room, member)) {
        sendError(socket, "host_required", message.request_id);
        return;
      }
      if (!CONTROL_MODES.has(message.control_mode)) {
        sendError(socket, "invalid_control_mode", message.request_id);
        return;
      }
      room.controlMode = message.control_mode;
      if (room.controlMode === "leader" && room.pendingTrack && room.pendingTrack.ownerId !== room.hostId) {
        const trackId = room.pendingTrack.track.id;
        room.pendingTrack = null;
        broadcast(room, { type: "track_cancelled", room_id: room.id, track_id: trackId, reason: "control_mode_changed" });
      }
      broadcastUpdate(room, { kind: "control_mode", control_mode: room.controlMode });
      return;
    }

    if (message.type === "transfer_host") {
      const target = room.members.get(message.member_id);
      if (!isHost(room, member)) {
        sendError(socket, "host_required", message.request_id);
        return;
      }
      if (!target) {
        sendError(socket, "member_not_found", message.request_id);
        return;
      }
      room.hostId = target.id;
      broadcastUpdate(room, { kind: "host_changed", member_id: target.id, name: target.name });
      return;
    }

    if (message.type === "kick_member") {
      const target = room.members.get(message.member_id);
      if (!isHost(room, member)) {
        sendError(socket, "host_required", message.request_id);
        return;
      }
      if (!target || target.id === member.id || target.id === room.creatorId) {
        sendError(socket, "kick_not_allowed", message.request_id);
        return;
      }
      if (target.keyHash) {
        if (room.bans.size >= MAX_BANS) {
          room.bans.delete(room.bans.keys().next().value);
        }
        const banId = opaqueToken(4);
        room.bans.set(banId, { id: banId, name: target.name, keyHash: target.keyHash });
      }
      removeMember(room, target, "kicked");
      return;
    }

    if (message.type === "unban_member") {
      if (!isHost(room, member)) {
        sendError(socket, "host_required", message.request_id);
        return;
      }
      const ban = room.bans.get(message.ban_id);
      if (!ban) {
        sendError(socket, "ban_not_found", message.request_id);
        return;
      }
      room.bans.delete(ban.id);
      broadcastUpdate(room, { kind: "unbanned", name: ban.name });
      return;
    }

    if (message.type === "leave_room") {
      removeMember(room, member, "left");
      return;
    }

    if (message.type === "end_room") {
      if (!isHost(room, member) && member.id !== room.creatorId) {
        sendError(socket, "host_required", message.request_id);
        return;
      }
      deleteRoom(room, "ended_by_host");
      return;
    }

    if (message.type === "end_for_all") {
      deleteRoom(room, "ended_by_participant");
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
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        sendError(socket, "invalid_json");
        return;
      }
      try {
        handleMessage(socket, message);
      } catch (error) {
        console.error("Telegram Jam: message handling failed", error);
        sendError(socket, "server_error", message?.request_id);
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
