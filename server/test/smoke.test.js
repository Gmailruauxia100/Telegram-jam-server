import assert from "node:assert/strict";
import test from "node:test";
import { get } from "node:http";
import WebSocket from "ws";
import { createJamServer, compareVersions } from "../src/server.js";

const CLIENT = "0.10.0";
const config = {
  host: "127.0.0.1",
  port: 0,
  pathname: "/jam",
  maxRooms: 5,
  maxConnections: 20,
  maxMessageBytes: 4096,
  maxEventsPerSecond: 50,
  emptyRoomMs: 1000,
  inactiveRoomMs: 10000,
  maxRoomLifetimeMs: 20000,
  cleanupIntervalMs: 1000,
  maxParticipants: 3,
  inviteTtlMs: 300000,
  minPluginVersion: "0.10.0",
  updateUrl: "https://t.me/shit_plugins"
};

const track = {
  id: "t1",
  dialog_id: 777,
  message_id: 15,
  document_id: "5341356010890105742",
  title: "Song",
  duration_ms: 60000,
  source: "profile",
  temporary: true,
  injected: "x"
};

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.inbox = [];
    socket.waiters = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const index = socket.waiters.findIndex((waiter) => waiter.type === message.type);
      if (index >= 0) {
        const [waiter] = socket.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        socket.inbox.push(message);
      }
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function next(socket, type, timeout = 2000) {
  const index = socket.inbox.findIndex((message) => message.type === type);
  if (index >= 0) {
    return Promise.resolve(socket.inbox.splice(index, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const waiter = { type, resolve };
    waiter.timer = setTimeout(() => {
      socket.waiters.splice(socket.waiters.indexOf(waiter), 1);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeout);
    socket.waiters.push(waiter);
  });
}

function sendJson(socket, payload) {
  socket.send(JSON.stringify(payload));
}

function request(url) {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
    }).on("error", reject);
  });
}

async function startServer(overrides = {}) {
  const server = createJamServer({ ...config, ...overrides });
  const address = await server.listen();
  return {
    server,
    url: `ws://${address.address}:${address.port}/jam`,
    http: `http://${address.address}:${address.port}`
  };
}

async function createLobby(url, name = "Host") {
  const socket = await open(url);
  sendJson(socket, { type: "create_room", client_version: CLIENT, display_name: name, member_key: "key-" + name });
  const created = await next(socket, "room_created");
  return { socket, created };
}

async function joinLobby(url, roomCode, ticket, name) {
  const socket = await open(url);
  sendJson(socket, { type: "join_room", client_version: CLIENT, room_code: roomCode, ticket, display_name: name, member_key: "key-" + name });
  return { socket, joined: await next(socket, "room_joined") };
}

async function invite(host, created) {
  sendJson(host, { type: "create_invite", room_id: created.room_id });
  return next(host, "invite_created");
}

test("compareVersions orders dotted versions numerically", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.9", "0.9.0"), 0);
  assert.equal(compareVersions("0.8.1", "0.9.0"), -1);
});

test("landing page and health expose versions and limits", async () => {
  const { server, http } = await startServer();
  const landing = await request(`${http}/`);
  assert.equal(landing.statusCode, 200);
  assert.match(landing.body, /Telegram Jam/);
  const health = JSON.parse((await request(`${http}/health`)).body);
  assert.equal(health.ok, true);
  assert.equal(health.protocol, 3);
  assert.equal(health.min_plugin_version, "0.10.0");
  assert.equal(health.max_participants, 3);
  assert.equal(health.update_url, "https://t.me/shit_plugins");
  await server.close();
});

test("outdated or unversioned plugins are refused", async () => {
  const { server, url } = await startServer();
  const socket = await open(url);
  sendJson(socket, { type: "create_room" });
  let error = await next(socket, "error");
  assert.equal(error.code, "client_outdated");
  assert.equal(error.client_version, null);
  sendJson(socket, { type: "join_room", client_version: "0.9.0", room_code: "x", ticket: "y" });
  error = await next(socket, "error");
  assert.equal(error.code, "client_outdated");
  assert.equal(error.min_plugin_version, "0.10.0");
  assert.equal(server.rooms.size, 0);
  socket.close();
  await server.close();
});

