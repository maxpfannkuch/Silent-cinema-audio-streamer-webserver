"use strict";

// Render-WebSocket-URL nach dem Deploy hier eintragen.
const SYNC_SERVER_URL = "wss://silent-cinema-audio-streamer-webserver.onrender.com";

const AUDIO_URL = "Bohemian_Rhapsody.m4a";
const START_DELAY_MS = 3000;
const SYNC_SAMPLE_COUNT = 20;
const RESYNC_INTERVAL_MS = 10000;
const DRIFT_INTERVAL_MS = 2000;
const SMALL_DRIFT_LIMIT_S = 0.5;
const RATE_CORRECTION_GAIN = 0.08;
const MAX_RATE_ADJUSTMENT = 0.005;

const params = new URLSearchParams(window.location.search);
const isLeader = params.get("role") === "leader";

const els = {
  pageTitle: document.getElementById("pageTitle"),
  roleLabel: document.getElementById("roleLabel"),
  joinButton: document.getElementById("joinButton"),
  connectionStatus: document.getElementById("connectionStatus"),
  audioStatus: document.getElementById("audioStatus"),
  syncStatus: document.getElementById("syncStatus"),
  playbackStatus: document.getElementById("playbackStatus"),
  offsetSlider: document.getElementById("offsetSlider"),
  offsetValue: document.getElementById("offsetValue"),
  leaderPanel: document.getElementById("leaderPanel"),
  clientCount: document.getElementById("clientCount"),
  videoFileInput: document.getElementById("videoFileInput"),
  leaderVideo: document.getElementById("leaderVideo"),
  playButton: document.getElementById("playButton"),
  pauseButton: document.getElementById("pauseButton"),
  seekSlider: document.getElementById("seekSlider"),
  seekValue: document.getElementById("seekValue"),
};

const state = {
  ws: null,
  clientId: randomId(),
  joined: false,
  audioContext: null,
  audioBuffer: null,
  source: null,
  sourceStartedAtContext: 0,
  sourceOffset: 0,
  lastKnownPosition: 0,
  serverOffsetMs: 0,
  bestSyncDeltaMs: Infinity,
  wakeLock: null,
  transport: { playing: false, startServerTime: 0, position: 0 },
  syncRequests: new Map(),
  reconnectTimer: 0,
  driftTimer: 0,
  resyncTimer: 0,
  seekUiTimer: 0,
};

init();

function init() {
  if (isLeader) {
    els.pageTitle.textContent = "Film leiten";
    els.roleLabel.textContent = "Leiter";
    els.leaderPanel.hidden = false;
  }

  els.offsetSlider.addEventListener("input", () => {
    els.offsetValue.textContent = `${getGlobalOffsetMs()} ms`;
    if (state.transport.playing && state.audioBuffer) {
      scheduleAudioFromTransport(state.transport, true);
    }
  });

  els.joinButton.addEventListener("click", join);
  els.videoFileInput.addEventListener("change", loadLeaderVideo);
  els.playButton.addEventListener("click", leaderPlay);
  els.pauseButton.addEventListener("click", leaderPause);
  els.seekSlider.addEventListener("input", () => {
    els.seekValue.textContent = formatTime(Number(els.seekSlider.value));
  });
  els.seekSlider.addEventListener("change", () => {
    leaderSeek(Number(els.seekSlider.value));
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      requestWakeLock();
      if (state.joined && state.transport.playing) {
        scheduleAudioFromTransport(state.transport, true);
      }
    }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // Die App läuft auch ohne Service Worker; dann muss am Abend online nachgeladen werden.
    });
  }

  connect();
  startSeekUiLoop();
}

