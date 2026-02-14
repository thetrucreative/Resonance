namespace Resonance.Models;

/// <summary>
/// Prosody-derived emotion scores extracted from Hume EVI user_message events.
/// Each score is in the range [0.0, 1.0].
/// </summary>
public sealed class EmotionMetrics
{
    public double Confusion { get; set; }
    public double Doubt { get; set; }
    public double Frustration { get; set; }
}
