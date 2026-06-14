"use strict";

const http = require("http");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

const clients = new Map();
let leaderId = null;

let transportState = {
  playing: false,
  startServerTime: 0,
  position: 0,
};

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("silent-cinema-sync-ok\n");
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const client = {
    id: randomId(),
    role: "listener",
    ws,
  };
  clients.set(client.id, client);

  send(ws, { type: "state", state: transportState });
  broadcastClientCount();

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    handleMessage(client, message);
  });

  ws.on("close", () => {
    clients.delete(client.id);
    if (leaderId === client.id) {
      leaderId = null;
    }
    broadcastClientCount();
  });
});

server.on("error", (error) => {
  console.error("HTTP/WebSocket server error:", error);
  process.exitCode = 1;
});

server.listen(PORT, () => {
  console.log(`Silent Cinema sync server listening on ${PORT}`);
});

function handleMessage(client, message) {
  if (message.type === "hello") {
    client.role = message.role === "leader" ? "leader" : "listener";
    if (client.role === "leader" && !leaderId) {
      leaderId = client.id;
    }
    send(client.ws, { type: "state", state: transportState });
    broadcastClientCount();
    return;
  }

  if (message.type === "ping") {
    const t1 = now();
    const t2 = now();
    send(client.ws, { type: "pong", id: message.id, t0: message.t0, t1, t2 });
    return;
  }

  if (message.type === "control") {
    if (!isAuthorizedLeader(client)) {
      send(client.ws, { type: "error", message: "Nur der Leiter darf steuern." });
      return;
    }
    applyControl(message);
  }
}

function applyControl(message) {
  const current = getCurrentTransportState();
  const position = sanitizePosition(message.position ?? current.position);

  if (message.action === "play") {
    transportState = {
      playing: true,
      startServerTime: sanitizeTime(message.startServerTime || now() + 3000),
      position,
    };
    broadcastState();
    return;
  }

  if (message.action === "pause") {
    transportState = {
      playing: false,
      startServerTime: 0,
      position,
    };
    broadcastState();
    return;
  }

  if (message.action === "seek") {
    if (current.playing) {
      transportState = {
        playing: true,
        startServerTime: now() + 1000,
        position,
      };
    } else {
      transportState = {
        playing: false,
        startServerTime: 0,
        position,
      };
    }
    broadcastState();
  }
}

function getCurrentTransportState() {
  if (!transportState.playing) {
    return { ...transportState };
  }

  const elapsed = Math.max(0, (now() - transportState.startServerTime) / 1000);
  return {
    playing: true,
    startServerTime: transportState.startServerTime,
    position: transportState.position + elapsed,
  };
}

function broadcastState() {
  broadcast({ type: "state", state: transportState });
}

function broadcastClientCount() {
  const count = clients.size;
  for (const client of clients.values()) {
    if (client.role === "leader") {
      send(client.ws, { type: "clients", count });
    }
  }
}

function broadcast(payload) {
  for (const client of clients.values()) {
    send(client.ws, payload);
  }
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function isAuthorizedLeader(client) {
  return client.role === "leader" && client.id === leaderId;
}

function now() {
  return performance.timeOrigin + performance.now();
}

function sanitizePosition(value) {
  const position = Number(value);
  if (!Number.isFinite(position) || position < 0) return 0;
  return position;
}

function sanitizeTime(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time < 0) return now();
  return time;
}

function randomId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