test("lobby: tickets are one-time, everyone sees joins, size is limited", async () => {
  const { server, url } = await startServer();
  const { socket: host, created } = await createLobby(url);
  assert.equal(created.room.creator_id, created.member_id);
  assert.equal(created.room.host_id, created.member_id);

  const a = await joinLobby(url, created.room_code, created.ticket, "Anya");
  const hostUpdate = await next(host, "room_update");
  assert.equal(hostUpdate.event.kind, "joined");
  assert.equal(hostUpdate.event.name, "Anya");
  assert.equal(hostUpdate.event.ticket_id, created.ticket_id);

  const reuse = await open(url);
  sendJson(reuse, { type: "join_room", client_version: CLIENT, room_code: created.room_code, ticket: created.ticket, member_key: "key-Other" });
  assert.equal((await next(reuse, "error")).code, "invite_invalid");

  const second = await invite(host, created);
  const b = await joinLobby(url, second.room_code, second.ticket, "Boris");
  let seen = await next(a.socket, "room_update");
  while (seen.event?.name !== "Boris") seen = await next(a.socket, "room_update");
  assert.equal(seen.room.members.length, 3);

  // Limit is 3: the creator cannot even issue a ticket now.
  sendJson(host, { type: "create_invite", room_id: created.room_id });
  assert.equal((await next(host, "error")).code, "room_full");

  // Only the creator issues tickets.
  sendJson(a.socket, { type: "create_invite", room_id: created.room_id });
  assert.equal((await next(a.socket, "error")).code, "creator_required");

  for (const socket of [host, a.socket, b.socket, reuse]) socket.close();
  await server.close();
});

test("expired tickets are refused", async () => {
  const { server, url } = await startServer({ inviteTtlMs: 1 });
  const { socket: host, created } = await createLobby(url);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const guest = await open(url);
  sendJson(guest, { type: "join_room", client_version: CLIENT, room_code: created.room_code, ticket: created.ticket });
  assert.equal((await next(guest, "error")).code, "invite_invalid");
  host.close();
  guest.close();
  await server.close();
});

test("track readiness is collected from every member and relayed to the creator", async () => {
  const { server, url } = await startServer();
  const { socket: host, created } = await createLobby(url);
  const a = await joinLobby(url, created.room_code, created.ticket, "Anya");
  const second = await invite(host, created);
  const b = await joinLobby(url, second.room_code, second.ticket, "Boris");

  sendJson(host, { type: "offer_track", room_id: created.room_id, track });
  const offerA = await next(a.socket, "track_offer");
  await next(b.socket, "track_offer");
  assert.equal(offerA.track.injected, undefined);
  assert.equal(offerA.owner_id, created.member_id);

  sendJson(a.socket, { type: "track_status", room_id: created.room_id, track_id: "t1", status: "ready" });
  const statusA = await next(host, "track_status");
  assert.equal(statusA.member_id, a.joined.member_id);
  sendJson(b.socket, { type: "track_status", room_id: created.room_id, track_id: "t1", status: "missing" });
  assert.equal((await next(host, "track_status")).status, "missing");
  sendJson(b.socket, { type: "track_status", room_id: created.room_id, track_id: "t1", status: "ready" });
  await next(host, "track_status");
  assert.equal((await next(host, "track_ready_all")).track_id, "t1");

  const state = { track, playing: true, position_ms: 999999, start_at_server_ms: Date.now(), revision: 5 };
  sendJson(host, { type: "set_state", room_id: created.room_id, state });
  const roomState = await next(b.socket, "room_state");
  assert.equal(roomState.state.position_ms, 60000);
  assert.equal(roomState.state.revision, 5);
  assert.equal(roomState.state.updated_by, created.member_id);

  // Guests cannot control in leader mode.
  sendJson(a.socket, { type: "set_state", room_id: created.room_id, state });
  assert.equal((await next(a.socket, "error")).code, "host_required");

  for (const socket of [host, a.socket, b.socket]) socket.close();
  await server.close();
});

