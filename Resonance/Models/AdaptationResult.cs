namespace Resonance.Models;

/// <summary>
/// The result returned by the Policy Engine after evaluating emotion metrics.
/// Contains the strategy name, the new system prompt to inject into Hume EVI,
/// and diagnostic reasoning for the self-correction log.
/// </summary>
public sealed class AdaptationResult
{
    public required string Strategy { get; set; }
    public required string NewSystemPrompt { get; set; }

    /// <summary>Human-readable explanation of why this strategy was chosen.</summary>
    public string Reasoning { get; set; } = "";

    /// <summary>Severity: "none" | "low" | "moderate" | "high".</summary>
    public string Severity { get; set; } = "none";
}
