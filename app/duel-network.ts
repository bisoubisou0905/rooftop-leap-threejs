import { makeDuelMatchId, normalizeDuelRoom } from "./duel-room";

export type DuelCharacter = "runner" | "heavy";

export type DuelPose = {
  position: [number, number, number];
  velocity: [number, number, number];
  rotationY: number;
  phase: "idle" | "charging" | "flying" | "falling" | "failed";
  step: number;
  elapsedMs: number;
  character: DuelCharacter;
};

type LobbyPacket = {
  version: 3;
  room: string;
  from: string;
  sentAt: number;
  character: DuelCharacter;
  type: "hello" | "offer" | "accept" | "start";
  target?: string;
  busy?: boolean;
  matchId?: string;
  delayMs?: number;
};

type GamePayload =
  | { type: "character"; character: DuelCharacter }
  | { type: "pose"; pose: DuelPose }
  | { type: "bump"; id: string; velocity: [number, number, number] }
  | { type: "finish"; elapsedMs: number };

type GamePacket = {
  version: 3;
  room: string;
  from: string;
  target: string;
  matchId: string;
} & GamePayload;

type MqttMessage = {
  toString(): string;
};

type MqttClientLike = {
  connected: boolean;
  on(event: "connect", callback: () => void): void;
  on(event: "reconnect", callback: () => void): void;
  on(event: "close", callback: () => void): void;
  on(event: "offline", callback: () => void): void;
  on(event: "error", callback: (error: Error) => void): void;
  on(
    event: "message",
    callback: (topic: string, message: MqttMessage) => void,
  ): void;
  subscribe(
    topic: string,
    options?: { qos?: 0 | 1 },
    callback?: (error?: Error) => void,
  ): void;
  publish(
    topic: string,
    payload: string,
    options?: { qos?: 0 | 1; retain?: boolean },
  ): void;
  end(force?: boolean): void;
};

type MqttLibrary = {
  connect(
    url: string,
    options: {
      clientId: string;
      clean: boolean;
      connectTimeout: number;
      reconnectPeriod: number;
      keepalive: number;
      protocolVersion: 4;
    },
  ): MqttClientLike;
};

declare global {
  interface Window {
    mqtt?: MqttLibrary;
  }
}

export type DuelNetworkStatus =
  | "loading"
  | "hosting"
  | "joining"
  | "connected"
  | "reconnecting"
  | "full"
  | "unsupported"
  | "error";

export type DuelNetworkCallbacks = {
  onStatus(status: DuelNetworkStatus): void;
  onStart(delayMs: number, lane: -1 | 1): void;
  onPose(pose: DuelPose): void;
  onBump(velocity: [number, number, number]): void;
  onFinish(elapsedMs: number): void;
  onRemoteCharacter(character: DuelCharacter): void;
};

export type DuelNetworkController = {
  sendPose(pose: DuelPose): void;
  sendBump(velocity: [number, number, number]): void;
  sendFinish(elapsedMs: number): void;
  destroy(): void;
};

const SCRIPT_ID = "rooftop-mqtt-client";
const SCRIPT_URL = "https://unpkg.com/mqtt@5.14.1/dist/mqtt.min.js";
const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
const PROTOCOL_VERSION = 3 as const;
const START_DELAY_MS = 2400;
const HEARTBEAT_MS = 1100;
const REMOTE_TIMEOUT_MS = 7200;

function createClientId() {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `rl${random}`;
}

function loadMqttLibrary() {
  if (window.mqtt) return Promise.resolve(window.mqtt);
  return new Promise<MqttLibrary>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    const timeout = window.setTimeout(
      () => reject(new Error("The relay client timed out while loading.")),
      12000,
    );
    const finish = () => {
      window.clearTimeout(timeout);
      if (window.mqtt) resolve(window.mqtt);
      else reject(new Error("The relay client did not load correctly."));
    };
    script.addEventListener("load", finish, { once: true });
    script.addEventListener(
      "error",
      () => {
        window.clearTimeout(timeout);
        reject(new Error("The relay client could not be loaded."));
      },
      { once: true },
    );
    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_URL;
      script.crossOrigin = "anonymous";
      document.head.appendChild(script);
    }
  });
}

function isCharacter(value: unknown): value is DuelCharacter {
  return value === "runner" || value === "heavy";
}

