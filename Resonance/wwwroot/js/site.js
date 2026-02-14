/**
 * Resonance – Hume EVI WebSocket client & .NET Alignment Bridge
 *
 * Flow:
 *   1. Capture microphone audio via getUserMedia + AudioWorklet.
 *   2. Stream base64-encoded PCM frames to Hume EVI over WebSocket.
 *   3. On every `user_message` event extract prosody scores.
 *   4. POST scores to /Home/PivotLogic on the .NET backend.
 *   5. Send `session_settings` message back through the socket to inject
 *      the new system prompt returned by the Policy Engine.
 *   6. Play back Hume's audio_output responses through the speakers.
 */

// ── DOM refs ───────────────────────────────────────────────────────
const btnConnect     = document.getElementById("btnConnect");
const btnDisconnect  = document.getElementById("btnDisconnect");
const apiKeyInput    = document.getElementById("apiKey");
const configIdInput  = document.getElementById("configId");
const statusEl       = document.getElementById("connectionStatus");
const barConfusion   = document.getElementById("barConfusion");
const barDoubt       = document.getElementById("barDoubt");
const barFrustration = document.getElementById("barFrustration");
const valConfusion   = document.getElementById("valConfusion");
const valDoubt       = document.getElementById("valDoubt");
const valFrustration = document.getElementById("valFrustration");
const activeStrategy = document.getElementById("activeStrategy");
const activePrompt   = document.getElementById("activePrompt");
const eventLog       = document.getElementById("eventLog");

let socket = null;
let audioContext = null;
let micStream = null;
let mediaRecorder = null;   // MediaRecorder for WebM/Opus encoding
let analyserNode = null;    // AnalyserNode for real-time level monitoring
let levelMonitorId = null;  // requestAnimationFrame id for level polling
let audioQueue = [];
let isPlaying = false;
let playbackContext = null; // Separate AudioContext for assistant audio playback
let framesSent = 0;        // Total audio chunks sent to Hume
let speechActive = false;  // True while user speech is detected
let reconnectTimer = null;  // Auto-reconnect timer
let reconnectAttempts = 0;  // Limit auto-reconnect loops
let manualDisconnect = false;
let dashboardEvents = [];   // Collected emotion events for the analytics dashboard

// ── Google Meet integration state ──────────────────────────────────
let mixDestination = null;  // MediaStreamDestination for mixed mic+Meet audio
let meetStream = null;      // getDisplayMedia stream (Meet tab audio)
let meetSource = null;      // MediaStreamSourceNode for Meet audio
let meetAnalyser = null;    // AnalyserNode for Meet audio levels
let meetLevelMonitorId = null;
let meetActive = false;
let lastMicRms = 0;         // Latest mic RMS for speaker comparison
let lastMeetRms = 0;        // Latest Meet RMS for speaker comparison
let activeSpeaker = "local"; // "local" | "remote"

// ── Multi-speaker profiling ────────────────────────────────────────
// Tracks individual remote speakers by their average volume profile.
// A silence gap ≥1.5 s followed by speech at a different level = new speaker.
let remoteSpeakers = [];       // [{id, label, avgRms, turnCount, firstSeen}]
let currentRemoteSpeakerId = null;
let remoteSpeechActive = false;
let remoteSilenceStart = 0;    // timestamp (ms) when remote went silent
let segmentRmsAccum = 0;       // running RMS accumulator for current segment
let segmentRmsSamples = 0;     // sample count for current segment

// ── Helpers ────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toLocaleTimeString();
    const entry = document.createElement("div");
    entry.className = "entry";
    entry.innerHTML = `<span class="ts">${ts}</span>${msg}`;
    eventLog.prepend(entry);
}

function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = `status ${cls}`;
}

function updateBar(barEl, valEl, score) {
    const pct = Math.min(score * 100, 100);
    barEl.style.width = `${pct}%`;
    valEl.textContent = score.toFixed(2);
}

// ── Base64 utilities ───────────────────────────────────────────────
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

