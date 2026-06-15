"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const HEARTBEAT_INTERVAL_MS = 25000;
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300 MB

// Allow cross-origin requests so the static host (Strato) can talk to this API server (Render).
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

// In-memory audio (cleared on server restart)
let uploadedAudio = null; // { buffer: Buffer, mime: string }

const clients = new Map();
let leaderId = null;

let transportState = {
  playing: false,
  startServerTime: 0,
  position: 0,
  globalOffsetMs: 0,
};

const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function getQueryParam(req, key) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    return url.searchParams.get(key) || "";
  } catch {
    return "";
  }
}

function isTokenValid(token) {
  return !AUTH_TOKEN || token === AUTH_TOKEN;
}

const ALLOWED_AUDIO_MIMES = new Set([
  "audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a", "audio/x-m4a",
  "audio/ogg", "audio/wav", "audio/wave", "audio/x-wav",
  "audio/aac", "audio/flac", "audio/x-flac",
  "audio/webm", "audio/opus",
]);

function isAudioMagicBytes(buf) {
  if (buf.length < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // MP3 (ID3)
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return true;           // MP3 sync / AAC ADTS
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true; // OGG
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true; // WAV
  if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) return true; // FLAC
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return true; // WebM
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true; // MP4/M4A (ftyp)
  return false;
}

function serveStatic(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_MAP[ext] || "application/octet-stream";
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found\n");
      return;
    }
    res.writeHead(200, { "content-type": mime, "cache-control": "no-cache" });
    res.end(data);
  });
}

function serveAudioBuffer(req, res, buffer, mime) {
  const total = buffer.length;
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        ...CORS_HEADERS,
        "content-type": mime,
        "content-length": String(chunkSize),
        "content-range": `bytes ${start}-${end}/${total}`,
        "accept-ranges": "bytes",
      });
      res.end(buffer.subarray(start, end + 1));
      return;
    }
  }

  res.writeHead(200, {
    ...CORS_HEADERS,
    "content-type": mime,
    "content-length": String(total),
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
  });
  res.end(buffer);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health check (no auth)
  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { ...CORS_HEADERS, "content-type": "text/plain" });
    res.end("ok\n");
    return;
  }

  // Audio download (token required when AUTH_TOKEN is set)
  if (req.method === "GET" && pathname === "/audio") {
    const token = getQueryParam(req, "token");
    if (!isTokenValid(token)) {
      res.writeHead(401, { ...CORS_HEADERS, "content-type": "text/plain" });
      res.end("Unauthorized\n");
      return;
    }

    if (uploadedAudio) {
      serveAudioBuffer(req, res, uploadedAudio.buffer, uploadedAudio.mime);
      return;
    }

    // Fall back to bundled static audio file
    const staticPath = path.join(PUBLIC_DIR, "Bohemian_Rhapsody.m4a");
    fs.readFile(staticPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("No audio available\n");
        return;
      }
      serveAudioBuffer(req, res, data, "audio/mp4");
    });
    return;
  }

  // Audio upload (POST, token required)
  if (req.method === "POST" && pathname === "/upload") {
    const token = getQueryParam(req, "token");
    if (!isTokenValid(token)) {
      res.writeHead(401, { ...CORS_HEADERS, "content-type": "text/plain" });
      res.end("Unauthorized\n");
      return;
    }

    const mime = (req.headers["content-type"] || "").split(";")[0].trim();
    if (!ALLOWED_AUDIO_MIMES.has(mime)) {
      res.writeHead(415, { ...CORS_HEADERS, "content-type": "text/plain" });
      res.end("Nur Audiodateien erlaubt (MP3, M4A, OGG, WAV, FLAC)\n");
      return;
    }

    const chunks = [];
    let size = 0;
    let aborted = false;
    let magicChecked = false;

    req.on("data", (chunk) => {
      if (aborted) return;

      if (!magicChecked) {
        magicChecked = true;
        if (!isAudioMagicBytes(chunk)) {
          aborted = true;
          req.destroy();
          if (!res.headersSent) {
            res.writeHead(415, { ...CORS_HEADERS, "content-type": "text/plain" });
            res.end("Ungültige Datei – kein erkanntes Audioformat\n");
          }
          return;
        }
      }

      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        aborted = true;
        if (!res.headersSent) {
          res.writeHead(413, { ...CORS_HEADERS, "content-type": "text/plain" });
          res.end("Datei zu groß (max. 300 MB)\n");
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      uploadedAudio = { buffer: Buffer.concat(chunks), mime };
      console.log(`Audio uploaded: ${(size / 1024 / 1024).toFixed(1)} MB, ${mime}`);
      broadcast({ type: "audio-updated" });
      res.writeHead(200, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, bytes: size }));
    });

    req.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500, { ...CORS_HEADERS, "content-type": "text/plain" });
        res.end("Upload-Fehler\n");
      }
    });
    return;
  }

  // Static files
  if (req.method === "GET") {
    const safeName = pathname === "/" || pathname === "" ? "index.html" : pathname;
    const filePath = path.resolve(PUBLIC_DIR, "." + safeName);

    // Prevent path traversal
    if (!filePath.startsWith(path.resolve(PUBLIC_DIR))) {
      res.writeHead(403);
      res.end();
      return;
    }

    serveStatic(filePath, res);
    return;
  }

  res.writeHead(405);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const token = getQueryParam(req, "token");
  if (!isTokenValid(token)) {
    ws.close(4001, "Unauthorized");
    return;
  }

  const client = {
    id: randomId(),
    role: "listener",
    ws,
    isAlive: true,
  };
  clients.set(client.id, client);

  send(ws, { type: "state", state: transportState });
  broadcastClientCount();

  ws.on("pong", () => {
    client.isAlive = true;
  });

  const heartbeatTimer = setInterval(() => {
    if (!client.isAlive) {
      ws.terminate();
      return;
    }
    client.isAlive = false;
    ws.ping();
  }, HEARTBEAT_INTERVAL_MS);

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
    clearInterval(heartbeatTimer);
    clients.delete(client.id);
    if (leaderId === client.id) {
      leaderId = null;
    }
    broadcastClientCount();
  });
});