function isFiniteTriplet(value: unknown): value is [number, number, number] {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isPose(value: unknown): value is DuelPose {
  if (!value || typeof value !== "object") return false;
  const pose = value as Partial<DuelPose>;
  return isFiniteTriplet(pose.position) &&
    isFiniteTriplet(pose.velocity) &&
    typeof pose.rotationY === "number" &&
    Number.isFinite(pose.rotationY) &&
    typeof pose.step === "number" &&
    Number.isFinite(pose.step) &&
    typeof pose.elapsedMs === "number" &&
    Number.isFinite(pose.elapsedMs) &&
    isCharacter(pose.character) &&
    ["idle", "charging", "flying", "falling", "failed"].includes(
      String(pose.phase),
    );
}

function parsePacket(message: MqttMessage) {
  try {
    const raw = message.toString();
    if (raw.length > 24_000) return null;
    const packet = JSON.parse(raw) as Partial<LobbyPacket | GamePacket>;
    return packet && typeof packet === "object" ? packet : null;
  } catch {
    return null;
  }
}

export async function createDuelNetwork(
  character: DuelCharacter,
  roomValue: string,
  callbacks: DuelNetworkCallbacks,
): Promise<DuelNetworkController> {
  callbacks.onStatus("loading");
  if (!("WebSocket" in window)) {
    callbacks.onStatus("unsupported");
    throw new Error("Secure WebSockets are not supported by this browser.");
  }

  const mqtt = await loadMqttLibrary();
  const room = normalizeDuelRoom(roomValue);
  const localId = createClientId();
  const baseTopic = `rooftop-leap/v3/${room}`;
  const lobbyTopic = `${baseTopic}/lobby`;
  const client = mqtt.connect(BROKER_URL, {
    clientId: `rooftop_${localId}`,
    clean: true,
    connectTimeout: 9000,
    reconnectPeriod: 1600,
    keepalive: 20,
    protocolVersion: 4,
  });

  let destroyed = false;
  let remoteId: string | null = null;
  let matchId: string | null = null;
  let matchStarted = false;
  let remoteLastSeenAt = 0;
  let lastOfferAt = 0;
  let lastPoseSentAt = 0;
  let startAt = 0;
  const seenBumps = new Set<string>();

  const publish = (
    topic: string,
    packet: LobbyPacket | GamePacket,
    reliable = false,
  ) => {
    if (destroyed || !client.connected) return;
    client.publish(topic, JSON.stringify(packet), {
      qos: reliable ? 1 : 0,
      retain: false,
    });
  };

  const publishLobby = (
    packet: Omit<LobbyPacket, "version" | "room" | "from" | "sentAt" | "character">,
    reliable = false,
  ) => {
    publish(lobbyTopic, {
      version: PROTOCOL_VERSION,
      room,
      from: localId,
      sentAt: Date.now(),
      character,
      ...packet,
    }, reliable);
  };

  const publishHello = () => {
    publishLobby({
      type: "hello",
      busy: matchStarted,
      target: remoteId ?? undefined,
      matchId: matchId ?? undefined,
    });
  };

  const resetMatch = (status: DuelNetworkStatus) => {
    remoteId = null;
    matchId = null;
    matchStarted = false;
    remoteLastSeenAt = 0;
    lastOfferAt = 0;
    startAt = 0;
    if (!destroyed) callbacks.onStatus(status);
  };

  const sendGamePacket = (
    packet: GamePayload,
    reliable = false,
  ) => {
    if (!remoteId || !matchId || !matchStarted) return;
    publish(`${baseTopic}/match/${matchId}`, {
      version: PROTOCOL_VERSION,
      room,
      from: localId,
      target: remoteId,
      matchId,
      ...packet,
    } as GamePacket, reliable);
  };

  const startHostMatch = (otherId: string, otherCharacter: DuelCharacter) => {
    remoteId = otherId;
    matchId = makeDuelMatchId(localId, otherId);
    remoteLastSeenAt = Date.now();
    callbacks.onRemoteCharacter(otherCharacter);
    if (!matchStarted) {
      matchStarted = true;
      startAt = Date.now() + START_DELAY_MS;
      callbacks.onStatus("connected");
      callbacks.onStart(START_DELAY_MS, -1);
      sendGamePacket({ type: "character", character }, true);
    }
    publishLobby({
      type: "start",
      target: otherId,
      matchId,
      delayMs: Math.max(600, startAt - Date.now()),
    }, true);
  };

  const startGuestMatch = (
    otherId: string,
    otherCharacter: DuelCharacter,
    proposedMatchId: string,
    delayMs: number,
  ) => {
    const expectedMatchId = makeDuelMatchId(localId, otherId);
    if (proposedMatchId !== expectedMatchId) return;
    remoteId = otherId;
    matchId = expectedMatchId;
    remoteLastSeenAt = Date.now();
    callbacks.onRemoteCharacter(otherCharacter);
    if (matchStarted) return;
    matchStarted = true;
    callbacks.onStatus("connected");
    callbacks.onStart(Math.max(600, Math.min(5000, delayMs)), 1);
    sendGamePacket({ type: "character", character }, true);
  };

  const handleLobbyPacket = (packet: Partial<LobbyPacket>) => {
    if (
      packet.version !== PROTOCOL_VERSION ||
      packet.room !== room ||
      typeof packet.from !== "string" ||
      packet.from === localId ||
      !isCharacter(packet.character) ||
      typeof packet.sentAt !== "number" ||
      Math.abs(Date.now() - packet.sentAt) > 15_000
    ) return;

    if (packet.from === remoteId) remoteLastSeenAt = Date.now();

    if (packet.type === "hello") {
      if (packet.from === remoteId) return;
      if (packet.busy || remoteId || localId > packet.from) return;
      const now = Date.now();
      if (now - lastOfferAt < 850) return;
      lastOfferAt = now;
      callbacks.onStatus("joining");
      publishLobby({ type: "offer", target: packet.from }, true);
      return;
    }

    if (packet.target !== localId) return;

    if (packet.type === "offer") {
      if (packet.from > localId || (remoteId && remoteId !== packet.from)) return;
      remoteId = packet.from;
      matchId = makeDuelMatchId(localId, packet.from);
      remoteLastSeenAt = Date.now();
      callbacks.onRemoteCharacter(packet.character);
      callbacks.onStatus("joining");
      publishLobby({
        type: "accept",
        target: packet.from,
        matchId,
      }, true);
      return;
    }

    if (packet.type === "accept") {
      if (localId > packet.from || (remoteId && remoteId !== packet.from)) return;
      if (packet.matchId !== makeDuelMatchId(localId, packet.from)) return;
      startHostMatch(packet.from, packet.character);
      return;
    }

    if (
      packet.type === "start" &&
      typeof packet.matchId === "string" &&
      typeof packet.delayMs === "number" &&
      Number.isFinite(packet.delayMs) &&
      (!remoteId || remoteId === packet.from)
    ) {
      startGuestMatch(packet.from, packet.character, packet.matchId, packet.delayMs);
    }
  };

  const handleGamePacket = (packet: Partial<GamePacket>) => {
    if (
      !matchStarted ||
      !remoteId ||
      !matchId ||
      packet.version !== PROTOCOL_VERSION ||
      packet.room !== room ||
      packet.from !== remoteId ||
      packet.target !== localId ||
      packet.matchId !== matchId
    ) return;
    remoteLastSeenAt = Date.now();

    if (packet.type === "character" && isCharacter(packet.character)) {
      callbacks.onRemoteCharacter(packet.character);
    } else if (packet.type === "pose" && isPose(packet.pose)) {
      callbacks.onPose(packet.pose);
    } else if (
      packet.type === "bump" &&
      typeof packet.id === "string" &&
      isFiniteTriplet(packet.velocity) &&
      !seenBumps.has(packet.id)
    ) {
      seenBumps.add(packet.id);
      if (seenBumps.size > 48) seenBumps.delete(seenBumps.values().next().value!);
      callbacks.onBump(packet.velocity);
    } else if (
      packet.type === "finish" &&
      typeof packet.elapsedMs === "number" &&
      Number.isFinite(packet.elapsedMs)
    ) {
      callbacks.onFinish(Math.max(0, packet.elapsedMs));
    }
  };

  client.on("connect", () => {
    if (destroyed) return;
    client.subscribe(`${baseTopic}/#`, { qos: 1 }, (error) => {
      if (destroyed) return;
      if (error) {
        callbacks.onStatus("error");
        return;
      }
      resetMatch("hosting");
      publishHello();
    });
  });
  client.on("reconnect", () => {
    if (!destroyed) callbacks.onStatus("reconnecting");
  });
  client.on("offline", () => {
    if (!destroyed) callbacks.onStatus("reconnecting");
  });
  client.on("close", () => {
    if (!destroyed) resetMatch("reconnecting");
  });
  client.on("error", () => {
    if (!destroyed) callbacks.onStatus(client.connected ? "reconnecting" : "error");
  });
  client.on("message", (topic, message) => {
    if (destroyed || !topic.startsWith(`${baseTopic}/`)) return;
    const packet = parsePacket(message);
    if (!packet) return;
    if (topic === lobbyTopic) handleLobbyPacket(packet as Partial<LobbyPacket>);
    else if (topic.includes("/match/")) handleGamePacket(packet as Partial<GamePacket>);
  });

  const heartbeatTimer = window.setInterval(() => {
    if (client.connected) publishHello();
  }, HEARTBEAT_MS);
  const watchdogTimer = window.setInterval(() => {
    if (
      !destroyed &&
      remoteId &&
      remoteLastSeenAt > 0 &&
      Date.now() - remoteLastSeenAt > REMOTE_TIMEOUT_MS
    ) {
      resetMatch("reconnecting");
      publishHello();
    }
  }, 1300);

  return {
    sendPose(pose) {
      const now = performance.now();
      if (now - lastPoseSentAt < 80) return;
      lastPoseSentAt = now;
      sendGamePacket({ type: "pose", pose });
    },
    sendBump(velocity) {
      sendGamePacket({
        type: "bump",
        id: `${localId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        velocity,
      }, true);
    },
    sendFinish(elapsedMs) {
      sendGamePacket({ type: "finish", elapsedMs }, true);
    },
    destroy() {
      destroyed = true;
      window.clearInterval(heartbeatTimer);
      window.clearInterval(watchdogTimer);
      client.end(true);
    },
  };
}
