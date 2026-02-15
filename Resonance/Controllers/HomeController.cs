using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Resonance.Models;
using Resonance.Services;

namespace Resonance.Controllers;

public class HomeController(PolicyEngine policyEngine) : Controller
{
    public IActionResult Index() => View();

    public IActionResult Dashboard() => View();

    public IActionResult About() => View();

    [HttpPost]
    public async Task<IActionResult> CreateConfig([FromBody] CreateConfigRequest request)
    {
        if (string.IsNullOrWhiteSpace(request?.ApiKey))
            return BadRequest(new { error = "API key is required." });

        using var http = new HttpClient();
        http.DefaultRequestHeaders.Add("X-Hume-Api-Key", request.ApiKey);

        await DeleteExistingConfigs(http, "Resonance Agent");

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

    [HttpPost]
    public IActionResult PivotLogic([FromBody] EmotionMetrics metrics)
    {
        if (metrics is null)
            return BadRequest(new { error = "EmotionMetrics payload is required." });

        return Json(policyEngine.Evaluate(metrics));
    }

    private static async Task DeleteExistingConfigs(HttpClient http, string configName)
    {
        var listResponse = await http.GetAsync("https://api.hume.ai/v0/evi/configs?page_size=100");
        if (!listResponse.IsSuccessStatusCode) return;

        var body = await listResponse.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);

        if (!doc.RootElement.TryGetProperty("configs_page", out var configs))
            return;

        foreach (var cfg in configs.EnumerateArray())
        {
            if (cfg.TryGetProperty("name", out var name) &&
                name.GetString() == configName &&
                cfg.TryGetProperty("id", out var id))
            {
                await http.DeleteAsync($"https://api.hume.ai/v0/evi/configs/{id.GetString()}");
            }
        }
    }
}