// ── Microphone capture ─────────────────────────────────────────────
// Hume EVI expects browser-encoded audio (WebM/Opus), NOT raw PCM.
// We use MediaRecorder for streaming + AnalyserNode for real-time level monitoring.
async function startMicrophone() {
    console.log("[Resonance] Requesting microphone access…");
    log("🎤 Requesting microphone access…");

    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: 48000,
                echoCancellation: true,
                noiseSuppression: true
            }
        });
        console.log("[Resonance] Microphone access granted.", micStream.getTracks());
        log("🎤 Microphone access granted.");
    } catch (err) {
        console.error("[Resonance] Microphone access denied:", err);
        log(`⚠ Microphone access denied: ${err.message}`);
        return false;
    }

    audioContext = new AudioContext({ sampleRate: 48000 });
    console.log("[Resonance] AudioContext created. sampleRate:", audioContext.sampleRate, "state:", audioContext.state);

    if (audioContext.state === "suspended") {
        await audioContext.resume();
        console.log("[Resonance] AudioContext resumed.");
    }

    // ── Real-time level monitoring via AnalyserNode ──
    const source = audioContext.createMediaStreamSource(micStream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    source.connect(analyserNode);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    analyserNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    // ── Mix destination (mic now, + Meet later if captured) ──
    mixDestination = audioContext.createMediaStreamDestination();
    source.connect(mixDestination);

    const analyserBuffer = new Float32Array(analyserNode.fftSize);
    function monitorLevels() {
        if (!analyserNode) return;
        analyserNode.getFloatTimeDomainData(analyserBuffer);
        let sum = 0;
        for (let i = 0; i < analyserBuffer.length; i++) sum += analyserBuffer[i] * analyserBuffer[i];
        const rms = Math.sqrt(sum / analyserBuffer.length);
        lastMicRms = rms;
        const levelPct = Math.min(rms * 400, 100);

        const micBar = document.getElementById("micLevelBar");
        const micVal = document.getElementById("micLevelVal");
        if (micBar) micBar.style.width = `${levelPct}%`;
        if (micVal) micVal.textContent = rms.toFixed(4);

        const speechIndicator = document.getElementById("speechIndicator");
        if (rms > 0.01 && !speechActive) {
            speechActive = true;
            console.log(`[Resonance] 🎤 Speech detected — RMS: ${rms.toFixed(4)}`);
            log("🎤 Speech activity detected.");
            if (speechIndicator) { speechIndicator.textContent = "Speaking"; speechIndicator.className = "speech-indicator active"; }
        } else if (rms <= 0.005 && speechActive) {
            speechActive = false;
            console.log(`[Resonance] 🔇 Speech ended — RMS: ${rms.toFixed(4)}`);
            log("🔇 Speech ended.");
            if (speechIndicator) { speechIndicator.textContent = "Silent"; speechIndicator.className = "speech-indicator silent"; }
        }
        levelMonitorId = requestAnimationFrame(monitorLevels);
    }
    monitorLevels();

    // ── Audio capture & streaming via MediaRecorder ──
    // Records from mixDestination so Meet audio is automatically included when captured.
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

    mediaRecorder = new MediaRecorder(mixDestination.stream, { mimeType });

    let chunkCount = 0;
    mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size === 0) return;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;

        try {
            const buffer = await event.data.arrayBuffer();
            const base64 = arrayBufferToBase64(buffer);
            socket.send(JSON.stringify({ type: "audio_input", data: base64 }));

            chunkCount++;
            framesSent++;

            const framesEl = document.getElementById("framesSent");
            if (framesEl) framesEl.textContent = framesSent;

            if (chunkCount === 1) {
                console.log(`[Resonance] ✅ First audio chunk sent! base64 length: ${base64.length}, mimeType: ${mimeType}`);
                log("🎙️ First audio chunk sent to Hume.");
            }
            if (chunkCount % 10 === 0) {
                console.log(`[Resonance] Audio chunks sent: ${chunkCount} | payload: ${base64.length} chars`);
            }
        } catch (err) {
            console.warn("[Resonance] Audio send error:", err);
        }
    };

    mediaRecorder.start(100); // Send encoded audio every ~100ms
    console.log("[Resonance] MediaRecorder started:", mimeType);
    console.log("[Resonance] Mic pipeline: source → analyser → (silent) dest + MediaRecorder → WebSocket.");
    log("🎤 Microphone streaming started.");
    return true;
}

