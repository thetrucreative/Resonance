using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Resonance.Models;

namespace Resonance.Controllers;

public class HomeController : Controller
{
    /// <summary>
    /// Serves the main SPA-style page with the Hume EVI WebSocket client.
    /// </summary>
    public IActionResult Index() => View();

    /// <summary>
    /// Analytics dashboard for B2B / B2C call-center emotion analysis.
    /// Reads session events from the client-side sessionStorage via JS.
    /// </summary>
    public IActionResult Dashboard() => View();

    /// <summary>
    /// Creates a Free-tier-compatible Hume EVI configuration via the REST API.
    /// Uses the EVI 3 default model and a built-in voice.
    /// Deletes any existing "Resonance Agent" config first to avoid conflicts.
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> CreateConfig([FromBody] CreateConfigRequest request)
    {
        if (string.IsNullOrWhiteSpace(request?.ApiKey))
            return BadRequest(new { error = "API key is required." });

        using var http = new HttpClient();
        http.DefaultRequestHeaders.Add("X-Hume-Api-Key", request.ApiKey);

        // Step 1: Delete any existing "Resonance Agent" configs
        await DeleteExistingConfigs(http, "Resonance Agent");

        // Step 2: Create a fresh config with Free-tier-compatible settings
        // Note: event_messages.on_new_chat is intentionally omitted.
        // The greeting TTS was triggering an I0100 server crash on Hume's side.
        // Without it the assistant waits for the user to speak first.
        var payload = new
        {
            evi_version = "3",
            name = "Resonance Agent",
            voice = new { provider = "HUME_AI", name = "Kora" },
            prompt = new
            {
                text = "You are a helpful, empathetic conversational assistant. " +
                       "Be clear, friendly, and helpful. Respond naturally to the user."
            }
        };

        var response = await http.PostAsJsonAsync("https://api.hume.ai/v0/evi/configs", payload);

        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync();
            return StatusCode((int)response.StatusCode, new { error = errorBody });
        }

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var configId = doc.RootElement.GetProperty("id").GetString();