test("guest-offered tracks: statuses reach both the owner and the creator", async () => {
  const { server, url } = await startServer();
  const { socket: host, created } = await createLobby(url);
  const a = await joinLobby(url, created.room_code, created.ticket, "Anya");
  const second = await invite(host, created);
  const b = await joinLobby(url, second.room_code, second.ticket, "Boris");

  sendJson(host, { type: "set_control_mode", room_id: created.room_id, control_mode: "both" });
  await next(a.socket, "room_update");
  sendJson(a.socket, { type: "offer_track", room_id: created.room_id, track });
  await next(host, "track_offer");
  sendJson(b.socket, { type: "track_status", room_id: created.room_id, track_id: "t1", status: "missing" });
  assert.equal((await next(a.socket, "track_status")).member_id, b.joined.member_id);
  assert.equal((await next(host, "track_status")).status, "missing");

  // Switching back to host-only cancels the guest's pending track.
  sendJson(host, { type: "set_control_mode", room_id: created.room_id, control_mode: "leader" });
  assert.equal((await next(b.socket, "track_cancelled")).track_id, "t1");

  for (const socket of [host, a.socket, b.socket]) socket.close();
  await server.close();
});

test("host transfer, kick with ban, unban and re-invite", async () => {
  const { server, url } = await startServer();
  const { socket: host, created } = await createLobby(url);
  const a = await joinLobby(url, created.room_code, created.ticket, "Anya");
  const second = await invite(host, created);
  const b = await joinLobby(url, second.room_code, second.ticket, "Boris");
  const roomId = created.room_id;

  sendJson(host, { type: "transfer_host", room_id: roomId, member_id: a.joined.member_id });
  let update = await next(b.socket, "room_update");
  while (update.event?.kind !== "host_changed") update = await next(b.socket, "room_update");
  assert.equal(update.room.host_id, a.joined.member_id);

  // The new host cannot kick the creator.
  sendJson(a.socket, { type: "kick_member", room_id: roomId, member_id: created.member_id });
  assert.equal((await next(a.socket, "error")).code, "kick_not_allowed");

  sendJson(a.socket, { type: "kick_member", room_id: roomId, member_id: b.joined.member_id });
  assert.equal((await next(b.socket, "room_left")).reason, "kicked");
  update = await next(host, "room_update");
  while (update.event?.kind !== "kicked") update = await next(host, "room_update");
  assert.equal(update.room.members.length, 2);
  assert.equal(update.room.banned[0].name, "Boris");
  const banId = update.room.banned[0].id;

  // A fresh ticket does not help a banned member.
  const third = await invite(host, created);
  const retry = await open(url);
  sendJson(retry, { type: "join_room", client_version: CLIENT, room_code: third.room_code, ticket: third.ticket, display_name: "Boris", member_key: "key-Boris" });
  assert.equal((await next(retry, "error")).code, "banned");

  sendJson(a.socket, { type: "unban_member", room_id: roomId, ban_id: banId });
  update = await next(host, "room_update");
  while (update.event?.kind !== "unbanned") update = await next(host, "room_update");
  assert.equal(update.room.banned.length, 0);
  sendJson(retry, { type: "join_room", client_version: CLIENT, room_code: third.room_code, ticket: third.ticket, display_name: "Boris", member_key: "key-Boris" });
  assert.equal((await next(retry, "room_joined")).room.members.length, 3);

  for (const socket of [host, a.socket, b.socket, retry]) socket.close();
  await server.close();
});

test("leaving: the host role passes on, a leaving creator hands the lobby over", async () => {
  const { server, url } = await startServer();
  const { socket: host, created } = await createLobby(url);
  const a = await joinLobby(url, created.room_code, created.ticket, "Anya");
  const second = await invite(host, created);
  const b = await joinLobby(url, second.room_code, second.ticket, "Boris");
  const roomId = created.room_id;

  sendJson(host, { type: "transfer_host", room_id: roomId, member_id: a.joined.member_id });
  sendJson(a.socket, { type: "leave_room", room_id: roomId });
  assert.equal((await next(a.socket, "room_left")).reason, "left");
  let update = await next(b.socket, "room_update");
  while (update.event?.kind !== "left") update = await next(b.socket, "room_update");
  assert.equal(update.event.name, "Anya");
  assert.equal(update.room.host_id, created.member_id);

  // The creator (and host) leaves while Boris is online: the lobby goes on with Boris in charge.
  sendJson(host, { type: "leave_room", room_id: roomId });
  update = await next(b.socket, "room_update");
  while (update.event?.kind !== "left") update = await next(b.socket, "room_update");
  assert.equal(update.room.host_id, b.joined.member_id);
  assert.equal(update.room.creator_id, b.joined.member_id);
  assert.equal(update.event.creator_changed, true);
  assert.equal(server.rooms.size, 1);

  // Boris is the new creator, so he can invite.
  sendJson(b.socket, { type: "create_invite", room_id: roomId, request_id: "i" });
  assert.ok((await next(b.socket, "invite_created")).ticket);

  // The last member leaving closes the lobby.
  sendJson(b.socket, { type: "leave_room", room_id: roomId });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.rooms.size, 0);

  for (const socket of [host, a.socket, b.socket]) socket.close();
  await server.close();
});