function stopMicrophone() {
    console.log("[Resonance] Stopping microphone…");
    // Stop Meet capture first if active
    if (meetActive) stopMeetCapture();
    if (levelMonitorId) {
        cancelAnimationFrame(levelMonitorId);
        levelMonitorId = null;
    }
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }
    mediaRecorder = null;
    mixDestination = null;
    if (analyserNode) {
        analyserNode.disconnect();
        analyserNode = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (playbackContext) {
        playbackContext.close();
        playbackContext = null;
    }
    audioQueue = [];
    isPlaying = false;
    framesSent = 0;
    speechActive = false;
    lastMicRms = 0;
    lastMeetRms = 0;
    activeSpeaker = "local";
    console.log("[Resonance] Microphone stopped.");
}

// ── Audio playback (Hume responses) ────────────────────────────────
// Uses a SEPARATE AudioContext so playback never interferes with mic capture.
// Hume sends WAV-encoded audio (RIFF header + PCM data), so we use
// decodeAudioData() which handles WAV natively.
async function playAudio(base64Audio) {
    audioQueue.push(base64Audio);
    if (isPlaying) return;
    isPlaying = true;
    console.log("[Resonance] 🔊 Assistant audio playback started.");

    // Lazy-init a dedicated playback context
    if (!playbackContext || playbackContext.state === "closed") {
        playbackContext = new AudioContext({ sampleRate: 48000 });
    }

    while (audioQueue.length > 0) {
        const chunk = audioQueue.shift();
        try {
            const arrayBuf = base64ToArrayBuffer(chunk);
            // decodeAudioData properly handles the WAV RIFF header + PCM data
            const audioBuffer = await playbackContext.decodeAudioData(arrayBuf);

            const src = playbackContext.createBufferSource();
            src.buffer = audioBuffer;
            src.connect(playbackContext.destination);
            src.start();

            await new Promise(resolve => { src.onended = resolve; });
        } catch (err) {
            console.warn("[Resonance] Audio playback error:", err);
        }
    }
    isPlaying = false;
    console.log("[Resonance] 🔊 Assistant audio playback finished.");
    log("🔊 Assistant finished speaking.");
}

// ── Emotion extraction ─────────────────────────────────────────────
// Hume returns prosody scores as an object: { "Admiration": 0.03, ... }
function extractMetrics(prosodyScores) {
    const lc = {};
    for (const [name, score] of Object.entries(prosodyScores)) {
        lc[name.toLowerCase()] = score;
    }
    return {
        confusion:   lc["confusion"]   ?? 0,
        doubt:       lc["doubt"]       ?? 0,
        frustration: lc["frustration"] ?? 0
    };
}

// ── .NET Policy Engine bridge ──────────────────────────────────────
async function pivotLogic(metrics) {
    console.log("[Resonance] Calling /Home/PivotLogic with:", metrics);
    try {
        const res = await fetch("/Home/PivotLogic", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(metrics)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json();
        console.log("[Resonance] PivotLogic response:", result);
        return result;
    } catch (err) {
        console.error("[Resonance] PivotLogic error:", err);
        log(`⚠ PivotLogic error: ${err.message}`);
        return null;
    }
}

// ── Hume config update ─────────────────────────────────────────────
function sendSessionSettings(newPrompt) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const msg = {
        type: "session_settings",
        system_prompt: newPrompt
    };
    socket.send(JSON.stringify(msg));
    console.log("[Resonance] Sent session_settings:", msg);
    log("⟳ Injected new system prompt via session_settings.");
}

