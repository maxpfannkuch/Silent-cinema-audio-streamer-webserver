"use strict";

// ── Server configuration ────────────────────────────────────────────────────
// WebSocket sync server (Render). Change if you move to a different host.
const SYNC_SERVER_URL = "wss://silent-cinema-audio-streamer-webserver.onrender.com";
// Same server, HTTP base URL (for audio download and upload).
const SERVER_HTTP_URL = "https://silent-cinema-audio-streamer-webserver.onrender.com";
// ───────────────────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const isLeader = params.get("role") === "leader";

// Audio URL: relative by default (served from static host), switches to Render after upload.
let AUDIO_URL = "./Bohemian_Rhapsody.m4a";
let audioUrlIsRemote = false;

const prefersMediaAudio = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const START_DELAY_MS = 3000;
const SYNC_SAMPLE_COUNT = 25;
const RESYNC_INTERVAL_MS = 8000;
// iOS media-audio drift check interval (Web Audio needs no drift loop — clock is hardware-stable)
const DRIFT_INTERVAL_MS = 20000;
// Web Audio: only hard-reschedule if badly out of sync (e.g. after a mid-stream join with bad estimate)
const WEB_AUDIO_RESCHEDULE_LIMIT_S = 15.0;
// iOS: seek to correct position only when seriously off; never adjust playbackRate (changes pitch)
const MEDIA_SEEK_LIMIT_S = 2.0;

// ── Token gate ──────────────────────────────────────────────────────────────
// Show a token-entry screen when neither ?token nor ?role is in the URL.
// Gate is hidden via CSS (#tokenGate { display: none }) — JS adds .is-visible to show it.
const showGate = !token && !params.has("role");

const tokenGateEl = document.getElementById("tokenGate");
const tokenInputEl = document.getElementById("tokenInput");
const tokenSubmitBtnEl = document.getElementById("tokenSubmitBtn");

// Pre-select the last used role so the leader doesn't have to switch every time.
const savedRole = localStorage.getItem("silentCinemaRole") || "listener";
const savedRadio = document.querySelector(`input[name="gateRole"][value="${savedRole}"]`);
if (savedRadio) savedRadio.checked = true;

if (showGate) tokenGateEl.classList.add("is-visible");

tokenSubmitBtnEl.addEventListener("click", submitTokenGate);
tokenInputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") submitTokenGate(); });

function submitTokenGate() {
  const entered = tokenInputEl.value.trim();
  const role = document.querySelector('input[name="gateRole"]:checked')?.value || "listener";
  localStorage.setItem("silentCinemaRole", role); // remember for next time
  const p = new URLSearchParams();
  p.set("role", role);
  if (entered) p.set("token", entered);
  location.replace(location.pathname + "?" + p.toString());
}

// "Rolle wechseln" button — strips URL params so the gate appears again.
document.getElementById("switchRoleBtn")?.addEventListener("click", () => {
  location.href = location.pathname;
});
// ───────────────────────────────────────────────────────────────────────────

