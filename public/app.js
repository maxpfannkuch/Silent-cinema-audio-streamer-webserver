"use strict";

// Render-WebSocket-URL nach dem Deploy hier eintragen.
const SYNC_SERVER_URL = "wss://silent-cinema-audio-streamer-webserver.onrender.com";

const AUDIO_URL = "Bohemian_Rhapsody.m4a";
const START_DELAY_MS = 3000;
const SYNC_SAMPLE_COUNT = 20;
const RESYNC_INTERVAL_MS = 10000;
const DRIFT_INTERVAL_MS = 2000;
const WEB_AUDIO_RESCHEDULE_LIMIT_S = 1.2;
const MEDIA_SEEK_LIMIT_S = 0.35;
const MEDIA_RATE_LIMIT_S = 0.12;
const WEB_AUDIO_RATE_CORRECTION_GAIN = 0.025;
const MAX_WEB_AUDIO_RATE_ADJUSTMENT = 0.002;

const params = new URLSearchParams(window.location.search);
const isLeader = params.get("role") === "leader";
const prefersMediaAudio = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const els = {
  pageTitle: document.getElementById("pageTitle"),
  roleLabel: document.getElementById("roleLabel"),
  joinButton: document.getElementById("joinButton"),
  joinButtonText: document.getElementById("joinButtonText"),
  joinSpinner: document.getElementById("joinSpinner"),
  connectionStatus: document.getElementById("connectionStatus"),
  audioStatus: document.getElementById("audioStatus"),
  syncStatus: document.getElementById("syncStatus"),
  playbackStatus: document.getElementById("playbackStatus"),
  offsetLabel: document.getElementById("offsetLabel"),
  offsetHint: document.getElementById("offsetHint"),
  offsetLockButton: document.getElementById("offsetLockButton"),
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
  audioMode: null,
  audioElement: null,
  audioStartTimer: 0,
  source: null,
  sourceStartedAtContext: 0,
  sourceOffset: 0,
  sourceStartedAtPerformance: 0,
  sourceRate: 1,
  sourceRateSetAtPerformance: 0,
  sourcePositionAtRateSet: 0,
  lastKnownPosition: 0,
  globalOffsetMs: 0,
  localFineOffsetMs: 0,
  offsetUnlocked: isLeader,
  serverOffsetMs: 0,
  bestSyncDeltaMs: Infinity,
  wakeLock: null,
  transport: { playing: false, startServerTime: 0, position: 0 },
  lastTransportKey: "",
  syncRequests: new Map(),
  reconnectTimer: 0,
  driftTimer: 0,
  resyncTimer: 0,
  seekUiTimer: 0,
  transportGeneration: 0,
  loadStartedAt: 0,
};

init();

function init() {
  if (isLeader) {
    els.pageTitle.textContent = "Film leiten";
    els.roleLabel.textContent = "Leiter";
    els.leaderPanel.hidden = false;
    els.offsetLabel.textContent = "Globaler Audio-Offset";
    els.offsetHint.textContent = "Dieser Wert wird an alle verbundenen Geräte verteilt. Positiv startet den Handy-Ton später, negativ früher.";
    els.offsetLockButton.hidden = true;
  } else {
    els.offsetSlider.disabled = true;
    els.offsetHint.textContent = "Der globale Offset kommt vom Leiter. Für einen lokalen Feinabgleich Schloss drücken.";
  }

  els.offsetSlider.addEventListener("input", () => {
    if (isLeader) {
      state.globalOffsetMs = Number(els.offsetSlider.value) || 0;
      send({ type: "control", action: "offset", globalOffsetMs: state.globalOffsetMs });
    } else if (state.offsetUnlocked) {
      state.localFineOffsetMs = Number(els.offsetSlider.value) || 0;
    }
    updateOffsetUi();
    if (state.transport.playing && state.audioBuffer) {
      scheduleAudioFromTransport(state.transport, true);
    }
  });

  els.offsetLockButton.addEventListener("click", toggleOffsetLock);
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
  updateOffsetUi();
}

