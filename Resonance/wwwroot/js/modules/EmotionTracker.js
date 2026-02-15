/**
 * Extracts emotion metrics from Hume prosody data,
 * bridges to the .NET policy engine, and collects dashboard events.
 */
export class EmotionTracker {
    constructor() {
        this.events = [];

        /** @type {((msg: string) => void)|null} */
        this.onError = null;
    }

    /**
     * Extracts confusion, doubt, and frustration scores from
     * the full Hume prosody score map.
     */
    extractMetrics(prosodyScores) {
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

    /**
     * POSTs metrics to the .NET PolicyEngine and returns the adaptation result.
     * @returns {Promise<{strategy, newSystemPrompt, severity, reasoning}|null>}
     */
    async evaluateStrategy(metrics, sortedEmotions) {
        const payload = {
            ...metrics,
            topEmotions: sortedEmotions
                ? sortedEmotions.slice(0, 5).map(e => ({ name: e.name, score: e.score }))
                : [],
            turnIndex: this.events.length + 1
        };
        console.log("[EmotionTracker] Calling /Home/PivotLogic:", payload);
        try {
            const res = await fetch("/Home/PivotLogic", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const result = await res.json();
            console.log("[EmotionTracker] PivotLogic response:", result);
            return result;
        } catch (err) {
            console.error("[EmotionTracker] PivotLogic error:", err);
            this.onError?.(`PivotLogic error: ${err.message}`);
            return null;
        }
    }

    /**
     * Appends an event to the session log and persists to localStorage.
     */
    recordEvent(eventData) {
        this.events.push(eventData);
        this._persist();
    }

    getEventCount() {
        return this.events.length;
    }

    _persist() {
        try {
            localStorage.setItem("resonance_events", JSON.stringify(this.events));
        } catch { /* quota exceeded — non-critical */ }
    }
}
