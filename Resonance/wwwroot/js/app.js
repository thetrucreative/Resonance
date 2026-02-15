/**
 * Resonance – Application Orchestrator
 *
 * Creates module instances, wires their callbacks to each other
 * and the DOM, and handles the top-level connect/disconnect flow.
 */

import { AudioManager } from './modules/AudioManager.js';
import { MeetCapture }  from './modules/MeetCapture.js';
import { HumeClient }   from './modules/HumeClient.js';
import { EmotionTracker } from './modules/EmotionTracker.js';

// ── DOM refs ───────────────────────────────────────────────────────
const dom = {
    btnConnect:     document.getElementById("btnConnect"),
    btnDisconnect:  document.getElementById("btnDisconnect"),
    btnMeetCapture: document.getElementById("btnMeetCapture"),
    btnMeetStop:    document.getElementById("btnMeetStop"),
    apiKey:         document.getElementById("apiKey"),
    configId:       document.getElementById("configId"),
    status:         document.getElementById("connectionStatus"),
    barConfusion:   document.getElementById("barConfusion"),
    barDoubt:       document.getElementById("barDoubt"),
    barFrustration: document.getElementById("barFrustration"),
    valConfusion:   document.getElementById("valConfusion"),
    valDoubt:       document.getElementById("valDoubt"),
    valFrustration: document.getElementById("valFrustration"),
    activeStrategy: document.getElementById("activeStrategy"),
    activePrompt:   document.getElementById("activePrompt"),
    eventLog:       document.getElementById("eventLog"),
    micLevelBar:    document.getElementById("micLevelBar"),
    micLevelVal:    document.getElementById("micLevelVal"),
    framesSent:     document.getElementById("framesSent"),
    speechIndicator:          document.getElementById("speechIndicator"),
    meetStatus:               document.getElementById("meetStatus"),
    meetActivity:             document.getElementById("meetActivity"),
    meetLevelBar:             document.getElementById("meetLevelBar"),
    meetLevelVal:             document.getElementById("meetLevelVal"),
    activeSpeakerIndicator:   document.getElementById("activeSpeakerIndicator"),
    speakerList:              document.getElementById("speakerList")
};

// ── Module instances ───────────────────────────────────────────────
const audio    = new AudioManager();
const meet     = new MeetCapture(audio);
const hume     = new HumeClient();
const emotions = new EmotionTracker();
emotions.onError = (msg) => log(msg);

// ── Helpers ────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toLocaleTimeString();
    const entry = document.createElement("div");
    entry.className = "entry";
    entry.innerHTML = `<span class="ts">${ts}</span>${msg}`;
    dom.eventLog.prepend(entry);
}

function updateBar(barEl, valEl, score) {
    const pct = Math.min(score * 100, 100);
    barEl.style.width = `${pct}%`;
    valEl.textContent = score.toFixed(2);
}

function updateSpeakerList() {
    if (!dom.speakerList) return;
    let html = '<span class="spk-chip spk-local">Agent (You)</span>';
    for (const sp of meet.remoteSpeakers) {
        html += `<span class="spk-chip spk-remote">${sp.label} <small>(${sp.turnCount} turns)</small></span>`;
    }
    dom.speakerList.innerHTML = html;
}

// ── AudioManager callbacks ─────────────────────────────────────────
audio.onAudioChunk = (base64) => hume.sendAudio(base64);

audio.onLevelUpdate = (rms) => {
    const pct = Math.min(rms * 400, 100);
    if (dom.micLevelBar) dom.micLevelBar.style.width = `${pct}%`;
    if (dom.micLevelVal) dom.micLevelVal.textContent = rms.toFixed(4);
};

audio.onSpeechChange = (active) => {
    if (active) {
        log("Speech activity detected.");
        if (dom.speechIndicator) {
            dom.speechIndicator.textContent = "Speaking";
            dom.speechIndicator.className = "speech-indicator active";
        }
    } else {
        log("Speech ended.");
        if (dom.speechIndicator) {
            dom.speechIndicator.textContent = "Silent";
            dom.speechIndicator.className = "speech-indicator silent";
        }
    }
};

audio.onFrameSent = (count) => {
    if (dom.framesSent) dom.framesSent.textContent = count;
    if (count === 1) log("First audio chunk sent to Hume.");
};