const els = {
  pageTitle: document.getElementById("pageTitle"),
  roleLabel: document.getElementById("roleLabel"),
  joinButton: document.getElementById("joinButton"),
  joinButtonText: document.getElementById("joinButtonText"),
  joinSpinner: document.getElementById("joinSpinner"),
  joinHint: document.getElementById("joinHint"),
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
  audioFileInput: document.getElementById("audioFileInput"),
  uploadProgressBox: document.getElementById("uploadProgressBox"),
  uploadProgressFill: document.getElementById("uploadProgressFill"),
  uploadStatus: document.getElementById("uploadStatus"),
  inviteSection: document.getElementById("inviteSection"),
  inviteLink: document.getElementById("inviteLink"),
  copyInviteBtn: document.getElementById("copyInviteBtn"),
  videoFileInput: document.getElementById("videoFileInput"),
  leaderVideo: document.getElementById("leaderVideo"),
  playPauseButton: document.getElementById("playPauseButton"),
  seekSlider: document.getElementById("seekSlider"),
  seekValue: document.getElementById("seekValue"),
  syncSignalBtn: document.getElementById("syncSignalBtn"),
  syncFlash: document.getElementById("syncFlash"),
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
    els.joinButtonText.textContent = "Verbinden";
    els.joinHint.textContent = "Als Leiter musst du keine Tonspur laden. Tippe hier, um dich mit dem Sync-Server zu verbinden.";

    // Invite link
    if (token) {
      const listenerUrl = `${location.origin}${location.pathname}?role=listener&token=${encodeURIComponent(token)}`;
      els.inviteLink.textContent = listenerUrl;
      els.inviteSection.hidden = false;
      els.copyInviteBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(listenerUrl).then(() => {
          els.copyInviteBtn.textContent = "Kopiert ✓";
          setTimeout(() => { els.copyInviteBtn.textContent = "Link kopieren"; }, 2500);
        }).catch(() => {
          // Fallback for older browsers / no HTTPS
          prompt("Link kopieren:", listenerUrl);
        });
      });
    }
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
    if (state.transport.playing && hasAudioReady()) {
      scheduleAudioFromTransport(state.transport, true);
    }
  });

  els.offsetLockButton.addEventListener("click", toggleOffsetLock);
  els.joinButton.addEventListener("click", join);
  els.audioFileInput.addEventListener("change", () => {
    const file = els.audioFileInput.files?.[0];
    if (file) processAndUpload(file);
  });
  setupUploadZone();
  els.videoFileInput.addEventListener("change", loadLeaderVideo);
  els.playPauseButton.addEventListener("click", () => {
    if (state.ws?.readyState !== WebSocket.OPEN) {
      setText(els.connectionStatus, "Verbindung herstellen…", "is-bad");
      return;
    }
    if (state.transport.playing) {
      leaderPause();
    } else {
      leaderPlay();
    }
  });
  els.syncSignalBtn?.addEventListener("click", () => {
    if (state.ws?.readyState !== WebSocket.OPEN) return;
    // Create + resume AudioContext inside the user gesture so iOS allows audio later.
    if (!state.audioContext) {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (state.audioContext.state === "suspended") state.audioContext.resume();
    send({ type: "sync-signal" });
  });

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
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  connect();
  startSeekUiLoop();
  updateOffsetUi();
}

async function join() {
  els.joinButton.disabled = true;
  setJoinLoading(true);
  state.loadStartedAt = performance.now();

  try {
    await requestWakeLock();

    if (isLeader) {
      setText(els.audioStatus, "nicht nötig", "is-ok");
    } else {
      setText(els.audioStatus, "Audio wird vorbereitet");
      if (!prefersMediaAudio) {
        state.audioContext = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
        await state.audioContext.resume();
      }
      await loadAudioBuffer();
      setText(els.audioStatus, "bereit", "is-ok");
    }

    state.joined = true;
    setJoinLoading(false, isLeader ? "Verbunden" : "Tonspur bereit");

    if (state.ws?.readyState === WebSocket.OPEN) {
      send({ type: "hello", role: isLeader ? "leader" : "listener", clientId: state.clientId });
      runInitialSync();
    }

    if (!isLeader && state.transport.playing) {
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

  const response = await fetch(AUDIO_URL, {
    cache: audioUrlIsRemote ? "no-cache" : "force-cache",
  });
  if (!response.ok) {
    throw new Error(`Audio fetch failed: ${response.status}`);
  }

  const data = await response.arrayBuffer();
  try {
    state.audioBuffer = await state.audioContext.decodeAudioData(data);
    state.audioMode = "web-audio";
  } catch (error) {
    console.warn("Web Audio decode fehlgeschlagen, nutze HTML-Audio-Fallback:", error);
    await loadMediaAudio();
  }
}

async function reloadAudio() {
  state.audioBuffer = null;
  state.audioElement = null;
  state.audioMode = null;
  stopAudio();
  setText(els.audioStatus, "Neue Tonspur wird geladen...");
  try {
    await loadAudioBuffer();
    setText(els.audioStatus, "bereit", "is-ok");
    if (state.transport.playing) {
      scheduleAudioFromTransport(state.transport, true);
    }
  } catch (error) {
    setText(els.audioStatus, "Fehler beim Laden", "is-bad");
  }
}

function setupUploadZone() {
  const zone = document.getElementById("uploadZone");
  if (!zone) return;

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", (e) => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove("drag-over");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const file = e.dataTransfer?.files?.[0];
    if (file) processAndUpload(file);
  });
}

