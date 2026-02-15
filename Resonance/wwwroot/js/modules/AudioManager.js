/**
 * Manages microphone capture, audio mixing, and assistant audio playback.
 * Owns the AudioContext, MediaRecorder, and AnalyserNode pipeline.
 */
export class AudioManager {
    constructor() {
        this.audioContext = null;
        this.mixDestination = null;
        this.lastMicRms = 0;
        this.framesSent = 0;
        this.speechActive = false;

        this._micStream = null;
        this._mediaRecorder = null;
        this._analyserNode = null;
        this._levelMonitorId = null;
        this._playbackContext = null;
        this._audioQueue = [];
        this._isPlaying = false;

        /** @type {((base64: string) => void)|null} */
        this.onAudioChunk = null;
        /** @type {((active: boolean) => void)|null} */
        this.onSpeechChange = null;
        /** @type {((rms: number) => void)|null} */
        this.onLevelUpdate = null;
        /** @type {((count: number) => void)|null} */
        this.onFrameSent = null;
        /** @type {(() => void)|null} */
        this.onPlaybackComplete = null;
    }

    // ── Base64 utilities ───────────────────────────────────────────

    static arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    static base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    // ── Microphone capture ─────────────────────────────────────────

    async startMicrophone() {
        console.log("[AudioManager] Requesting microphone access...");

        try {
            this._micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 48000,
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });
            console.log("[AudioManager] Microphone access granted.", this._micStream.getTracks());
        } catch (err) {
            console.error("[AudioManager] Microphone access denied:", err);
            return false;
        }

        this.audioContext = new AudioContext({ sampleRate: 48000 });
        console.log("[AudioManager] AudioContext created. sampleRate:", this.audioContext.sampleRate);

        if (this.audioContext.state === "suspended") {
            await this.audioContext.resume();
        }

        const source = this.audioContext.createMediaStreamSource(this._micStream);

        // Real-time level monitoring via AnalyserNode
        this._analyserNode = this.audioContext.createAnalyser();
        this._analyserNode.fftSize = 2048;
        source.connect(this._analyserNode);
        const silentGain = this.audioContext.createGain();
        silentGain.gain.value = 0;
        this._analyserNode.connect(silentGain);
        silentGain.connect(this.audioContext.destination);

        // Mix destination (mic now, + Meet later if captured)
        this.mixDestination = this.audioContext.createMediaStreamDestination();
        source.connect(this.mixDestination);

        this._startLevelMonitor();
        this._startMediaRecorder();
        return true;
    }

    stopMicrophone() {
        console.log("[AudioManager] Stopping microphone...");

        if (this._levelMonitorId) {
            cancelAnimationFrame(this._levelMonitorId);
            this._levelMonitorId = null;
        }
        if (this._mediaRecorder && this._mediaRecorder.state !== "inactive") {
            this._mediaRecorder.stop();
        }
        this._mediaRecorder = null;
        this.mixDestination = null;
        if (this._analyserNode) {
            this._analyserNode.disconnect();
            this._analyserNode = null;
        }
        if (this._micStream) {
            this._micStream.getTracks().forEach(t => t.stop());
            this._micStream = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        if (this._playbackContext) {
            this._playbackContext.close();
            this._playbackContext = null;
        }
        this._audioQueue = [];
        this._isPlaying = false;
        this.framesSent = 0;
        this.speechActive = false;
        this.lastMicRms = 0;

        console.log("[AudioManager] Microphone stopped.");
    }

    // ── Audio playback (Hume responses) ────────────────────────────

    async playAudio(base64Audio) {
        this._audioQueue.push(base64Audio);
        if (this._isPlaying) return;
        this._isPlaying = true;

        if (!this._playbackContext || this._playbackContext.state === "closed") {
            this._playbackContext = new AudioContext({ sampleRate: 48000 });
        }

        while (this._audioQueue.length > 0) {
            const chunk = this._audioQueue.shift();
            try {
                const arrayBuf = AudioManager.base64ToArrayBuffer(chunk);
                const audioBuffer = await this._playbackContext.decodeAudioData(arrayBuf);
                const src = this._playbackContext.createBufferSource();
                src.buffer = audioBuffer;
                src.connect(this._playbackContext.destination);
                src.start();
                await new Promise(resolve => { src.onended = resolve; });
            } catch (err) {
                console.warn("[AudioManager] Audio playback error:", err);
            }
        }
        this._isPlaying = false;
        this.onPlaybackComplete?.();
    }

    clearPlaybackQueue() {
        this._audioQueue = [];
        this._isPlaying = false;
    }

    // ── Private ────────────────────────────────────────────────────

    _startLevelMonitor() {
        const buffer = new Float32Array(this._analyserNode.fftSize);
        const monitor = () => {
            if (!this._analyserNode) return;
            this._analyserNode.getFloatTimeDomainData(buffer);
            let sum = 0;
            for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
            const rms = Math.sqrt(sum / buffer.length);
            this.lastMicRms = rms;

            this.onLevelUpdate?.(rms);

            if (rms > 0.01 && !this.speechActive) {
                this.speechActive = true;
                this.onSpeechChange?.(true);
            } else if (rms <= 0.005 && this.speechActive) {
                this.speechActive = false;
                this.onSpeechChange?.(false);
            }
            this._levelMonitorId = requestAnimationFrame(monitor);
        };
        monitor();
    }

    _startMediaRecorder() {
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm";

        this._mediaRecorder = new MediaRecorder(this.mixDestination.stream, { mimeType });

        this._mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size === 0) return;

            try {
                const buffer = await event.data.arrayBuffer();
                const base64 = AudioManager.arrayBufferToBase64(buffer);
                this.onAudioChunk?.(base64);
                this.framesSent++;
                this.onFrameSent?.(this.framesSent);
            } catch (err) {
                console.warn("[AudioManager] Audio send error:", err);
            }
        };

        this._mediaRecorder.start(100);
        console.log("[AudioManager] MediaRecorder started:", mimeType);
    }
}