async function join() {
  els.joinButton.disabled = true;
  setJoinLoading(true);
  setText(els.audioStatus, "Audio wird vorbereitet");
  state.loadStartedAt = performance.now();

  try {
    if (!prefersMediaAudio) {
      state.audioContext = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
      await state.audioContext.resume();
    }
    await requestWakeLock();
    await loadAudioBuffer();

    state.joined = true;
    setJoinLoading(false, "Tonspur bereit");
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
    setJoinLoading(false, "Erneut versuchen");
    setText(els.audioStatus, getAudioErrorText(error), "is-bad");
    alert(getAudioErrorHelp(error));
  }
}

async function loadAudioBuffer() {
  if (state.audioBuffer || state.audioElement) return;

  if (prefersMediaAudio) {
    await loadMediaAudio();
    return;
  }

  const response = await fetch(AUDIO_URL, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Audio fetch failed: ${response.status}`);
  }

  const data = await response.arrayBuffer();
  if (data.byteLength > 150 * 1024 * 1024) {
    console.warn("Große Audiodatei. Für iOS besser Stereo-AAC mit ca. 160 kbit/s verwenden.");
  }
  try {
    state.audioBuffer = await state.audioContext.decodeAudioData(data);
    state.audioMode = "web-audio";
  } catch (error) {
    console.warn("Web Audio decode fehlgeschlagen, nutze HTML-Audio-Fallback:", error);
    await loadMediaAudio();
  }
}

async function loadMediaAudio() {
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = AUDIO_URL;
  audio.playsInline = true;
  audio.crossOrigin = "anonymous";

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      audio.removeEventListener("canplaythrough", resolveReady);
      audio.removeEventListener("loadedmetadata", resolveReady);
      audio.removeEventListener("error", rejectReady);
    };
    const resolveReady = () => {
      cleanup();
      resolve();
    };
    const rejectReady = () => {
      cleanup();
      reject(new Error("HTML audio could not load"));
    };

    audio.addEventListener("canplaythrough", resolveReady, { once: true });
    audio.addEventListener("loadedmetadata", resolveReady, { once: true });
    audio.addEventListener("error", rejectReady, { once: true });
    audio.load();
  });

  // iOS braucht auch fuer HTMLAudio eine echte Nutzergeste. Kurz stumm starten und wieder pausieren.
  const previousVolume = audio.volume;
  audio.volume = 0;
  try {
    await audio.play();
    audio.pause();
    audio.currentTime = 0;
  } catch (error) {
    console.warn("HTML-Audio konnte noch nicht vorgestartet werden:", error);
  } finally {
    audio.volume = previousVolume;
  }

  state.audioElement = audio;
  state.audioMode = "media";
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
  const previousOffset = state.globalOffsetMs;
  const nextTransport = {
    playing: Boolean(nextState.playing),
    startServerTime: Number(nextState.startServerTime) || 0,
    position: Number(nextState.position) || 0,
  };
  const nextOffset = Number(nextState.globalOffsetMs) || 0;
  const nextTransportKey = `${nextTransport.playing}:${nextTransport.startServerTime}:${nextTransport.position}`;
  const transportChanged = nextTransportKey !== state.lastTransportKey;

  if (transportChanged) {
    state.transportGeneration += 1;
    state.lastTransportKey = nextTransportKey;
  }

  const offsetChanged = nextOffset !== previousOffset;
  state.transport = {
    ...nextTransport,
  };
  state.globalOffsetMs = nextOffset;
  updateOffsetUi();

  setText(els.playbackStatus, state.transport.playing ? "läuft" : "pausiert", state.transport.playing ? "is-ok" : "");

  if (state.transport.playing && transportChanged) {
    if (hasAudioReady()) {
      scheduleAudioFromTransport(state.transport, true);
    }
    scheduleLeaderVideo(state.transport);
    startDriftLoop();
  } else if (!state.transport.playing && transportChanged) {
    state.lastKnownPosition = state.transport.position;
    stopAudio();
    pauseLeaderVideo(state.transport.position);
    stopDriftLoop();
  } else if (state.transport.playing && offsetChanged) {
    correctDrift();
  }
}

function scheduleAudioFromTransport(transport, forceRestart = false) {
  if (!hasAudioReady() || !transport.playing) return;
  if (state.audioMode === "media") {
    scheduleMediaAudioFromTransport(transport, forceRestart);
    return;
  }
  if (!state.audioContext || !state.audioBuffer) return;
  const generation = state.transportGeneration;

  const targetPosition = clamp(getExpectedAudioPosition(), 0, state.audioBuffer.duration);
  const error = targetPosition - getAudioPosition();

  if (!forceRestart && state.source && Math.abs(error) <= WEB_AUDIO_RESCHEDULE_LIMIT_S) {
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
  state.sourceStartedAtPerformance = performance.now() + Math.max(0, (startAt - now) * 1000);
  state.sourceOffset = clamp(sourceOffset, 0, state.audioBuffer.duration);
  state.sourceRate = 1;
  state.sourceRateSetAtPerformance = state.sourceStartedAtPerformance;
  state.sourcePositionAtRateSet = state.sourceOffset;
  state.lastKnownPosition = sourceOffset;

  source.onended = () => {
    if (state.source === source && state.transportGeneration === generation) {
      state.source = null;
    }
  };
}

function stopAudio() {
  clearTimeout(state.audioStartTimer);
  state.audioStartTimer = 0;

  if (state.audioElement) {
    state.lastKnownPosition = getAudioPosition();
    state.audioElement.pause();
    state.audioElement.playbackRate = 1;
  }

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
  if (state.audioMode === "media" && state.audioElement) {
    return state.audioElement.currentTime || state.lastKnownPosition;
  }

  if (!state.source || !state.audioContext) {
    return state.lastKnownPosition;
  }

  const elapsed = Math.max(0, (performance.now() - state.sourceRateSetAtPerformance) / 1000);
  return state.sourcePositionAtRateSet + elapsed * state.sourceRate;
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

  if (state.audioMode === "media" && state.audioElement && !state.audioElement.paused) {
    const target = getExpectedAudioPosition();
    const error = target - getAudioPosition();

    if (Math.abs(error) > MEDIA_SEEK_LIMIT_S) {
      state.audioElement.currentTime = clamp(target, 0, getAudioDuration());
      state.audioElement.playbackRate = 1;
    } else if (Math.abs(error) > MEDIA_RATE_LIMIT_S) {
      state.audioElement.playbackRate = error > 0 ? 1.002 : 0.998;
    } else {
      state.audioElement.playbackRate = 1;
    }
  } else if (state.audioBuffer && state.source) {
    const target = getExpectedAudioPosition();
    const error = target - getAudioPosition();

    if (Math.abs(error) > WEB_AUDIO_RESCHEDULE_LIMIT_S) {
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
  state.sourcePositionAtRateSet = getAudioPosition();
  state.sourceRateSetAtPerformance = performance.now();
  const adjustment = clamp(error * WEB_AUDIO_RATE_CORRECTION_GAIN, -MAX_WEB_AUDIO_RATE_ADJUSTMENT, MAX_WEB_AUDIO_RATE_ADJUSTMENT);
  state.sourceRate = 1 + adjustment;
  state.source.playbackRate.value = state.sourceRate;
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
  return state.globalOffsetMs + state.localFineOffsetMs;
}

function scheduleMediaAudioFromTransport(transport, forceRestart = false) {
  const audio = state.audioElement;
  if (!audio) return;

  if (!forceRestart && !audio.paused) {
    correctDrift();
    return;
  }

  clearTimeout(state.audioStartTimer);
  const generation = state.transportGeneration;
  const targetPosition = clamp(getExpectedAudioPosition(), 0, getAudioDuration());
  const startLocalPerformanceMs = transport.startServerTime - state.serverOffsetMs + getGlobalOffsetMs();
  const delayMs = startLocalPerformanceMs - performance.now();

  audio.pause();
  audio.playbackRate = 1;

  if (delayMs > 30) {
    audio.currentTime = clamp(transport.position, 0, getAudioDuration());
    state.lastKnownPosition = audio.currentTime;
    state.audioStartTimer = window.setTimeout(() => {
      if (!state.transport.playing || state.transportGeneration !== generation) return;
      audio.play().catch((error) => {
        console.warn("Audio konnte nicht starten:", error);
        setText(els.audioStatus, "Start blockiert", "is-bad");
      });
    }, delayMs);
  } else {
    audio.currentTime = targetPosition;
    state.lastKnownPosition = targetPosition;
    audio.play().catch((error) => {
      console.warn("Audio konnte nicht starten:", error);
      setText(els.audioStatus, "Start blockiert", "is-bad");
    });
  }
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

  const generation = state.transportGeneration;
  const position = clamp(getExpectedPosition(), 0, getLeaderDuration());
  const delayMs = Math.max(0, transport.startServerTime - getServerNowMs());
  els.leaderVideo.currentTime = position;
  els.leaderVideo.muted = true;

  window.setTimeout(() => {
    if (!state.transport.playing || state.transportGeneration !== generation) return;
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

function getAudioDuration() {
  if (state.audioBuffer) return state.audioBuffer.duration;
  if (state.audioElement && Number.isFinite(state.audioElement.duration)) return state.audioElement.duration;
  return 0;
}

function hasAudioReady() {
  return Boolean(state.audioBuffer || state.audioElement);
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

function setJoinLoading(isLoading, text) {
  els.joinButton.classList.toggle("is-loading", isLoading);
  els.joinSpinner.hidden = !isLoading;
  if (text) {
    els.joinButtonText.textContent = text;
  } else if (isLoading) {
    els.joinButtonText.textContent = "Ton wird vorbereitet";
  }
}

function toggleOffsetLock() {
  if (isLeader) return;

  state.offsetUnlocked = !state.offsetUnlocked;
  if (!state.offsetUnlocked) {
    state.localFineOffsetMs = 0;
  }
  updateOffsetUi();

  if (state.transport.playing && state.audioBuffer) {
    scheduleAudioFromTransport(state.transport, true);
  } else if (state.transport.playing && state.audioElement) {
    correctDrift();
  }
}

function updateOffsetUi() {
  if (isLeader) {
    els.offsetSlider.disabled = false;
    els.offsetSlider.value = String(state.globalOffsetMs);
    els.offsetValue.textContent = `${state.globalOffsetMs} ms`;
    return;
  }

  els.offsetSlider.disabled = !state.offsetUnlocked;
  els.offsetLockButton.textContent = state.offsetUnlocked ? "🔓" : "🔒";
  els.offsetLockButton.setAttribute("aria-label", state.offsetUnlocked ? "Offset sperren" : "Offset entsperren");
  els.offsetLockButton.title = state.offsetUnlocked ? "Offset sperren" : "Offset entsperren";

  if (state.offsetUnlocked) {
    els.offsetSlider.value = String(state.localFineOffsetMs);
    els.offsetValue.textContent = `lokal ${formatSignedMs(state.localFineOffsetMs)} / gesamt ${formatSignedMs(getGlobalOffsetMs())}`;
    els.offsetHint.textContent = "Lokaler Feinabgleich ist aktiv. Er gilt nur auf diesem Gerät.";
  } else {
    els.offsetSlider.value = String(state.globalOffsetMs);
    els.offsetValue.textContent = `Leiter ${formatSignedMs(state.globalOffsetMs)}`;
    els.offsetHint.textContent = "Der globale Offset kommt vom Leiter. Für einen lokalen Feinabgleich Schloss drücken.";
  }
}

function getAudioErrorText(error) {
  if (String(error?.message || "").includes("Audio fetch failed")) {
    return "Datei nicht erreichbar";
  }
  return "Fehler beim Laden";
}

function getAudioErrorHelp(error) {
  const detail = error?.message ? `\n\nTechnik: ${error.message}` : "";
  return `Die Tonspur konnte nicht geladen werden. Auf iOS klappt es am zuverlässigsten mit Stereo-AAC (.m4a, 48 kHz, ca. 160 kbit/s). Bitte Website-Daten fuer audio.maxpfannkuch.de löschen und danach neu beitreten.${detail}`;
}

function formatSignedMs(value) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded} ms`;
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