async function join() {
  els.joinButton.disabled = true;
  setText(els.audioStatus, "Audio wird vorbereitet");

  try {
    state.audioContext = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();

    // iOS/Safari erlaubt AudioContext-Ausgabe erst nach einer echten Nutzergeste.
    await state.audioContext.resume();
    await requestWakeLock();
    await loadAudioBuffer();

    state.joined = true;
    els.joinButton.textContent = "Tonspur bereit";
    setText(els.audioStatus, "bereit", "is-ok");

    if (state.ws?.readyState === WebSocket.OPEN) {
      send({ type: "hello", role: isLeader ? "leader" : "listener", clientId: state.clientId });
      runInitialSync();
    }

    if (state.transport.playing) {
      scheduleAudioFromTransport(state.transport, true);
    }
  } catch (error) {
    console.error(error);
    els.joinButton.disabled = false;
    setText(els.audioStatus, "Fehler beim Laden", "is-bad");
    alert("Die Tonspur konnte nicht geladen werden. Liegt Bohemian_Rhapsody.m4a im public-Ordner und ist die Seite über HTTPS erreichbar?");
  }
}

async function loadAudioBuffer() {
  if (state.audioBuffer) return;

  const response = await fetch(AUDIO_URL, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Audio fetch failed: ${response.status}`);
  }

  const data = await response.arrayBuffer();
  state.audioBuffer = await state.audioContext.decodeAudioData(data);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;

  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch (error) {
    // Safari/iOS kann Wake Lock je nach Version verweigern. Deshalb steht der Auto-Sperre-Hinweis im UI.
    console.warn("Wake Lock nicht verfügbar:", error);
  }
}

function connect() {
  clearTimeout(state.reconnectTimer);
  setText(els.connectionStatus, "verbindet");

  const ws = new WebSocket(SYNC_SERVER_URL);
  state.ws = ws;

  ws.addEventListener("open", () => {
    setText(els.connectionStatus, "verbunden", "is-ok");
    send({ type: "hello", role: isLeader ? "leader" : "listener", clientId: state.clientId });
    runInitialSync();
  });

  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(message);
  });

  ws.addEventListener("close", () => {
    setText(els.connectionStatus, "getrennt", "is-bad");
    clearInterval(state.resyncTimer);
    state.reconnectTimer = window.setTimeout(connect, 2000);
  });

  ws.addEventListener("error", () => {
    setText(els.connectionStatus, "Fehler", "is-bad");
  });
}

function handleMessage(message) {
  if (message.type === "pong") {
    handlePong(message);
    return;
  }

  if (message.type === "state") {
    applyTransportState(message.state);
    return;
  }

  if (message.type === "clients") {
    els.clientCount.textContent = String(message.count);
  }
}

function send(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

function runInitialSync() {
  performSyncBurst(SYNC_SAMPLE_COUNT);
  clearInterval(state.resyncTimer);
  state.resyncTimer = window.setInterval(() => performSyncBurst(6), RESYNC_INTERVAL_MS);
}

function performSyncBurst(count) {
  for (let i = 0; i < count; i += 1) {
    window.setTimeout(sendPing, i * 120);
  }
}

function sendPing() {
  const id = randomId();
  const t0 = performance.now();
  state.syncRequests.set(id, t0);
  send({ type: "ping", id, t0 });
}

function handlePong(message) {
  const t0 = state.syncRequests.get(message.id);
  if (typeof t0 !== "number") return;

  state.syncRequests.delete(message.id);

  const t3 = performance.now();
  const t1 = message.t1;
  const t2 = message.t2;
  const theta = ((t1 - t0) + (t2 - t3)) / 2;
  const delta = (t3 - t0) - (t2 - t1);

  if (delta < state.bestSyncDeltaMs) {
    state.bestSyncDeltaMs = delta;
    state.serverOffsetMs = theta;
  } else if (delta < state.bestSyncDeltaMs + 2) {
    state.serverOffsetMs = state.serverOffsetMs * 0.85 + theta * 0.15;
  }

  setText(els.syncStatus, `${Math.round(state.bestSyncDeltaMs)} ms RTT`, "is-ok");
}

function applyTransportState(nextState) {
  state.transport = {
    playing: Boolean(nextState.playing),
    startServerTime: Number(nextState.startServerTime) || 0,
    position: Number(nextState.position) || 0,
  };

  setText(els.playbackStatus, state.transport.playing ? "läuft" : "pausiert", state.transport.playing ? "is-ok" : "");

  if (state.transport.playing) {
    if (state.audioBuffer) {
      scheduleAudioFromTransport(state.transport, true);
    }
    scheduleLeaderVideo(state.transport);
    startDriftLoop();
  } else {
    state.lastKnownPosition = state.transport.position;
    stopAudio();
    pauseLeaderVideo(state.transport.position);
    stopDriftLoop();
  }
}

function scheduleAudioFromTransport(transport, forceRestart = false) {
  if (!state.audioContext || !state.audioBuffer || !transport.playing) return;

  const targetPosition = clamp(getExpectedAudioPosition(), 0, state.audioBuffer.duration);
  const error = targetPosition - getAudioPosition();

  if (!forceRestart && state.source && Math.abs(error) <= SMALL_DRIFT_LIMIT_S) {
    adjustPlaybackRate(error);
    return;
  }

  stopAudio();

  const source = state.audioContext.createBufferSource();
  source.buffer = state.audioBuffer;
  source.connect(state.audioContext.destination);

  const startLocalPerformanceMs = transport.startServerTime - state.serverOffsetMs + getGlobalOffsetMs();
  const contextStart = performanceTimeToContextTime(startLocalPerformanceMs);
  const now = state.audioContext.currentTime;
  const startAt = contextStart > now ? contextStart : now + 0.03;
  const sourceOffset = contextStart > now ? transport.position : targetPosition;

  source.playbackRate.value = 1;
  source.start(startAt, clamp(sourceOffset, 0, state.audioBuffer.duration));

  state.source = source;
  state.sourceStartedAtContext = startAt;
  state.sourceOffset = clamp(sourceOffset, 0, state.audioBuffer.duration);
  state.lastKnownPosition = sourceOffset;

  source.onended = () => {
    if (state.source === source) {
      state.source = null;
    }
  };
}

function stopAudio() {
  if (!state.source) return;

  try {
    state.lastKnownPosition = getAudioPosition();
    state.source.stop();
  } catch {
    // Bereits gestoppte BufferSource ignorieren.
  }

  state.source.disconnect();
  state.source = null;
}

function getAudioPosition() {
  if (!state.source || !state.audioContext) {
    return state.lastKnownPosition;
  }

  const elapsed = Math.max(0, state.audioContext.currentTime - state.sourceStartedAtContext);
  return state.sourceOffset + elapsed * state.source.playbackRate.value;
}

function performanceTimeToContextTime(performanceTimeMs) {
  const ctx = state.audioContext;
  if (ctx.getOutputTimestamp) {
    const stamp = ctx.getOutputTimestamp();
    return stamp.contextTime + (performanceTimeMs - stamp.performanceTime) / 1000;
  }

  return ctx.currentTime + (performanceTimeMs - performance.now()) / 1000;
}

function startDriftLoop() {
  clearInterval(state.driftTimer);
  state.driftTimer = window.setInterval(correctDrift, DRIFT_INTERVAL_MS);
}

function stopDriftLoop() {
  clearInterval(state.driftTimer);
  if (state.source) {
    state.source.playbackRate.value = 1;
  }
}

function correctDrift() {
  if (!state.transport.playing) return;

  if (state.audioBuffer && state.source) {
    const target = getExpectedAudioPosition();
    const error = target - getAudioPosition();

    if (Math.abs(error) > SMALL_DRIFT_LIMIT_S) {
      scheduleAudioFromTransport(state.transport, true);
    } else {
      adjustPlaybackRate(error);
    }
  }

  if (isLeader && els.leaderVideo.src && !els.leaderVideo.paused) {
    const error = getExpectedPosition() - els.leaderVideo.currentTime;
    if (Math.abs(error) > 0.25) {
      els.leaderVideo.currentTime = clamp(getExpectedPosition(), 0, getLeaderDuration());
    }
  }
}

function adjustPlaybackRate(error) {
  if (!state.source) return;
  const adjustment = clamp(error * RATE_CORRECTION_GAIN, -MAX_RATE_ADJUSTMENT, MAX_RATE_ADJUSTMENT);
  state.source.playbackRate.value = 1 + adjustment;
}

function getExpectedPosition() {
  if (!state.transport.playing) {
    return state.transport.position;
  }
  return Math.max(0, state.transport.position + (getServerNowMs() - state.transport.startServerTime) / 1000);
}

function getExpectedAudioPosition() {
  if (!state.transport.playing) {
    return state.transport.position;
  }

  const audioElapsedMs = getServerNowMs() - state.transport.startServerTime - getGlobalOffsetMs();
  return Math.max(0, state.transport.position + audioElapsedMs / 1000);
}

function getServerNowMs() {
  return performance.now() + state.serverOffsetMs;
}

function getGlobalOffsetMs() {
  return Number(els.offsetSlider.value) || 0;
}

function leaderPlay() {
  if (!isLeader) return;
  const position = getLeaderPosition();
  const startServerTime = getServerNowMs() + START_DELAY_MS;
  send({ type: "control", action: "play", position, startServerTime });
}

function leaderPause() {
  if (!isLeader) return;
  send({ type: "control", action: "pause", position: getLeaderPosition() });
}

function leaderSeek(position) {
  if (!isLeader) return;
  send({ type: "control", action: "seek", position });
}

function loadLeaderVideo() {
  const file = els.videoFileInput.files?.[0];
  if (!file) return;

  if (els.leaderVideo.dataset.blobUrl) {
    URL.revokeObjectURL(els.leaderVideo.dataset.blobUrl);
  }

  const blobUrl = URL.createObjectURL(file);
  els.leaderVideo.dataset.blobUrl = blobUrl;
  els.leaderVideo.src = blobUrl;
  els.leaderVideo.muted = true;

  els.leaderVideo.addEventListener("loadedmetadata", () => {
    els.seekSlider.max = String(getLeaderDuration());
    els.seekSlider.disabled = false;
  }, { once: true });
}

function scheduleLeaderVideo(transport) {
  if (!isLeader || !els.leaderVideo.src) return;

  const position = clamp(getExpectedPosition(), 0, getLeaderDuration());
  const delayMs = Math.max(0, transport.startServerTime - getServerNowMs());
  els.leaderVideo.currentTime = position;
  els.leaderVideo.muted = true;

  window.setTimeout(() => {
    if (!state.transport.playing) return;
    els.leaderVideo.play().catch((error) => {
      console.warn("Video konnte nicht automatisch starten:", error);
    });
  }, delayMs);
}

function pauseLeaderVideo(position) {
  if (!isLeader || !els.leaderVideo.src) return;
  els.leaderVideo.pause();
  els.leaderVideo.currentTime = clamp(position, 0, getLeaderDuration());
}

function getLeaderPosition() {
  if (isLeader && els.leaderVideo.src) {
    return els.leaderVideo.currentTime || 0;
  }
  return getExpectedPosition();
}

function getLeaderDuration() {
  return Number.isFinite(els.leaderVideo.duration) ? els.leaderVideo.duration : 0;
}

function startSeekUiLoop() {
  clearInterval(state.seekUiTimer);
  state.seekUiTimer = window.setInterval(() => {
    const position = isLeader && els.leaderVideo.src ? els.leaderVideo.currentTime : getExpectedPosition();
    els.seekSlider.value = String(position || 0);
    els.seekValue.textContent = formatTime(position || 0);
  }, 500);
}

function setText(element, text, className = "") {
  element.textContent = text;
  element.classList.remove("is-ok", "is-bad");
  if (className) element.classList.add(className);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function randomId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
