import assert from "node:assert/strict";
import test from "node:test";
import { get } from "node:http";
import WebSocket from "ws";
import { createJamServer, compareVersions } from "../src/server.js";

const CLIENT = "0.9.0";

const config = {
  host: "127.0.0.1",
  port: 0,
  pathname: "/jam",
  maxRooms: 2,
  maxConnections: 4,
  maxMessageBytes: 4096,
  maxEventsPerSecond: 20,
  emptyRoomMs: 1000,
  inactiveRoomMs: 10000,
  maxRoomLifetimeMs: 20000,
  cleanupIntervalMs: 1000,
  minPluginVersion: "0.9.0",
  latestPluginVersion: "0.9.3",
  updateUrl: "https://t.me/shit_plugins"
};

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function next(socket, expectedType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}`)), 2000);
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === expectedType) {
        clearTimeout(timeout);
        socket.off("message", listener);
        resolve(message);
      }
    };
    socket.on("message", listener);
  });
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

test("landing page and health endpoint are available", async () => {
  const server = createJamServer(config);
  const address = await server.listen();
  const baseUrl = `http://${address.address}:${address.port}`;

  const landing = await request(`${baseUrl}/`);
  const health = await request(`${baseUrl}/health`);

  assert.equal(landing.statusCode, 200);
  assert.match(landing.body, /Telegram Jam/);
  assert.equal(health.statusCode, 200);
  assert.equal(JSON.parse(health.body).ok, true);

  await server.close();
});

test("leader can create a room, guest joins, and playback state broadcasts", async () => {
  const server = createJamServer(config);
  const address = await server.listen();
  const url = `ws://${address.address}:${address.port}/jam`;
  const leader = await open(url);
  const guest = await open(url);

  const created = next(leader, "room_created");
  leader.send(JSON.stringify({ type: "create_room", client_version: CLIENT, request_id: "create-1" }));
  const room = await created;

  const joined = next(guest, "room_joined");
  guest.send(JSON.stringify({ type: "join_room", client_version: CLIENT, invite_code: room.invite_code, display_name: "Guest" }));
  const joinedRoom = await joined;
  assert.equal(joinedRoom.participants.guest, "Guest");

  const modeChanged = next(guest, "control_mode");
  leader.send(JSON.stringify({
    type: "set_control_mode",
    room_id: room.room_id,
    leader_token: room.leader_token,
    control_mode: "both"
  }));
  assert.equal((await modeChanged).control_mode, "both");

  const track = {
    id: "message:-222679",
    dialog_id: 123456,
    message_id: -222679,
    document_id: "5341356010890105742",
    title: "Test",
    duration_ms: 100000
  };
  const offered = next(guest, "track_offer");
  leader.send(JSON.stringify({
    type: "offer_track",
    room_id: room.room_id,
    leader_token: room.leader_token,
    track
  }));
  assert.equal((await offered).track.id, "message:-222679");

  const ready = next(leader, "track_status");
  guest.send(JSON.stringify({
    type: "track_status",
    room_id: room.room_id,
    track_id: "message:-222679",
    status: "ready"
  }));
  assert.equal((await ready).status, "ready");

  const state = next(guest, "room_state");
  leader.send(JSON.stringify({
    type: "set_state",
    room_id: room.room_id,
    leader_token: room.leader_token,
    state: {
      track,
      playing: true,
      position_ms: 0,
      start_at_server_ms: Date.now() + 1000,
      revision: 1
    }
  }));
  const received = await state;
  assert.equal(received.state.track.id, "message:-222679");
  assert.equal(received.state.track.document_id, "5341356010890105742");
  assert.equal(received.state.playing, true);

  const guestState = next(leader, "room_state");
  guest.send(JSON.stringify({
    type: "set_state",
    room_id: room.room_id,
    state: {
      track,
      playing: false,
      position_ms: 500,
      start_at_server_ms: Date.now(),
      revision: 2
    }
  }));
  assert.equal((await guestState).state.playing, false);

  const guestTrack = {
    id: "guest-message:-88",
    dialog_id: 654321,
    message_id: -88,
    document_id: "9012345678901234567",
    title: "Guest track",
    duration_ms: 90000
  };
  const guestOffer = next(leader, "track_offer");
  guest.send(JSON.stringify({
    type: "offer_track",
    room_id: room.room_id,
    track: guestTrack
  }));
  assert.equal((await guestOffer).track.document_id, guestTrack.document_id);

  const guestReady = next(guest, "track_status");
  leader.send(JSON.stringify({
    type: "track_status",
    room_id: room.room_id,
    track_id: guestTrack.id,
    status: "ready"
  }));
  assert.equal((await guestReady).status, "ready");

  const guestTrackState = next(leader, "room_state");
  guest.send(JSON.stringify({
    type: "set_state",
    room_id: room.room_id,
    state: {
      track: guestTrack,
      playing: true,
      position_ms: 0,
      start_at_server_ms: Date.now() + 1000,
      revision: 3
    }
  }));
  assert.equal((await guestTrackState).state.track.id, guestTrack.id);

  leader.close();
  guest.close();
  await server.close();
});