function processAndUpload(file) {
  const zone = document.getElementById("uploadZone");
  const nameEl = document.getElementById("uploadFileName");
  if (zone) zone.classList.add("has-file");
  if (nameEl) {
    nameEl.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  }
  uploadAudioFile(file);
}

async function uploadAudioFile(file) {
  const url = `${SERVER_HTTP_URL}/upload${token ? `?token=${encodeURIComponent(token)}` : ""}`;

  els.uploadProgressBox.hidden = false;
  els.uploadProgressFill.style.width = "0%";
  setUploadStatus("Verbinde mit Server…", "");

  // If WebSocket is open the server is already awake — no ping needed.
  // Otherwise wake Render (free tier sleeps after 15 min). Use no-cors so the
  // missing CORS headers on /health don't cause a false "not reachable" error.
  if (state.ws?.readyState !== WebSocket.OPEN) {
    try {
      const ctrl = new AbortController();
      const wakeTimeout = setTimeout(() => ctrl.abort(), 55000);
      await fetch(`${SERVER_HTTP_URL}/health`, { mode: "no-cors", cache: "no-store", signal: ctrl.signal });
      clearTimeout(wakeTimeout);
    } catch (err) {
      const msg = err.name === "AbortError"
        ? "Server antwortet nicht – bitte kurz warten und erneut versuchen."
        : "Server nicht erreichbar – zuerst auf „Verbinden" drücken.";
      setUploadStatus(msg, "is-bad");
      return;
    }
  }

  setUploadStatus("Wird hochgeladen… 0 %", "");

  const xhr = new XMLHttpRequest();

  xhr.upload.addEventListener("progress", (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      els.uploadProgressFill.style.width = `${pct}%`;
      setUploadStatus(`Wird hochgeladen… ${pct} %`, "");
    }
  });

  xhr.addEventListener("load", () => {
    if (xhr.status === 200) {
      try {
        const data = JSON.parse(xhr.responseText);
        const mb = (data.bytes / 1024 / 1024).toFixed(1);
        els.uploadProgressFill.style.width = "100%";
        setUploadStatus(`✓ Hochgeladen (${mb} MB) – Zuhörer werden automatisch benachrichtigt`, "is-ok");
      } catch {
        setUploadStatus("✓ Hochgeladen", "is-ok");
      }
    } else {
      setUploadStatus(`Fehler ${xhr.status}: ${xhr.responseText || xhr.statusText}`, "is-bad");
    }
  });

  xhr.addEventListener("error", () => {
    setUploadStatus("Netzwerkfehler beim Hochladen", "is-bad");
  });

  xhr.open("POST", url);
  xhr.setRequestHeader("Content-Type", file.type || "audio/mpeg");
  xhr.send(file);
}

function setUploadStatus(text, className) {
  els.uploadStatus.textContent = text;
  els.uploadStatus.className = `upload-status${className ? ` ${className}` : ""}`;
}

async function loadMediaAudio() {
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = AUDIO_URL;
  audio.playsInline = true;
  // Only use crossOrigin for remote URLs — Safari refuses same-origin audio with this flag
  // unless the static host sends CORS headers (Strato doesn't by default).
  if (audioUrlIsRemote) audio.crossOrigin = "anonymous";

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      audio.removeEventListener("canplaythrough", resolveReady);
      audio.removeEventListener("loadedmetadata", resolveReady);
      audio.removeEventListener("error", rejectReady);
    };
    const resolveReady = () => { cleanup(); resolve(); };
    const rejectReady = () => { cleanup(); reject(new Error("HTML audio could not load")); };

    audio.addEventListener("canplaythrough", resolveReady, { once: true });
    audio.addEventListener("loadedmetadata", resolveReady, { once: true });
    audio.addEventListener("error", rejectReady, { once: true });
    audio.load();
  });

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
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch (error) {
    console.warn("Wake Lock nicht verfügbar:", error);
  }
}

