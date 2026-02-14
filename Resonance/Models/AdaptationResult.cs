namespace Resonance.Models;

/// <summary>
/// The result returned by the Policy Engine after evaluating emotion metrics.
/// Contains the strategy name and the new system prompt to inject into Hume EVI.
/// </summary>
public sealed class AdaptationResult
{
    public required string Strategy { get; set; }
    public required string NewSystemPrompt { get; set; }
}