test("leader leaving promotes guest and transfers room control", async () => {
  const server = createJamServer(config);
  const address = await server.listen();
  const url = `ws://${address.address}:${address.port}/jam`;
  const leader = await open(url);
  const guest = await open(url);

  const createdPromise = next(leader, "room_created");
  leader.send(JSON.stringify({ type: "create_room", client_version: CLIENT }));
  const created = await createdPromise;
  const joinedPromise = next(guest, "room_joined");
  guest.send(JSON.stringify({ type: "join_room", client_version: CLIENT, invite_code: created.invite_code }));
  await joinedPromise;

  const leaderLeftPromise = next(leader, "room_left");
  const promotedPromise = next(guest, "role_changed");
  leader.send(JSON.stringify({ type: "leave_room", room_id: created.room_id }));
  assert.equal((await leaderLeftPromise).reason, "leader_transferred");
  const promoted = await promotedPromise;
  assert.equal(promoted.role, "leader");
  assert.ok(promoted.leader_token);
  assert.equal(server.rooms.size, 1);

  const endedPromise = next(guest, "room_ended");
  guest.send(JSON.stringify({
    type: "end_room",
    room_id: created.room_id,
    leader_token: promoted.leader_token
  }));
  await endedPromise;
  assert.equal(server.rooms.size, 0);

  leader.close();
  guest.close();
  await server.close();
});

test("empty room is removed immediately after the last participant leaves", async () => {
  const server = createJamServer(config);
  const address = await server.listen();
  const url = `ws://${address.address}:${address.port}/jam`;
  const leader = await open(url);

  const created = next(leader, "room_created");
  leader.send(JSON.stringify({ type: "create_room", client_version: CLIENT, request_id: "create-empty" }));
  const room = await created;
  assert.equal(server.rooms.size, 1);

  const left = next(leader, "room_left");
  leader.send(JSON.stringify({ type: "leave_room", room_id: room.room_id }));
  await left;
  assert.equal(server.rooms.size, 0);

  leader.close();
  await server.close();
});

async function setupRoom(url) {
  const leader = await open(url);
  const guest = await open(url);
  const createdPromise = next(leader, "room_created");
  leader.send(JSON.stringify({ type: "create_room", client_version: CLIENT }));
  const room = await createdPromise;
  const joinedPromise = next(guest, "room_joined");
  guest.send(JSON.stringify({ type: "join_room", client_version: CLIENT, invite_code: room.invite_code }));
  await joinedPromise;
  return { leader, guest, room };
}

const profileTrack = {
  id: "777:15",
  dialog_id: 777,
  message_id: 15,
  document_id: "5341356010890105742",
  title: "Profile song",
  duration_ms: 60000,
  source: "profile",
  temporary: true,
  injected: "x".repeat(200)
};

test("profile track is offered with source and sanitized fields", async () => {
  const server = createJamServer(config);
  const address = await server.listen();
  const { leader, guest, room } = await setupRoom(`ws://${address.address}:${address.port}/jam`);

  const offered = next(guest, "track_offer");
  leader.send(JSON.stringify({ type: "offer_track", room_id: room.room_id, leader_token: room.leader_token, track: profileTrack }));
  const offer = await offered;
  assert.equal(offer.track.source, "profile");
  assert.equal(offer.track.temporary, true);
  assert.equal(offer.track.injected, undefined);

  const bad = next(leader, "error");
  leader.send(JSON.stringify({ type: "offer_track", room_id: room.room_id, leader_token: room.leader_token, track: { ...profileTrack, source: "evil" } }));
  assert.equal((await bad).code, "invalid_track");

  leader.close();
  guest.close();
  await server.close();
});

test("server assigns increasing revisions and clamps position", async () => {
  const server = createJamServer(config);
  const address = await server.listen();
  const { leader, guest, room } = await setupRoom(`ws://${address.address}:${address.port}/jam`);
  const base = { track: profileTrack, playing: true, start_at_server_ms: Date.now() };

  let state = next(guest, "room_state");
  leader.send(JSON.stringify({ type: "set_state", room_id: room.room_id, leader_token: room.leader_token, state: { ...base, position_ms: 999999, revision: 5 } }));
  let received = await state;
  assert.equal(received.state.revision, 5);
  assert.equal(received.state.position_ms, 60000);
  assert.equal(received.state.updated_by, "leader");

  // A stale revision from a client still produces a newer server revision.
  state = next(guest, "room_state");
  leader.send(JSON.stringify({ type: "set_state", room_id: room.room_id, leader_token: room.leader_token, state: { ...base, position_ms: 1000, revision: 2 } }));
  received = await state;
  assert.equal(received.state.revision, 6);

  leader.close();
  guest.close();
  await server.close();
});