// ── Auto-create Hume config (Free-tier compatible) ─────────────────
async function ensureConfig(apiKey) {
    // Versioned cache key — bump when config shape changes to force re-creation
    const cacheKey = "resonance_config_id_v2";
    // Clear legacy cache entries
    localStorage.removeItem("resonance_config_id");

    const cached = localStorage.getItem(cacheKey);
    if (cached) {
        console.log("[Resonance] Using cached config_id:", cached);
        return cached;
    }

    console.log("[Resonance] No config_id — creating Free-tier-compatible config…");
    log("🔧 Creating EVI config (hume-evi-3 + Kora voice)…");

    const res = await fetch("/Home/CreateConfig", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey })
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Config creation failed (${res.status}): ${errBody}`);
    }

    const data = await res.json();
    localStorage.setItem(cacheKey, data.configId);
    console.log("[Resonance] Created config_id:", data.configId);
    log(`🔧 Config created: ${data.configId}`);
    return data.configId;
}

// ── Google Meet audio capture ──────────────────────────────────────
// Uses getDisplayMedia() to capture tab audio from a Google Meet call.
// The captured audio is mixed into the existing pipeline via mixDestination
// so Hume EVI receives both local mic and remote Meet audio.
async function startMeetCapture() {
    if (!audioContext || !mixDestination) {
        alert("Connect to Hume first, then capture Meet audio.");
        return;
    }
    try {
        meetStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true
        });
    } catch (err) {
        console.warn("[Resonance] Meet capture cancelled:", err.message);
        log(`⚠ Meet capture cancelled: ${err.message}`);
        return;
    }

    // We only need the audio track
    meetStream.getVideoTracks().forEach(t => t.stop());
    const audioTracks = meetStream.getAudioTracks();
    if (audioTracks.length === 0) {
        log('⚠ No audio captured. Check "Share tab audio" when selecting the tab.');
        meetStream = null;
        return;
    }

    meetActive = true;

    // Create source + analyser for Meet audio levels
    meetSource = audioContext.createMediaStreamSource(meetStream);
    meetAnalyser = audioContext.createAnalyser();
    meetAnalyser.fftSize = 2048;
    meetSource.connect(meetAnalyser);

    // Mix Meet audio into the recording stream
    meetSource.connect(mixDestination);

    // Monitor Meet audio levels + multi-speaker identification
    const meetBuffer = new Float32Array(meetAnalyser.fftSize);
    function monitorMeetLevels() {
        if (!meetAnalyser) return;
        meetAnalyser.getFloatTimeDomainData(meetBuffer);
        let sum = 0;
        for (let i = 0; i < meetBuffer.length; i++) sum += meetBuffer[i] * meetBuffer[i];
        const meetRms = Math.sqrt(sum / meetBuffer.length);
        lastMeetRms = meetRms;
        const levelPct = Math.min(meetRms * 400, 100);

        const meetBar = document.getElementById("meetLevelBar");
        const meetVal = document.getElementById("meetLevelVal");
        if (meetBar) meetBar.style.width = `${levelPct}%`;
        if (meetVal) meetVal.textContent = meetRms.toFixed(4);

        // ── local vs. remote detection ──
        const thresh = 0.008;
        const micUp = lastMicRms > thresh;
        const meetUp = meetRms > thresh;
        let newSpeaker = activeSpeaker;
        if (micUp && meetUp) newSpeaker = lastMicRms > meetRms ? "local" : "remote";
        else if (micUp) newSpeaker = "local";
        else if (meetUp) newSpeaker = "remote";

        // ── Multi-speaker profiling for remote audio ──
        if (meetUp) {
            if (!remoteSpeechActive) {
                // Speech just started after silence
                remoteSpeechActive = true;
                const silenceMs = remoteSilenceStart ? (performance.now() - remoteSilenceStart) : 9999;
                if (silenceMs > 1500 || currentRemoteSpeakerId === null) {
                    // Long-enough gap → reset segment accumulator for profiling
                    segmentRmsAccum = 0;
                    segmentRmsSamples = 0;
                }
            }
            segmentRmsAccum += meetRms;
            segmentRmsSamples++;
            // After ~0.4 s of speech, try to identify / create the remote speaker
            if (segmentRmsSamples === 25) {
                identifyRemoteSpeaker(segmentRmsAccum / segmentRmsSamples);
            }
        } else {
            if (remoteSpeechActive) {
                remoteSpeechActive = false;
                remoteSilenceStart = performance.now();
            }
        }

        // ── Update active-speaker indicator ──
        if (newSpeaker !== activeSpeaker) {
            activeSpeaker = newSpeaker;
            const el = document.getElementById("activeSpeakerIndicator");
            if (el) {
                const label = activeSpeaker === "local"
                    ? "\uD83C\uDFA4 Agent"
                    : currentRemoteSpeakerId
                        ? `\uD83D\uDDA5\uFE0F ${remoteSpeakers.find(s => s.id === currentRemoteSpeakerId)?.label ?? "Customer"}`
                        : "\uD83D\uDDA5\uFE0F Customer";
                el.textContent = label;
                el.className = `speaker-indicator ${activeSpeaker}`;
            }
        }
        meetLevelMonitorId = requestAnimationFrame(monitorMeetLevels);
    }
    monitorMeetLevels();

    // Handle user stopping the tab share
    audioTracks[0].onended = () => stopMeetCapture();

    console.log("[Resonance] Meet audio capture started.");
    log("\uD83D\uDDA5\uFE0F Google Meet audio captured! Remote speakers are now analyzed.");

    // Update UI
    const meetStatus = document.getElementById("meetStatus");
    if (meetStatus) { meetStatus.textContent = "Capturing"; meetStatus.className = "meet-status active"; }
    const btnCapture = document.getElementById("btnMeetCapture");
    if (btnCapture) btnCapture.disabled = true;
    const btnStop = document.getElementById("btnMeetStop");
    if (btnStop) btnStop.disabled = false;
    const meetActivity = document.getElementById("meetActivity");
    if (meetActivity) meetActivity.style.display = "";
}

// Match a remote speech segment to an existing speaker or create a new one
function identifyRemoteSpeaker(avgRms) {
    // Try to match an existing speaker within 40 % RMS tolerance
    let matched = null;
    for (const sp of remoteSpeakers) {
        const ratio = avgRms / sp.avgRms;
        if (ratio > 0.6 && ratio < 1.4) { matched = sp; break; }
    }
    if (matched) {
        // Update running average
        matched.avgRms = (matched.avgRms * matched.turnCount + avgRms) / (matched.turnCount + 1);
        matched.turnCount++;
        currentRemoteSpeakerId = matched.id;
    } else {
        // New speaker detected
        const id = remoteSpeakers.length + 1;
        const sp = { id, label: `Customer ${id}`, avgRms, turnCount: 1, firstSeen: new Date().toISOString() };
        remoteSpeakers.push(sp);
        currentRemoteSpeakerId = id;
        console.log(`[Resonance] \uD83D\uDC64 New remote speaker detected: Customer ${id} (avgRms ${avgRms.toFixed(4)})`);
        log(`\uD83D\uDC64 New remote speaker detected: <b>Customer ${id}</b>`);
    }
    persistSpeakers();
    updateSpeakerList();
}

function persistSpeakers() {
    try { sessionStorage.setItem("resonance_speakers", JSON.stringify([{ id: "local", label: "Agent", firstSeen: null }, ...remoteSpeakers.map(s => ({ ...s, id: `remote-${s.id}` }))])); } catch {}
}

function updateSpeakerList() {
    const list = document.getElementById("speakerList");
    if (!list) return;
    let html = '<span class="spk-chip spk-local">\uD83C\uDFA4 Agent</span>';
    for (const sp of remoteSpeakers) {
        html += `<span class="spk-chip spk-remote">\uD83D\uDDA5\uFE0F ${sp.label} <small>(${sp.turnCount} turns)</small></span>`;
    }
    list.innerHTML = html;
}

function stopMeetCapture() {
    if (meetLevelMonitorId) { cancelAnimationFrame(meetLevelMonitorId); meetLevelMonitorId = null; }
    if (meetSource) { meetSource.disconnect(); meetSource = null; }
    if (meetAnalyser) { meetAnalyser.disconnect(); meetAnalyser = null; }
    if (meetStream) { meetStream.getTracks().forEach(t => t.stop()); meetStream = null; }
    meetActive = false;
    lastMeetRms = 0;
    activeSpeaker = "local";
    currentRemoteSpeakerId = null;
    remoteSpeechActive = false;
    remoteSilenceStart = 0;
    segmentRmsAccum = 0;
    segmentRmsSamples = 0;
    // Keep remoteSpeakers across reconnects so dashboard retains history

    console.log("[Resonance] Meet audio capture stopped.");
    log("\uD83D\uDDA5\uFE0F Meet audio capture stopped.");

    const meetStatus = document.getElementById("meetStatus");
    if (meetStatus) { meetStatus.textContent = "Not connected"; meetStatus.className = "meet-status inactive"; }
    const btnCapture = document.getElementById("btnMeetCapture");
    if (btnCapture && socket && socket.readyState === WebSocket.OPEN) btnCapture.disabled = false;
    const btnStop = document.getElementById("btnMeetStop");
    if (btnStop) btnStop.disabled = true;
    const meetActivity = document.getElementById("meetActivity");
    if (meetActivity) meetActivity.style.display = "none";
}

// ── WebSocket lifecycle ────────────────────────────────────────────
async function connect() {
    manualDisconnect = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) { alert("Please enter your Hume API key."); return; }

    // Resolve config_id: use the provided one, or auto-create a Free-tier one
    let configId = configIdInput.value.trim();
    if (!configId) {
        try {
            configId = await ensureConfig(apiKey);
            configIdInput.value = configId;
        } catch (err) {
            console.error("[Resonance] Config creation error:", err);
            log(`⚠ ${err.message}`);
            return;
        }
    }

    let url = `wss://api.hume.ai/v0/evi/chat?api_key=${encodeURIComponent(apiKey)}&config_id=${encodeURIComponent(configId)}`;

    setStatus("Connecting…", "connecting");
    log("Connecting to Hume EVI…");
    console.log("[Resonance] Opening WebSocket to:", url.replace(/api_key=[^&]+/, "api_key=***"));

    socket = new WebSocket(url);

    socket.onopen = async () => {
        setStatus("Connected", "connected");
        log("✓ WebSocket connected.");
        console.log("[Resonance] WebSocket OPEN.");
        btnConnect.disabled    = true;
        btnDisconnect.disabled = false;

        // Start capturing & streaming microphone audio
        const micOk = await startMicrophone();
        if (!micOk) {
            log("⚠ Could not start microphone. Speak will not work.");
            console.error("[Resonance] Microphone init failed.");
        }
        // Enable Meet capture now that audio pipeline is ready
        const btnMeetCapture = document.getElementById("btnMeetCapture");
        if (btnMeetCapture) btnMeetCapture.disabled = false;
    };

    socket.onclose = (e) => {
        setStatus("Disconnected", "disconnected");
        log(`✕ WebSocket closed (code ${e.code}, reason: ${e.reason || "none"}).`);
        console.log("[Resonance] WebSocket CLOSED:", e.code, e.reason);
        btnConnect.disabled    = false;
        btnDisconnect.disabled = true;
        stopMicrophone();
    };

    socket.onerror = (e) => {
        log("⚠ WebSocket error.");
        console.error("[Resonance] WebSocket ERROR:", e);
    };

    let messageCount = 0;
    socket.onmessage = async (evt) => {
        let data;
        try { data = JSON.parse(evt.data); } catch { return; }

        messageCount++;
        console.log(`[Resonance] WS msg #${messageCount} type="${data.type}"`, data);

        // Play back audio from Hume
        if (data.type === "audio_output" && data.data) {
            playAudio(data.data);
            return;
        }

        // Log full details for error messages from Hume
        if (data.type === "error") {
            const errCode = data.code || "unknown";
            const errMsg = data.message || JSON.stringify(data);
            const errSlug = data.slug || "";
            console.error(`[Resonance] Hume ERROR: code=${errCode} slug=${errSlug} message=${errMsg}`, data);
            log(`⚠ Hume error [${errCode}]: ${errMsg}`);
            // Only clear cached config on auth / config-level errors, NOT on I0100
            if (errCode !== "I0100") {
                localStorage.removeItem("resonance_config_id_v2");
                configIdInput.value = "";
            }
            // Auto-reconnect on transient I0100 errors (max 3 attempts)
            if (errCode === "I0100" && !manualDisconnect && reconnectAttempts < 3) {
                reconnectAttempts++;
                const delay = reconnectAttempts * 2;
                log(`🔄 Auto-reconnecting in ${delay}s (attempt ${reconnectAttempts}/3)…`);
                console.log(`[Resonance] Will auto-reconnect in ${delay}s (attempt ${reconnectAttempts}/3)…`);
                reconnectTimer = setTimeout(() => connect(), delay * 1000);
            } else if (errCode === "I0100" && reconnectAttempts >= 3) {
                log("⚠ Max reconnect attempts reached. Click Connect to retry.");
                console.warn("[Resonance] Max reconnect attempts reached.");
            }
            return;
        }

        // Handle user interruption (barge-in)
        if (data.type === "user_interruption") {
            console.log("[Resonance] 🛑 User interrupted the assistant.");
            log("🛑 User interrupted assistant.");
            audioQueue = [];
            isPlaying = false;
            return;
        }

        // Handle assistant_end
        if (data.type === "assistant_end") {
            console.log("[Resonance] Assistant turn ended.");
            log("📩 assistant_end");
            return;
        }

        // Only react to user_message events that carry prosody scores
        if (data.type !== "user_message") {
            if (data.type !== "audio_output") {
                log(`📩 ${data.type}`);
            }
            return;
        }

        // ── Real-time speech detection with full emotion logging ──
        const transcript = data.message?.content || "";
        console.log(`[Resonance] 🗣️ user_message received. Transcript: "${transcript}"`);
        console.log("[Resonance] Full models:", JSON.stringify(data.models, null, 2));
        log(`🗣️ User: "${transcript}"`);

        const prosody = data.models?.prosody?.scores;
        if (!prosody || Object.keys(prosody).length === 0) {
            console.warn("[Resonance] user_message has no prosody scores.");
            log("📩 user_message (no prosody scores)");
            return;
        }

        // Convert object {name: score} to sorted array for top-5 display
        const entries = Object.entries(prosody).map(([name, score]) => ({ name, score }));
        const sorted = entries.sort((a, b) => b.score - a.score);
        const top5 = sorted.slice(0, 5).map(e => `${e.name}: ${e.score.toFixed(3)}`).join(", ");
        console.log(`[Resonance] 🎭 Top emotions: ${top5}`);
        log(`🎭 Top emotions: ${top5}`);

        const metrics = extractMetrics(prosody);
        console.log("[Resonance] Extracted metrics:", metrics);
        log(`📊 Confusion=${metrics.confusion.toFixed(2)}  Doubt=${metrics.doubt.toFixed(2)}  Frustration=${metrics.frustration.toFixed(2)}`);

        updateBar(barConfusion,   valConfusion,   metrics.confusion);
        updateBar(barDoubt,       valDoubt,       metrics.doubt);
        updateBar(barFrustration, valFrustration, metrics.frustration);

        const adaptation = await pivotLogic(metrics);
        if (adaptation) {
            activeStrategy.textContent = adaptation.strategy;
            activePrompt.textContent   = adaptation.newSystemPrompt;
            log(`🔄 Strategy → <b>${adaptation.strategy}</b>`);
            console.log("[Resonance] Strategy pivot:", adaptation.strategy);

            if (adaptation.strategy !== "Baseline") {
                sendSessionSettings(adaptation.newSystemPrompt);
            }
        }

        // Collect event for the analytics dashboard
        let speakerId = "local";
        let speakerLabel = "Agent";
        if (meetActive && activeSpeaker === "remote" && currentRemoteSpeakerId) {
            const sp = remoteSpeakers.find(s => s.id === currentRemoteSpeakerId);
            speakerId = `remote-${currentRemoteSpeakerId}`;
            speakerLabel = sp?.label ?? `Customer ${currentRemoteSpeakerId}`;
        } else if (meetActive && activeSpeaker === "remote") {
            speakerId = "remote-0";
            speakerLabel = "Customer";
        }
        dashboardEvents.push({
            ts: new Date().toISOString(),
            transcript,
            speaker: activeSpeaker === "remote" ? "remote" : "local",
            speakerId,
            speakerLabel,
            allEmotions: prosody,
            top5: sorted.slice(0, 5),
            metrics,
            strategy: adaptation?.strategy ?? "Baseline"
        });
        // Persist to sessionStorage so the Dashboard page can read it
        try { sessionStorage.setItem("resonance_events", JSON.stringify(dashboardEvents)); } catch {}
    };
}

function disconnect() {
    console.log("[Resonance] Disconnect requested.");
    manualDisconnect = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (socket) socket.close();
    stopMicrophone();
}

// ── Event binding ──────────────────────────────────────────────────
btnConnect.addEventListener("click", () => { reconnectAttempts = 0; connect(); });
btnDisconnect.addEventListener("click", disconnect);
console.log("[Resonance] site.js loaded. Ready to connect.");