function connect() {
  clearTimeout(state.reconnectTimer);
  setText(els.connectionStatus, "verbindet");

  const wsUrl = token ? `${SYNC_SERVER_URL}?token=${encodeURIComponent(token)}` : SYNC_SERVER_URL;
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.addEventListener("open", () => {
    setText(els.connectionStatus, "verbunden", "is-ok");
    state.bestSyncDeltaMs = Infinity;
    send({ type: "hello", role: isLeader ? "leader" : "listener", clientId: state.clientId });
    runInitialSync();
  });

  ws.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handleMessage(message);
  });

  ws.addEventListener("close", (event) => {
    setText(els.connectionStatus, "getrennt", "is-bad");
    clearInterval(state.resyncTimer);
    if (event.code === 4001) {
      setText(els.connectionStatus, "Kein Zugriff – falscher Token", "is-bad");
      return;
    }
    state.reconnectTimer = window.setTimeout(connect, 2000);
  });

  ws.addEventListener("error", () => {
    setText(els.connectionStatus, "Fehler", "is-bad");
  });
}

function handleMessage(message) {
  if (message.type === "pong") { handlePong(message); return; }

  if (message.type === "state") { applyTransportState(message.state); return; }

  if (message.type === "clients") {
    els.clientCount.textContent = String(message.count);
    return;
  }

  if (message.type === "audio-updated") {
    if (state.joined && !isLeader) {
      // Switch to Render's /audio endpoint for the freshly uploaded file.
      AUDIO_URL = `${SERVER_HTTP_URL}/audio${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      audioUrlIsRemote = true;
      reloadAudio();
    }
  }

  if (message.type === "sync-signal") {
    // Schedule beep + flash at the given server time
    const localMs = message.serverTime - state.serverOffsetMs;
    const delayMs = localMs - performance.now();
    if (delayMs >= 0 && delayMs < 10000) {
      setTimeout(() => { playBeep(); flashScreen(); }, delayMs);
    } else {
      // Server time already passed or too far in future — fire immediately
      playBeep();
      flashScreen();
    }
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
  const theta = ((message.t1 - t0) + (message.t2 - t3)) / 2;
  const delta = (t3 - t0) - (message.t2 - message.t1);

  if (delta < state.bestSyncDeltaMs) {
    state.bestSyncDeltaMs = delta;
    state.serverOffsetMs = theta;
  } else if (delta < state.bestSyncDeltaMs * 2) {
    // Slow EMA (5% weight) so jittery measurements don't jump the estimate
    state.serverOffsetMs = state.serverOffsetMs * 0.95 + theta * 0.05;
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
  state.transport = { ...nextTransport };
  state.globalOffsetMs = nextOffset;
  updateOffsetUi();

  setText(els.playbackStatus, state.transport.playing ? "läuft" : "pausiert", state.transport.playing ? "is-ok" : "");

  if (isLeader) {
    els.playPauseButton.textContent = state.transport.playing ? "Pause" : "Start";
    els.playPauseButton.classList.toggle("is-playing", state.transport.playing);
  }

  if (state.transport.playing && transportChanged) {
    if (hasAudioReady()) scheduleAudioFromTransport(state.transport, true);
    scheduleLeaderVideo(state.transport);
    startDriftLoop();
  } else if (!state.transport.playing && transportChanged) {
    state.lastKnownPosition = state.transport.position;
    stopAudio();
    pauseLeaderVideo(state.transport.position);
    stopDriftLoop();
  } else if (state.transport.playing && offsetChanged) {
    if (hasAudioReady()) scheduleAudioFromTransport(state.transport, true);
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

  // If audio is already running and we're not forcing a restart, leave it undisturbed.
  // The AudioContext clock runs on a hardware thread and doesn't drift.
  if (!forceRestart && state.source) return;

  const targetPosition = clamp(getExpectedAudioPosition(), 0, state.audioBuffer.duration);

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
  } catch { /* already stopped */ }

  state.source.disconnect();
  state.source = null;
}

function getAudioPosition() {
  if (state.audioMode === "media" && state.audioElement) {
    return state.audioElement.currentTime || state.lastKnownPosition;
  }
  if (!state.source || !state.audioContext) return state.lastKnownPosition;

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
  // Run correction loop if iOS media audio needs it, or leader needs video sync.
  // Web Audio clock is hardware-stable — no correction needed there.
  if (state.audioMode === "media" || isLeader) {
    state.driftTimer = window.setInterval(correctDrift, DRIFT_INTERVAL_MS);
  }
}

function stopDriftLoop() {
  clearInterval(state.driftTimer);
}

function correctDrift() {
  if (!state.transport.playing) return;

  // iOS media audio: seek to correct position when seriously off.
  // We deliberately never adjust playbackRate — it changes pitch on AudioBufferSourceNode
  // and causes distortion on HTMLAudioElement even with pitch-correction algorithms.
  if (state.audioMode === "media" && state.audioElement && !state.audioElement.paused) {
    const target = getExpectedAudioPosition();
    const error = target - getAudioPosition();
    if (Math.abs(error) > MEDIA_SEEK_LIMIT_S) {
      state.audioElement.currentTime = clamp(target, 0, getAudioDuration());
    }
  }

  // Leader video sync
  if (isLeader && els.leaderVideo.src && !els.leaderVideo.paused) {
    const error = getExpectedPosition() - els.leaderVideo.currentTime;
    if (Math.abs(error) > 0.25) {
      els.leaderVideo.currentTime = clamp(getExpectedPosition(), 0, getLeaderDuration());
    }
  }
}


function getExpectedPosition() {
  if (!state.transport.playing) return state.transport.position;
  return Math.max(0, state.transport.position + (getServerNowMs() - state.transport.startServerTime) / 1000);
}

function getExpectedAudioPosition() {
  if (!state.transport.playing) return state.transport.position;
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
  if (!forceRestart && !audio.paused) { correctDrift(); return; }

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
  if (isLeader && els.leaderVideo.src) return els.leaderVideo.currentTime || 0;
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
    els.joinButtonText.textContent = isLeader ? "Verbindet…" : "Ton wird vorbereitet";
  }
}

function toggleOffsetLock() {
  if (isLeader) return;
  state.offsetUnlocked = !state.offsetUnlocked;
  if (!state.offsetUnlocked) state.localFineOffsetMs = 0;
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
  if (String(error?.message || "").includes("Audio fetch failed")) return "Datei nicht erreichbar";
  return "Fehler beim Laden";
}

function getAudioErrorHelp(error) {
  const detail = error?.message ? `\n\nTechnik: ${error.message}` : "";
  return `Die Tonspur konnte nicht geladen werden. Auf iOS klappt es am zuverlässigsten mit Stereo-AAC (.m4a, 48 kHz, ca. 160 kbit/s).${detail}`;
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
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ── Sync signal: beep + screen flash ─────────────────────────────────────────
// Used to calibrate audio offset: all devices fire simultaneously.
// Listeners adjust the offset slider until the beep and the visual cue on the
// projector screen (the leader's video) appear simultaneous.
function playBeep() {
  try {
    const ctx = state.audioContext
      || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880; // A5 — clean, easy to hear through earphones
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.75, ctx.currentTime + 0.008);
    gain.gain.setValueAtTime(0.75, ctx.currentTime + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
  } catch (e) {
    console.warn("Sync beep failed:", e);
  }
}

function flashScreen() {
  if (!els.syncFlash) return;
  els.syncFlash.style.transition = "none";
  els.syncFlash.style.opacity = "1";
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      els.syncFlash.style.transition = "opacity 0.4s ease";
      els.syncFlash.style.opacity = "0";
    });
  });
}