test("guest control is blocked in leader mode and pending guest track is cancelled", async () => {
  const server = createJamServer(config);
  const address = await server.listen();
  const { leader, guest, room } = await setupRoom(`ws://${address.address}:${address.port}/jam`);

  const denied = next(guest, "error");
  guest.send(JSON.stringify({ type: "set_state", room_id: room.room_id, state: { track: profileTrack, playing: false, position_ms: 0, start_at_server_ms: Date.now(), revision: 1 } }));
  assert.equal((await denied).code, "leader_required");

  const both = next(guest, "control_mode");
  leader.send(JSON.stringify({ type: "set_control_mode", room_id: room.room_id, leader_token: room.leader_token, control_mode: "both" }));
  await both;

  const offered = next(leader, "track_offer");
  guest.send(JSON.stringify({ type: "offer_track", room_id: room.room_id, track: profileTrack }));
  await offered;

  const cancelled = next(guest, "track_cancelled");
  leader.send(JSON.stringify({ type: "set_control_mode", room_id: room.room_id, leader_token: room.leader_token, control_mode: "leader" }));
  assert.equal((await cancelled).track_id, profileTrack.id);
  assert.equal(server.rooms.get(room.room_id).pendingTrack, null);

  leader.close();
  guest.close();
  await server.close();
});

test("invite code is short and malformed joins are rejected", async () => {
  const server = createJamServer(config);
  const address = await server.listen();
  const url = `ws://${address.address}:${address.port}/jam`;
  const leader = await open(url);
  const guest = await open(url);

  const created = next(leader, "room_created");
  leader.send(JSON.stringify({ type: "create_room", client_version: CLIENT }));
  const room = await created;
  assert.equal(Buffer.from(room.invite_code, "base64url").length, 10);

  const bad = next(guest, "error");
  guest.send(JSON.stringify({ type: "join_room", client_version: CLIENT, invite_code: { nope: true } }));
  assert.equal((await bad).code, "invite_invalid");

  leader.close();
  guest.close();
  await server.close();
});

test("compareVersions orders dotted versions numerically", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.9", "0.9.0"), 0);
  assert.equal(compareVersions("0.8.1", "0.9.0"), -1);
});

test("hello and health announce versions and the update link", async () => {
  const server = createJamServer(config);
  const address = await server.listen();
  const socket = new WebSocket(`ws://${address.address}:${address.port}/jam`);
  const hello = await next(socket, "hello");
  assert.equal(hello.protocol, 2);
  assert.equal(hello.min_plugin_version, "0.9.0");
  assert.equal(hello.latest_plugin_version, "0.9.3");
  assert.equal(hello.update_url, "https://t.me/shit_plugins");
  assert.match(hello.server_version, /^\d+\.\d+\.\d+$/);

  const health = JSON.parse((await request(`http://${address.address}:${address.port}/health`)).body);
  assert.equal(health.latest_plugin_version, "0.9.3");
  assert.equal(health.update_url, "https://t.me/shit_plugins");
  assert.equal(health.server_version, hello.server_version);

  socket.close();
  await server.close();
});

test("latest version never drops below the minimum", async () => {
  const server = createJamServer({ ...config, minPluginVersion: "1.2.0", latestPluginVersion: "1.0.0" });
  const address = await server.listen();
  const health = JSON.parse((await request(`http://${address.address}:${address.port}/health`)).body);
  assert.equal(health.latest_plugin_version, "1.2.0");
  await server.close();
});

test("outdated or unversioned plugins are refused with version details", async () => {
  const server = createJamServer({ ...config, updateUrl: "https://t.me/example" });
  const address = await server.listen();
  const socket = await open(`ws://${address.address}:${address.port}/jam`);

  let refused = next(socket, "error");
  socket.send(JSON.stringify({ type: "create_room" }));
  let error = await refused;
  assert.equal(error.code, "client_outdated");
  assert.equal(error.client_version, null);
  assert.equal(error.update_url, "https://t.me/example");

  refused = next(socket, "error");
  socket.send(JSON.stringify({ type: "join_room", invite_code: "abc", client_version: "0.8.1" }));
  error = await refused;
  assert.equal(error.code, "client_outdated");
  assert.equal(error.client_version, "0.8.1");
  assert.equal(error.min_plugin_version, "0.9.0");
  assert.equal(server.rooms.size, 0);

  socket.close();
  await server.close();
});