audio.onPlaybackComplete = () => log("Assistant finished speaking.");

// ── MeetCapture callbacks ──────────────────────────────────────────
meet.onLevelUpdate = (rms) => {
    const pct = Math.min(rms * 400, 100);
    if (dom.meetLevelBar) dom.meetLevelBar.style.width = `${pct}%`;
    if (dom.meetLevelVal) dom.meetLevelVal.textContent = rms.toFixed(4);
};

meet.onSpeakerChange = (speaker, label) => {
    if (dom.activeSpeakerIndicator) {
        dom.activeSpeakerIndicator.textContent = label;
        dom.activeSpeakerIndicator.className = `speaker-indicator ${speaker}`;
    }
};

meet.onNewSpeaker = (sp) => {
    log(`New remote speaker detected: <b>${sp.label}</b>`);
    updateSpeakerList();
};

meet.onStatusChange = (active) => {
    if (active) {
        log("Call audio captured. Remote speakers are now analyzed.");
        if (dom.meetStatus) { dom.meetStatus.textContent = "Capturing"; dom.meetStatus.className = "meet-status active"; }
        if (dom.btnMeetCapture) dom.btnMeetCapture.disabled = true;
        if (dom.btnMeetStop) dom.btnMeetStop.disabled = false;
        if (dom.meetActivity) dom.meetActivity.style.display = "";
    } else {
        log("Call audio capture stopped.");
        if (dom.meetStatus) { dom.meetStatus.textContent = "Not connected"; dom.meetStatus.className = "meet-status inactive"; }
        if (dom.btnMeetCapture && hume.isConnected()) dom.btnMeetCapture.disabled = false;
        if (dom.btnMeetStop) dom.btnMeetStop.disabled = true;
        if (dom.meetActivity) dom.meetActivity.style.display = "none";
    }
};

// ── HumeClient callbacks ───────────────────────────────────────────
hume.onStatusChange = (text, cls) => {
    dom.status.textContent = text;
    dom.status.className = `status ${cls}`;
};

hume.onLog = (msg) => log(msg);

hume.onAudioOutput = (base64) => audio.playAudio(base64);

hume.onUserInterruption = () => audio.clearPlaybackQueue();

hume.onAssistantMessage = (data) => {
    const transcript = data.message?.content || "";
    log(`AI Assistant: "${transcript}"`);

    emotions.recordEvent({
        ts: new Date().toISOString(),
        transcript,
        speaker: "assistant",
        speakerId: "assistant",
        speakerLabel: "AI Assistant",
        allEmotions: null,
        top5: [],
        metrics: { confusion: 0, doubt: 0, frustration: 0 },
        strategy: "—",
        severity: "none",
        reasoning: ""
    });
};

hume.onError = (code) => {
    if (code !== "I0100") {
        dom.configId.value = "";
    }
};

hume.onConnected = async () => {
    dom.btnConnect.disabled = true;
    dom.btnDisconnect.disabled = false;

    const micOk = await audio.startMicrophone();
    if (micOk) {
        log("Microphone streaming started.");
        if (dom.btnMeetCapture) dom.btnMeetCapture.disabled = false;
    } else {
        log("Could not start microphone. Speak will not work.");
        if (location.protocol !== "https:" && location.hostname !== "localhost") {
            log('<b>HTTPS required</b> — Microphone and call capture need a secure connection. Enable SSL on your domain.');
        }
    }
};

hume.onDisconnected = () => {
    dom.btnConnect.disabled = false;
    dom.btnDisconnect.disabled = true;
    if (meet.isActive()) meet.stop();
    audio.stopMicrophone();
};

