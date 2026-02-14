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
    /// Threshold-Based Policy Engine.
    /// Receives prosody emotion scores and returns an adapted system prompt.
    /// </summary>
    [HttpPost]
    public IActionResult PivotLogic([FromBody] EmotionMetrics metrics)
    {
        if (metrics is null)
            return BadRequest(new { error = "EmotionMetrics payload is required." });

        var result = Evaluate(metrics);
        return Json(result);
    }

    private static AdaptationResult Evaluate(EmotionMetrics m)
    {
        // Priority: Confusion > Doubt > Frustration > Steady-state
        if (m.Confusion > 0.75)
        {
            return new AdaptationResult
            {
                Strategy = "Simplification",
                NewSystemPrompt =
                    "The user appears confused. Shift to a simplification strategy: " +
                    "use high-level analogies, avoid jargon, break concepts into small steps, " +
                    "and check for understanding after each point."
            };
        }

        if (m.Doubt > 0.60)
        {
            return new AdaptationResult
            {
                Strategy = "Authority",
                NewSystemPrompt =
                    "The user sounds doubtful. Shift to an authority strategy: " +
                    "cite concrete data and sources, use a confident and reassuring tone, " +
                    "and proactively address likely objections."
            };
        }

        if (m.Frustration > 0.65)
        {
            return new AdaptationResult
            {
                Strategy = "De-escalation",
                NewSystemPrompt =
                    "The user is frustrated. Shift to a de-escalation strategy: " +
                    "acknowledge their frustration empathetically, slow down the pace, " +
                    "offer a concise summary, and ask how you can help most effectively."
            };
        }

        return new AdaptationResult
        {
            Strategy = "Baseline",
            NewSystemPrompt =
                "Continue with the current conversational approach. " +
                "Be clear, friendly, and helpful."
        };
    }
}