test("protocol guards: bad json, unknown type, outsiders, oversize, rate limit", async () => {
  const { server, url } = await startServer({ maxEventsPerSecond: 5 });
  const { socket: host, created } = await createLobby(url);
  const outsider = await open(url);
  sendJson(outsider, { type: "set_state", room_id: created.room_id, state: {} });
  assert.equal((await next(outsider, "error")).code, "not_joined");
  outsider.send("{oops");
  assert.equal((await next(outsider, "error")).code, "invalid_json");
  sendJson(outsider, { type: "nope", room_id: created.room_id });
  assert.equal((await next(outsider, "error")).code, "not_joined");
  for (let i = 0; i < 10; i += 1) sendJson(outsider, { type: "ping" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(outsider.inbox.some((message) => message.code === "rate_limited"));

  const big = await open(url);
  const closed = new Promise((resolve) => big.once("close", (code) => resolve(code)));
  big.send("x".repeat(6000));
  assert.equal(await closed, 1009);

  host.close();
  outsider.close();
  await server.close();
});

test("resume keeps the member and its role", async () => {
  const { server, url } = await startServer();
  const { socket: host, created } = await createLobby(url);
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const again = await open(url);
  sendJson(again, { type: "resume_room", client_version: CLIENT, room_id: created.room_id, member_id: created.member_id, token: created.token });
  const resumed = await next(again, "room_resumed");
  assert.equal(resumed.room.host_id, created.member_id);
  again.close();
  await server.close();
});

test("a host that drops hands over the role; members who do not come back are dropped", async () => {
  const { server, url } = await startServer({ memberGraceMs: 300, cleanupIntervalMs: 30, hostHandoffMs: 50 });
  const { socket: host, created } = await createLobby(url);
  const a = await joinLobby(url, created.room_code, created.ticket, "Anya");
  const second = await invite(host, created);
  const b = await joinLobby(url, second.room_code, second.ticket, "Boris");

  b.socket.close();
  let update = await next(host, "room_update", 3000);
  while (update.event?.kind !== "left") update = await next(host, "room_update", 3000);
  assert.equal(update.event.name, "Boris");

  // The host's connection drops: Anya takes over the host role quickly...
  host.close();
  update = await next(a.socket, "room_update", 3000);
  while (update.event?.kind !== "host_changed") update = await next(a.socket, "room_update", 3000);
  assert.equal(update.event.member_id, a.joined.member_id);
  assert.equal(update.event.reason, "host_lost");
  // ...and when the creator never returns, the creator role moves to her too.
  while (update.event?.kind !== "left") update = await next(a.socket, "room_update", 3000);
  assert.equal(update.room.creator_id, a.joined.member_id);
  a.socket.close();
  await server.close();
});

test("a host that reconnects in time keeps the role", async () => {
  const { server, url } = await startServer({ hostHandoffMs: 300 });
  const { socket: host, created } = await createLobby(url);
  const a = await joinLobby(url, created.room_code, created.ticket, "Anya");
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const again = await open(url);
  sendJson(again, { type: "resume_room", client_version: CLIENT, room_id: created.room_id, member_id: created.member_id, token: created.token });
  assert.equal((await next(again, "room_resumed")).room.host_id, created.member_id);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(!a.socket.inbox.some((message) => message.event?.kind === "host_changed"));
  again.close();
  a.socket.close();
  await server.close();
});