server.on("error", (error) => {
  console.error("Server error:", error);
  process.exitCode = 1;
});

server.listen(PORT, () => {
  console.log(`Silent Cinema sync server listening on port ${PORT}`);
  console.log(`Static files: ${PUBLIC_DIR}`);
  console.log(`Auth: ${AUTH_TOKEN ? "token required" : "open (no AUTH_TOKEN set)"}`);
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

  if (message.type === "sync-signal") {
    if (!isAuthorizedLeader(client)) return;
    // Give all clients 2 seconds to receive the message before it fires.
    const serverTime = Date.now() + 2000;
    broadcast({ type: "sync-signal", serverTime });
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
      globalOffsetMs: transportState.globalOffsetMs,
    };
    broadcastState();
    return;
  }

  if (message.action === "pause") {
    transportState = {
      playing: false,
      startServerTime: 0,
      position,
      globalOffsetMs: transportState.globalOffsetMs,
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
        globalOffsetMs: transportState.globalOffsetMs,
      };
    } else {
      transportState = {
        playing: false,
        startServerTime: 0,
        position,
        globalOffsetMs: transportState.globalOffsetMs,
      };
    }
    broadcastState();
    return;
  }

  if (message.action === "offset") {
    transportState = {
      ...transportState,
      globalOffsetMs: sanitizeOffset(message.globalOffsetMs),
    };
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
    globalOffsetMs: transportState.globalOffsetMs,
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

function sanitizeOffset(value) {
  const offset = Number(value);
  if (!Number.isFinite(offset)) return 0;
  return Math.min(1000, Math.max(-1000, Math.round(offset)));
}

function randomId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
