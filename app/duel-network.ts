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

type DuelPacket =
  | { type: "hello"; character: DuelCharacter }
  | { type: "start"; delayMs: number }
  | { type: "pose"; pose: DuelPose }
  | { type: "bump"; id: string; velocity: [number, number, number] }
  | { type: "finish"; elapsedMs: number }
  | { type: "full" };

type PeerError = Error & { type?: string };

type DataConnectionLike = {
  open: boolean;
  peer: string;
  send(data: DuelPacket): void;
  close(): void;
  on(event: "open", callback: () => void): void;
  on(event: "data", callback: (data: unknown) => void): void;
  on(event: "close", callback: () => void): void;
  on(event: "error", callback: (error: Error) => void): void;
};

type PeerLike = {
  id?: string;
  destroyed: boolean;
  connect(id: string, options?: Record<string, unknown>): DataConnectionLike;
  destroy(): void;
  on(event: "open", callback: (id: string) => void): void;
  on(event: "connection", callback: (connection: DataConnectionLike) => void): void;
  on(event: "error", callback: (error: PeerError) => void): void;
  on(event: "disconnected", callback: () => void): void;
};

type PeerConstructor = new (
  id?: string,
  options?: Record<string, unknown>,
) => PeerLike;

declare global {
  interface Window {
    Peer?: PeerConstructor;
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

const SCRIPT_ID = "rooftop-peerjs-client";
const SCRIPT_URL = "https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js";
const LOBBY_ID = "rooftop-leap-public-duel-v1";

function loadPeerConstructor() {
  if (window.Peer) return Promise.resolve(window.Peer);
  return new Promise<PeerConstructor>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    const finish = () => {
      if (window.Peer) resolve(window.Peer);
      else reject(new Error("PeerJS client did not expose a Peer constructor."));
    };
    script.addEventListener("load", finish, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("PeerJS client could not be loaded.")),
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

export async function createDuelNetwork(
  character: DuelCharacter,
  callbacks: DuelNetworkCallbacks,
): Promise<DuelNetworkController> {
  callbacks.onStatus("loading");
  if (!("RTCPeerConnection" in window)) {
    callbacks.onStatus("unsupported");
    throw new Error("WebRTC is not supported by this browser.");
  }

  const Peer = await loadPeerConstructor();
  let peer: PeerLike | null = null;
  let connection: DataConnectionLike | null = null;
  let destroyed = false;
  let host = false;
  let lastPoseSentAt = 0;
  const seenBumps = new Set<string>();

  const send = (packet: DuelPacket) => {
    if (!destroyed && connection?.open) connection.send(packet);
  };

  const acceptConnection = (candidate: DataConnectionLike) => {
    if (connection?.open) {
      candidate.on("open", () => {
        candidate.send({ type: "full" });
        candidate.close();
      });
      return;
    }
    connection = candidate;
    candidate.on("open", () => {
      if (destroyed) return;
      callbacks.onStatus("connected");
      send({ type: "hello", character });
      if (host) {
        const delayMs = 2200;
        send({ type: "start", delayMs });
        callbacks.onStart(delayMs, -1);
      }
    });
    candidate.on("data", (raw) => {
      if (!raw || typeof raw !== "object") return;
      const packet = raw as Partial<DuelPacket>;
      if (packet.type === "hello" && isCharacter(packet.character)) {
        callbacks.onRemoteCharacter(packet.character);
      } else if (
        packet.type === "start" &&
        typeof packet.delayMs === "number" &&
        Number.isFinite(packet.delayMs)
      ) {
        callbacks.onStart(Math.max(600, Math.min(5000, packet.delayMs)), 1);
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
      } else if (packet.type === "full") {
        callbacks.onStatus("full");
      }
    });
    candidate.on("close", () => {
      if (!destroyed) callbacks.onStatus("reconnecting");
    });
    candidate.on("error", () => {
      if (!destroyed) callbacks.onStatus("error");
    });
  };

  const joinLobby = () => {
    if (destroyed) return;
    callbacks.onStatus("joining");
    peer = new Peer();
    peer.on("open", () => {
      if (destroyed || !peer) return;
      acceptConnection(
        peer.connect(LOBBY_ID, {
          label: "rooftop-duel",
          serialization: "json",
          reliable: false,
          metadata: { game: "rooftop-leap", version: 1 },
        }),
      );
    });
    peer.on("error", (error) => {
      if (destroyed) return;
      callbacks.onStatus(error.type === "peer-unavailable" ? "reconnecting" : "error");
    });
    peer.on("disconnected", () => {
      if (!destroyed && !connection?.open) callbacks.onStatus("reconnecting");
    });
  };

  callbacks.onStatus("hosting");
  host = true;
  peer = new Peer(LOBBY_ID);
  peer.on("open", () => {
    if (!destroyed) callbacks.onStatus("hosting");
  });
  peer.on("connection", acceptConnection);
  peer.on("error", (error) => {
    if (destroyed) return;
    if (error.type === "unavailable-id") {
      host = false;
      peer?.destroy();
      joinLobby();
      return;
    }
    callbacks.onStatus("error");
  });
  peer.on("disconnected", () => {
    if (!destroyed && !connection?.open) callbacks.onStatus("reconnecting");
  });

  return {
    sendPose(pose) {
      const now = performance.now();
      if (now - lastPoseSentAt < 66) return;
      lastPoseSentAt = now;
      send({ type: "pose", pose });
    },
    sendBump(velocity) {
      send({
        type: "bump",
        id: `${peer?.id ?? "peer"}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        velocity,
      });
    },
    sendFinish(elapsedMs) {
      send({ type: "finish", elapsedMs });
    },
    destroy() {
      destroyed = true;
      connection?.close();
      peer?.destroy();
      connection = null;
      peer = null;
    },
  };
}