        return Json(new { configId });
    }

    /// <summary>
    /// Lists all EVI configs and deletes any matching the given name.
    /// </summary>
    private static async Task DeleteExistingConfigs(HttpClient http, string configName)
    {
        var listResponse = await http.GetAsync("https://api.hume.ai/v0/evi/configs?page_size=100");
        if (!listResponse.IsSuccessStatusCode) return;

        var body = await listResponse.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);

        // The Hume API returns { "configs_page": [...], ... }
        if (!doc.RootElement.TryGetProperty("configs_page", out var configs))
            return;

        foreach (var cfg in configs.EnumerateArray())
        {
            if (cfg.TryGetProperty("name", out var name) &&
                name.GetString() == configName &&
                cfg.TryGetProperty("id", out var id))
            {
                var cfgId = id.GetString();
                await http.DeleteAsync($"https://api.hume.ai/v0/evi/configs/{cfgId}");
            }
        }
    }

    /// <summary>
    /// Self-Improving Policy Engine.
    /// Receives prosody emotion scores and returns an adapted system prompt.
    /// Uses realistic thresholds calibrated to actual Hume EVI score ranges (0.01–0.20),
    /// momentum tracking across turns, and multi-emotion blending for nuanced strategies.
    /// </summary>
    [HttpPost]
    public IActionResult PivotLogic([FromBody] EmotionMetrics metrics)
    {
        if (metrics is null)
            return BadRequest(new { error = "EmotionMetrics payload is required." });

        var result = Evaluate(metrics);
        return Json(result);
    }

    // ── Rolling history for momentum tracking ──────────────────────
    // Stores the last N emotion snapshots to detect trends, not just spikes.
    private static readonly List<EmotionMetrics> _history = new();
    private static readonly object _lock = new();

    private static AdaptationResult Evaluate(EmotionMetrics m)
    {
        // ── 1. Record this turn and compute momentum ──
        lock (_lock)
        {
            _history.Add(m);
            if (_history.Count > 10) _history.RemoveAt(0); // keep last 10
        }

        var (avgC, avgD, avgF, trend) = ComputeMomentum();

        // ── 2. Detect dominant negative emotion from top-5 ──
        var dominantNeg = DetectDominantNegative(m);

        // ── 3. Multi-tier evaluation (calibrated to real Hume ranges) ──
        // Hume prosody scores are typically 0.01–0.20 for these emotions.
        // We use both instant values and rolling averages for robustness.

        // HIGH severity: clear distress signal
        if (m.Frustration > 0.10 || avgF > 0.08)
        {
            return new AdaptationResult
            {
                Strategy = "De-escalation",
                Severity = "high",
                Reasoning = $"Frustration detected at {m.Frustration:P1} (avg {avgF:P1}, trend {trend}). " +
                            $"Dominant emotion: {dominantNeg}. Switching to empathetic de-escalation.",
                NewSystemPrompt =
                    "IMPORTANT BEHAVIORAL SHIFT: The speaker is showing frustration. " +
                    "Immediately acknowledge their frustration with empathy. " +
                    "Slow down your pace. Use shorter sentences. " +
                    "Offer a concise summary of what you've covered so far. " +
                    "Ask one clear question about how you can help most effectively. " +
                    "Do NOT repeat information they've already heard."
            };
        }

        if (m.Confusion > 0.08 || avgC > 0.06)
        {
            return new AdaptationResult
            {
                Strategy = "Simplification",
                Severity = avgC > 0.08 ? "high" : "moderate",
                Reasoning = $"Confusion detected at {m.Confusion:P1} (avg {avgC:P1}, trend {trend}). " +
                            $"Dominant emotion: {dominantNeg}. Simplifying approach.",
                NewSystemPrompt =
                    "IMPORTANT BEHAVIORAL SHIFT: The speaker appears confused. " +
                    "Switch to a simplification strategy immediately: " +
                    "use plain language and real-world analogies, avoid all jargon, " +
                    "break your response into numbered steps (max 3 at a time), " +
                    "and pause to check understanding before continuing. " +
                    "If they asked a question, answer it directly first, then explain."
            };
        }

        if (m.Doubt > 0.05 || avgD > 0.04)
        {
            return new AdaptationResult
            {
                Strategy = "Authority",
                Severity = avgD > 0.06 ? "moderate" : "low",
                Reasoning = $"Doubt detected at {m.Doubt:P1} (avg {avgD:P1}, trend {trend}). " +
                            $"Dominant emotion: {dominantNeg}. Building credibility.",
                NewSystemPrompt =
                    "IMPORTANT BEHAVIORAL SHIFT: The speaker sounds uncertain or doubtful. " +
                    "Shift to an authority strategy: cite specific data or examples, " +
                    "use a confident and reassuring tone, proactively address the most " +
                    "likely objection, and reinforce what you know is correct. " +
                    "If you're unsure about something, be transparent about it."
            };
        }

        // ── 4. Composite / blended detection ──
        double composite = m.Confusion * 0.4 + m.Doubt * 0.3 + m.Frustration * 0.3;
        if (composite > 0.04)
        {
            return new AdaptationResult
            {
                Strategy = "Engagement",
                Severity = "low",
                Reasoning = $"Low-level mixed signals: composite={composite:F3} " +
                            $"(C={m.Confusion:P1} D={m.Doubt:P1} F={m.Frustration:P1}). " +
                            $"Dominant emotion: {dominantNeg}. Boosting engagement.",
                NewSystemPrompt =
                    "The speaker is showing mixed low-level signals of disengagement. " +
                    "Increase engagement: ask a brief clarifying question, " +
                    "use their name if known, offer a relevant example, " +
                    "and keep responses concise and actionable."
            };
        }

        // ── 5. Trend-based early warning ──
        if (trend == "rising" && avgC + avgD + avgF > 0.05)
        {
            return new AdaptationResult
            {
                Strategy = "Proactive",
                Severity = "low",
                Reasoning = $"Negative emotion trend is {trend} (avgC={avgC:P1} avgD={avgD:P1} avgF={avgF:P1}). " +
                            "Proactively adjusting before issues escalate.",
                NewSystemPrompt =
                    "Subtle signs suggest the conversation may be heading toward difficulty. " +
                    "Proactively check in: briefly summarize what you've discussed, " +
                    "ask if anything needs clarification, and offer to approach the topic differently."
            };
        }

        // ── 6. Steady state — positive reinforcement ──
        return new AdaptationResult
        {
            Strategy = "Baseline",
            Severity = "none",
            Reasoning = $"Emotions within normal range (C={m.Confusion:P1} D={m.Doubt:P1} F={m.Frustration:P1}). " +
                        $"Dominant emotion: {dominantNeg}. No adaptation needed.",
            NewSystemPrompt =
                "Continue with the current conversational approach. " +
                "Be clear, friendly, and helpful."
        };
    }

    private static (double avgC, double avgD, double avgF, string trend) ComputeMomentum()
    {
        lock (_lock)
        {
            if (_history.Count == 0) return (0, 0, 0, "stable");

            var avgC = _history.Average(h => h.Confusion);
            var avgD = _history.Average(h => h.Doubt);
            var avgF = _history.Average(h => h.Frustration);

            // Compare first half vs second half to detect trend
            if (_history.Count >= 4)
            {
                int half = _history.Count / 2;
                var firstSum = _history.Take(half).Average(h => h.Confusion + h.Doubt + h.Frustration);
                var lastSum = _history.Skip(half).Average(h => h.Confusion + h.Doubt + h.Frustration);
                var delta = lastSum - firstSum;
                var trend = delta > 0.01 ? "rising" : delta < -0.01 ? "falling" : "stable";
                return (avgC, avgD, avgF, trend);
            }

            return (avgC, avgD, avgF, "stable");
        }
    }

    private static string DetectDominantNegative(EmotionMetrics m)
    {
        if (m.TopEmotions is { Count: > 0 })
            return m.TopEmotions[0].Name;

        // Fallback: return the highest of the three tracked metrics
        if (m.Confusion >= m.Doubt && m.Confusion >= m.Frustration) return "Confusion";
        if (m.Doubt >= m.Frustration) return "Doubt";
        return "Frustration";
    }
}
