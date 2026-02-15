/**
 * Captures audio from a browser tab (Teams, Meet, Zoom, etc.) via getDisplayMedia,
 * mixes it into the AudioManager pipeline, and profiles individual
 * remote speakers by their average volume level.
 */
export class MeetCapture {
    constructor(audioManager) {
        this._audio = audioManager;
        this._meetStream = null;
        this._meetSource = null;
        this._meetAnalyser = null;
        this._levelMonitorId = null;

        this.active = false;
        this.lastMeetRms = 0;
        this.activeSpeaker = "local";

        // Speaker profiling state
        this.remoteSpeakers = [];
        this.currentRemoteSpeakerId = null;
        this._remoteSpeechActive = false;
        this._remoteSilenceStart = 0;
        this._segmentRmsAccum = 0;
        this._segmentRmsSamples = 0;

        /** @type {((speaker: string, label: string) => void)|null} */
        this.onSpeakerChange = null;
        /** @type {((speaker: object) => void)|null} */
        this.onNewSpeaker = null;
        /** @type {((rms: number) => void)|null} */
        this.onLevelUpdate = null;
        /** @type {((active: boolean) => void)|null} */
        this.onStatusChange = null;
    }

    /**
     * Prompts the user to share a tab and begins capturing its audio.
     * @returns {{ ok: boolean, reason?: string, message?: string }}
     */
    async start() {
        if (!this._audio.audioContext || !this._audio.mixDestination) {
            return { ok: false, reason: "pipeline" };
        }

        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });
        } catch (err) {
            return { ok: false, reason: "cancelled", message: err.message };
        }

        // Only the audio track is needed
        stream.getVideoTracks().forEach(t => t.stop());
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
            return { ok: false, reason: "no-audio" };
        }

        this._meetStream = stream;
        this.active = true;

        // Wire into the AudioManager's audio graph
        this._meetSource = this._audio.audioContext.createMediaStreamSource(this._meetStream);
        this._meetAnalyser = this._audio.audioContext.createAnalyser();
        this._meetAnalyser.fftSize = 2048;
        this._meetSource.connect(this._meetAnalyser);
        this._meetSource.connect(this._audio.mixDestination);

        this._startLevelMonitor();

        // Handle user stopping the tab share via browser UI
        audioTracks[0].onended = () => this.stop();

        this.onStatusChange?.(true);
        console.log("[MeetCapture] Audio capture started.");
        return { ok: true };
    }

    stop() {
        if (this._levelMonitorId) { cancelAnimationFrame(this._levelMonitorId); this._levelMonitorId = null; }
        if (this._meetSource) { this._meetSource.disconnect(); this._meetSource = null; }
        if (this._meetAnalyser) { this._meetAnalyser.disconnect(); this._meetAnalyser = null; }
        if (this._meetStream) { this._meetStream.getTracks().forEach(t => t.stop()); this._meetStream = null; }

        this.active = false;
        this.lastMeetRms = 0;
        this.activeSpeaker = "local";
        this.currentRemoteSpeakerId = null;
        this._remoteSpeechActive = false;
        this._remoteSilenceStart = 0;
        this._segmentRmsAccum = 0;
        this._segmentRmsSamples = 0;
        // Keep remoteSpeakers across reconnects so dashboard retains history

        this.onStatusChange?.(false);
        console.log("[MeetCapture] Audio capture stopped.");
    }

    isActive() {
        return this.active;
    }

    /**
     * Returns the speakerId and speakerLabel for the currently active speaker.
     */
    getCurrentSpeakerInfo() {
        if (this.activeSpeaker === "local") {
            return { speakerId: "local", speakerLabel: "Agent (You)" };
        }
        if (this.currentRemoteSpeakerId) {
            const sp = this.remoteSpeakers.find(s => s.id === this.currentRemoteSpeakerId);
            return {
                speakerId: `remote-${this.currentRemoteSpeakerId}`,
                speakerLabel: sp?.label ?? `Customer ${this.currentRemoteSpeakerId}`
            };
        }
        return { speakerId: "remote-0", speakerLabel: "Customer" };
    }

    // ── Private ────────────────────────────────────────────────────

    _startLevelMonitor() {
        const buffer = new Float32Array(this._meetAnalyser.fftSize);

        const monitor = () => {
            if (!this._meetAnalyser) return;
            this._meetAnalyser.getFloatTimeDomainData(buffer);
            let sum = 0;
            for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
            const meetRms = Math.sqrt(sum / buffer.length);
            this.lastMeetRms = meetRms;

            this.onLevelUpdate?.(meetRms);

            // Local vs. remote speaker detection via RMS comparison
            const thresh = 0.008;
            const micUp = this._audio.lastMicRms > thresh;
            const meetUp = meetRms > thresh;
            let newSpeaker = this.activeSpeaker;
            if (micUp && meetUp) newSpeaker = this._audio.lastMicRms > meetRms ? "local" : "remote";
            else if (micUp) newSpeaker = "local";
            else if (meetUp) newSpeaker = "remote";

            // Multi-speaker profiling for remote audio
            this._profileRemoteSpeech(meetUp, meetRms);

            // Notify on speaker change
            if (newSpeaker !== this.activeSpeaker) {
                this.activeSpeaker = newSpeaker;
                const label = this.activeSpeaker === "local"
                    ? "Agent (You)"
                    : this.currentRemoteSpeakerId
                        ? (this.remoteSpeakers.find(s => s.id === this.currentRemoteSpeakerId)?.label ?? "Customer")
                        : "Customer";
                this.onSpeakerChange?.(this.activeSpeaker, label);
            }

            this._levelMonitorId = requestAnimationFrame(monitor);
        };
        monitor();
    }

    _profileRemoteSpeech(meetUp, meetRms) {
        if (meetUp) {
            if (!this._remoteSpeechActive) {
                this._remoteSpeechActive = true;
                const silenceMs = this._remoteSilenceStart
                    ? (performance.now() - this._remoteSilenceStart) : 9999;
                if (silenceMs > 1500 || this.currentRemoteSpeakerId === null) {
                    this._segmentRmsAccum = 0;
                    this._segmentRmsSamples = 0;
                }
            }
            this._segmentRmsAccum += meetRms;
            this._segmentRmsSamples++;
            if (this._segmentRmsSamples === 25) {
                this._identifyRemoteSpeaker(this._segmentRmsAccum / this._segmentRmsSamples);
            }
        } else {
            if (this._remoteSpeechActive) {
                this._remoteSpeechActive = false;
                this._remoteSilenceStart = performance.now();
            }
        }
    }

    _identifyRemoteSpeaker(avgRms) {
        let matched = null;
        for (const sp of this.remoteSpeakers) {
            const ratio = avgRms / sp.avgRms;
            if (ratio > 0.6 && ratio < 1.4) { matched = sp; break; }
        }
        if (matched) {
            matched.avgRms = (matched.avgRms * matched.turnCount + avgRms) / (matched.turnCount + 1);
            matched.turnCount++;
            this.currentRemoteSpeakerId = matched.id;
        } else {
            const id = this.remoteSpeakers.length + 1;
            const sp = { id, label: `Customer ${id}`, avgRms, turnCount: 1, firstSeen: new Date().toISOString() };
            this.remoteSpeakers.push(sp);
            this.currentRemoteSpeakerId = id;
            console.log(`[MeetCapture] New remote speaker: Customer ${id} (avgRms ${avgRms.toFixed(4)})`);
            this.onNewSpeaker?.(sp);
        }
        this._persistSpeakers();
    }

    _persistSpeakers() {
        try {
            const data = [
                { id: "local", label: "Agent (You)", firstSeen: null },
                ...this.remoteSpeakers.map(s => ({ ...s, id: `remote-${s.id}` }))
            ];
            localStorage.setItem("resonance_speakers", JSON.stringify(data));
        } catch { /* quota exceeded — non-critical */ }
    }
}