hume.onUserMessage = async (data) => {
    const transcript = data.message?.content || "";
    console.log(`[App] user_message: "${transcript}"`);
    log(`User: "${transcript}"`);

    const prosody = data.models?.prosody?.scores;
    if (!prosody || Object.keys(prosody).length === 0) {
        log("user_message (no prosody scores)");
        return;
    }

    // Sort emotions by score descending for display and backend context
    const entries = Object.entries(prosody).map(([name, score]) => ({ name, score }));
    const sorted = entries.sort((a, b) => b.score - a.score);
    const top5 = sorted.slice(0, 5).map(e => `${e.name}: ${e.score.toFixed(3)}`).join(", ");
    log(`Top emotions: ${top5}`);

    const metrics = emotions.extractMetrics(prosody);
    log(`Confusion=${metrics.confusion.toFixed(2)}  Doubt=${metrics.doubt.toFixed(2)}  Frustration=${metrics.frustration.toFixed(2)}`);

    updateBar(dom.barConfusion,   dom.valConfusion,   metrics.confusion);
    updateBar(dom.barDoubt,       dom.valDoubt,       metrics.doubt);
    updateBar(dom.barFrustration, dom.valFrustration, metrics.frustration);

    // Evaluate strategy via .NET policy engine
    const adaptation = await emotions.evaluateStrategy(metrics, sorted);
    if (adaptation) {
        dom.activeStrategy.textContent = adaptation.strategy;
        dom.activePrompt.textContent = adaptation.newSystemPrompt;

        const sev = adaptation.severity || "none";
        const reason = adaptation.reasoning || "";
        if (adaptation.strategy !== "Baseline") {
            log(`Strategy: <b>${adaptation.strategy}</b> [${sev}]`);
            if (reason) log(`Reason: ${reason}`);
            console.log(`[App] PIVOT: ${adaptation.strategy} (${sev})`);
            hume.sendSessionSettings(adaptation.newSystemPrompt);
        } else {
            log(`Strategy: <b>Baseline</b>`);
        }
    }

    // Tag with speaker info and persist for the dashboard
    const speaker = meet.isActive() ? meet.activeSpeaker : "local";
    const { speakerId, speakerLabel } = (meet.isActive() && speaker === "remote")
        ? meet.getCurrentSpeakerInfo()
        : { speakerId: "local", speakerLabel: "Agent (You)" };

    emotions.recordEvent({
        ts: new Date().toISOString(),
        transcript,
        speaker: speaker === "remote" ? "remote" : "local",
        speakerId,
        speakerLabel,
        allEmotions: prosody,
        top5: sorted.slice(0, 5),
        metrics,
        strategy: adaptation?.strategy ?? "Baseline",
        severity: adaptation?.severity ?? "none",
        reasoning: adaptation?.reasoning ?? ""
    });
};

// ── Top-level actions ──────────────────────────────────────────────
async function connectToHume() {
    hume.resetReconnectAttempts();

    const apiKey = dom.apiKey.value.trim();
    if (!apiKey) { alert("Please enter your Hume API key."); return; }

    let configId = dom.configId.value.trim();
    if (!configId) {
        try {
            configId = await hume.ensureConfig(apiKey);
            dom.configId.value = configId;
        } catch (err) {
            console.error("[App] Config creation error:", err);
            log(`Config error: ${err.message}`);
            return;
        }
    }

    hume.connect(apiKey, configId);
}

function disconnectFromHume() {
    hume.disconnect();
    // socket.close triggers onDisconnected which stops audio + meet
    // Also stop explicitly for immediate cleanup
    if (meet.isActive()) meet.stop();
    audio.stopMicrophone();
}

async function startMeetCapture() {
    if (!audio.audioContext || !audio.mixDestination) {
        log('Audio pipeline not ready. Make sure you are <b>connected</b> and microphone is active.');
        if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
            log('<b>HTTPS required</b> — Mic and screen capture only work on HTTPS. Enable SSL on your domain.');
        }
        return;
    }
    const result = await meet.start();
    if (!result.ok) {
        if (result.reason === "cancelled") log(`Meet capture cancelled: ${result.message}`);
        else if (result.reason === "no-audio") log('No audio captured. Check "Share tab audio" when selecting the tab.');
    }
}

// ── Event binding ──────────────────────────────────────────────────
dom.btnConnect.addEventListener("click", connectToHume);
dom.btnDisconnect.addEventListener("click", disconnectFromHume);
if (dom.btnMeetCapture) dom.btnMeetCapture.addEventListener("click", startMeetCapture);
if (dom.btnMeetStop) dom.btnMeetStop.addEventListener("click", () => meet.stop());

// ── HTTPS check ────────────────────────────────────────────────────
if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    log('<b>Warning:</b> This site is served over HTTP. Microphone, Meet capture, and WebSocket features require <b>HTTPS</b>. Enable SSL on your hosting provider.');
    console.warn("[App] Site is NOT on HTTPS — getUserMedia and getDisplayMedia will fail.");
}
console.log("[App] Resonance loaded. Ready to connect.");
