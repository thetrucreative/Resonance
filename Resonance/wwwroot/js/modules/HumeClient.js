/**
 * Manages the WebSocket connection to Hume EVI,
 * including config creation, message routing, and auto-reconnect logic.
 */
export class HumeClient {
    constructor() {
        this.socket = null;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._manualDisconnect = false;
        this._messageCount = 0;

        /** @type {(() => void)|null} */
        this.onConnected = null;
        /** @type {(() => void)|null} */
        this.onDisconnected = null;
        /** @type {((status: string, cls: string) => void)|null} */
        this.onStatusChange = null;
        /** @type {((msg: string) => void)|null} */
        this.onLog = null;
        /** @type {((base64: string) => void)|null} */
        this.onAudioOutput = null;
        /** @type {((data: object) => void)|null} */
        this.onUserMessage = null;
        /** @type {((data: object) => void)|null} */
        this.onAssistantMessage = null;
        /** @type {(() => void)|null} */
        this.onUserInterruption = null;
        /** @type {((code: string, msg: string) => void)|null} */
        this.onError = null;
    }

    // ── Config management ──────────────────────────────────────────

    async ensureConfig(apiKey) {
        const cacheKey = "resonance_config_id_v2";
        localStorage.removeItem("resonance_config_id");

        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            console.log("[HumeClient] Using cached config_id:", cached);
            return cached;
        }

        console.log("[HumeClient] Creating EVI config...");
        this.onLog?.("Creating EVI config (hume-evi-3 + Kora voice)...");

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
        console.log("[HumeClient] Created config_id:", data.configId);
        this.onLog?.(`Config created: ${data.configId}`);
        return data.configId;
    }

    // ── Connection lifecycle ───────────────────────────────────────

    connect(apiKey, configId) {
        this._manualDisconnect = false;
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }

        const url = `wss://api.hume.ai/v0/evi/chat?api_key=${encodeURIComponent(apiKey)}&config_id=${encodeURIComponent(configId)}`;

        this.onStatusChange?.("Connecting...", "connecting");
        this.onLog?.("Connecting to Hume EVI...");
        console.log("[HumeClient] Opening WebSocket to:", url.replace(/api_key=[^&]+/, "api_key=***"));

        this.socket = new WebSocket(url);

        this.socket.onopen = () => {
            this.onStatusChange?.("Connected", "connected");
            this.onLog?.("WebSocket connected.");
            console.log("[HumeClient] WebSocket OPEN.");
            this.onConnected?.();
        };

        this.socket.onclose = (e) => {
            this.onStatusChange?.("Disconnected", "disconnected");
            this.onLog?.(`WebSocket closed (code ${e.code}, reason: ${e.reason || "none"}).`);
            console.log("[HumeClient] WebSocket CLOSED:", e.code, e.reason);
            this.onDisconnected?.();
        };

        this.socket.onerror = () => {
            this.onLog?.("WebSocket error.");
            console.error("[HumeClient] WebSocket ERROR.");
        };

        this._messageCount = 0;
        this.socket.onmessage = (evt) => this._handleMessage(evt, apiKey, configId);
    }

    disconnect() {
        console.log("[HumeClient] Disconnect requested.");
        this._manualDisconnect = true;
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this.socket) this.socket.close();
    }

    isConnected() {
        return this.socket && this.socket.readyState === WebSocket.OPEN;
    }

    resetReconnectAttempts() {
        this._reconnectAttempts = 0;
    }

    // ── Outbound messages ──────────────────────────────────────────

    sendAudio(base64) {
        if (!this.isConnected()) return;
        this.socket.send(JSON.stringify({ type: "audio_input", data: base64 }));
    }

    sendSessionSettings(prompt) {
        if (!this.isConnected()) return;
        const msg = { type: "session_settings", system_prompt: prompt };
        this.socket.send(JSON.stringify(msg));
        console.log("[HumeClient] Sent session_settings.");
        this.onLog?.("Injected new system prompt via session_settings.");
    }

    // ── Private ────────────────────────────────────────────────────

    _handleMessage(evt, apiKey, configId) {
        let data;
        try { data = JSON.parse(evt.data); } catch { return; }

        this._messageCount++;
        console.log(`[HumeClient] WS msg #${this._messageCount} type="${data.type}"`);

        if (data.type === "audio_output" && data.data) {
            this.onAudioOutput?.(data.data);
            return;
        }

        if (data.type === "error") {
            this._handleError(data, apiKey, configId);
            return;
        }

        if (data.type === "user_interruption") {
            console.log("[HumeClient] User interrupted the assistant.");
            this.onLog?.("User interrupted assistant.");
            this.onUserInterruption?.();
            return;
        }

        if (data.type === "assistant_message") {
            const text = data.message?.content || "";
            console.log(`[HumeClient] assistant_message: "${text}"`);
            this.onAssistantMessage?.(data);
            return;
        }

        if (data.type === "assistant_end") {
            console.log("[HumeClient] Assistant turn ended.");
            this.onLog?.("assistant_end");
            return;
        }

        if (data.type === "user_message") {
            this.onUserMessage?.(data);
            return;
        }

        if (data.type !== "audio_output") {
            this.onLog?.(`${data.type}`);
        }
    }

    _handleError(data, apiKey, configId) {
        const errCode = data.code || "unknown";
        const errMsg = data.message || JSON.stringify(data);
        console.error(`[HumeClient] Hume ERROR: code=${errCode} message=${errMsg}`, data);
        this.onLog?.(`Hume error [${errCode}]: ${errMsg}`);

        if (errCode !== "I0100") {
            localStorage.removeItem("resonance_config_id_v2");
        }
        this.onError?.(errCode, errMsg);

        // Auto-reconnect on transient I0100 errors (max 3 attempts)
        if (errCode === "I0100" && !this._manualDisconnect && this._reconnectAttempts < 3) {
            this._reconnectAttempts++;
            const delay = this._reconnectAttempts * 2;
            this.onLog?.(`Auto-reconnecting in ${delay}s (attempt ${this._reconnectAttempts}/3)...`);
            console.log(`[HumeClient] Will auto-reconnect in ${delay}s (attempt ${this._reconnectAttempts}/3)`);
            this._reconnectTimer = setTimeout(() => this.connect(apiKey, configId), delay * 1000);
        } else if (errCode === "I0100" && this._reconnectAttempts >= 3) {
            this.onLog?.("Max reconnect attempts reached. Click Connect to retry.");
            console.warn("[HumeClient] Max reconnect attempts reached.");
        }
    }
}
