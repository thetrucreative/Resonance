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

    /// <summary>Optional – top 5 emotions from the full prosody output.</summary>
    public List<EmotionScore>? TopEmotions { get; set; }

    /// <summary>Total number of turns in the current session so far.</summary>
    public int TurnIndex { get; set; }
}

public sealed class EmotionScore
{
    public string Name { get; set; } = "";
    public double Score { get; set; }
}
