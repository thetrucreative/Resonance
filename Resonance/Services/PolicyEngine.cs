namespace Resonance.Services;

using Resonance.Models;

/// <summary>
/// Adaptive policy engine that evaluates prosody-derived emotion metrics
/// and returns conversation strategy adjustments.
///
/// Uses realistic thresholds calibrated to Hume EVI score ranges (0.01–0.20),
/// rolling momentum tracking across turns, and multi-emotion blending.
/// </summary>
public sealed class PolicyEngine
{
    private readonly List<EmotionMetrics> _history = new();
    private readonly Lock _lock = new();

    private const int MaxHistory = 10;
    private const double FrustrationThreshold = 0.10;
    private const double FrustrationAvgThreshold = 0.08;
    private const double ConfusionThreshold = 0.08;
    private const double ConfusionAvgThreshold = 0.06;
    private const double DoubtThreshold = 0.05;
    private const double DoubtAvgThreshold = 0.04;
    private const double CompositeThreshold = 0.04;
    private const double TrendWarningThreshold = 0.05;

    public AdaptationResult Evaluate(EmotionMetrics metrics)
    {
        RecordTurn(metrics);

        var momentum = ComputeMomentum();
        var dominantEmotion = GetDominantEmotion(metrics);

        return EvaluateStrategy(metrics, momentum, dominantEmotion);
    }

    private void RecordTurn(EmotionMetrics metrics)
    {
        lock (_lock)
        {
            _history.Add(metrics);
            if (_history.Count > MaxHistory)
                _history.RemoveAt(0);
        }
    }

    private AdaptationResult EvaluateStrategy(
        EmotionMetrics m,
        MomentumSnapshot momentum,
        string dominantEmotion)
    {
        if (m.Frustration > FrustrationThreshold || momentum.AvgFrustration > FrustrationAvgThreshold)
            return BuildDeEscalation(m, momentum, dominantEmotion);

        if (m.Confusion > ConfusionThreshold || momentum.AvgConfusion > ConfusionAvgThreshold)
            return BuildSimplification(m, momentum, dominantEmotion);

        if (m.Doubt > DoubtThreshold || momentum.AvgDoubt > DoubtAvgThreshold)
            return BuildAuthority(m, momentum, dominantEmotion);

        double composite = m.Confusion * 0.4 + m.Doubt * 0.3 + m.Frustration * 0.3;
        if (composite > CompositeThreshold)
            return BuildEngagement(m, momentum, dominantEmotion, composite);

        if (momentum.Trend == "rising" &&
            momentum.AvgConfusion + momentum.AvgDoubt + momentum.AvgFrustration > TrendWarningThreshold)
            return BuildProactive(momentum, dominantEmotion);

        return BuildBaseline(m, dominantEmotion);
    }

    private MomentumSnapshot ComputeMomentum()
    {
        lock (_lock)
        {
            if (_history.Count == 0)
                return MomentumSnapshot.Empty;

            double avgC = _history.Average(h => h.Confusion);
            double avgD = _history.Average(h => h.Doubt);
            double avgF = _history.Average(h => h.Frustration);
            string trend = "stable";

            if (_history.Count >= 4)
            {
                int half = _history.Count / 2;
                double firstHalf = _history.Take(half).Average(h => h.Confusion + h.Doubt + h.Frustration);
                double secondHalf = _history.Skip(half).Average(h => h.Confusion + h.Doubt + h.Frustration);
                double delta = secondHalf - firstHalf;
                trend = delta > 0.01 ? "rising" : delta < -0.01 ? "falling" : "stable";
            }

            return new MomentumSnapshot(avgC, avgD, avgF, trend);
        }
    }

    private static string GetDominantEmotion(EmotionMetrics m)
    {
        if (m.TopEmotions is { Count: > 0 })
            return m.TopEmotions[0].Name;

        if (m.Confusion >= m.Doubt && m.Confusion >= m.Frustration) return "Confusion";
        if (m.Doubt >= m.Frustration) return "Doubt";
        return "Frustration";
    }

    // ── Strategy builders ──────────────────────────────────────────

    private static AdaptationResult BuildDeEscalation(
        EmotionMetrics m, MomentumSnapshot momentum, string dominant) => new()
    {
        Strategy = "De-escalation",
        Severity = "high",
        Reasoning = $"Frustration at {m.Frustration:P1} (avg {momentum.AvgFrustration:P1}, trend {momentum.Trend}). " +
                    $"Dominant: {dominant}.",
        NewSystemPrompt =
            "IMPORTANT BEHAVIORAL SHIFT: The speaker is showing frustration. " +
            "Immediately acknowledge their frustration with empathy. " +
            "Slow down your pace. Use shorter sentences. " +
            "Offer a concise summary of what you've covered so far. " +
            "Ask one clear question about how you can help most effectively. " +
            "Do NOT repeat information they've already heard."
    };

    private static AdaptationResult BuildSimplification(
        EmotionMetrics m, MomentumSnapshot momentum, string dominant) => new()
    {
        Strategy = "Simplification",
        Severity = momentum.AvgConfusion > 0.08 ? "high" : "moderate",
        Reasoning = $"Confusion at {m.Confusion:P1} (avg {momentum.AvgConfusion:P1}, trend {momentum.Trend}). " +
                    $"Dominant: {dominant}.",
        NewSystemPrompt =
            "IMPORTANT BEHAVIORAL SHIFT: The speaker appears confused. " +
            "Switch to a simplification strategy immediately: " +
            "use plain language and real-world analogies, avoid all jargon, " +
            "break your response into numbered steps (max 3 at a time), " +
            "and pause to check understanding before continuing. " +
            "If they asked a question, answer it directly first, then explain."
    };

    private static AdaptationResult BuildAuthority(
        EmotionMetrics m, MomentumSnapshot momentum, string dominant) => new()
    {
        Strategy = "Authority",
        Severity = momentum.AvgDoubt > 0.06 ? "moderate" : "low",
        Reasoning = $"Doubt at {m.Doubt:P1} (avg {momentum.AvgDoubt:P1}, trend {momentum.Trend}). " +
                    $"Dominant: {dominant}.",
        NewSystemPrompt =
            "IMPORTANT BEHAVIORAL SHIFT: The speaker sounds uncertain or doubtful. " +
            "Shift to an authority strategy: cite specific data or examples, " +
            "use a confident and reassuring tone, proactively address the most " +
            "likely objection, and reinforce what you know is correct. " +
            "If you're unsure about something, be transparent about it."
    };

    private static AdaptationResult BuildEngagement(
        EmotionMetrics m, MomentumSnapshot momentum, string dominant, double composite) => new()
    {
        Strategy = "Engagement",
        Severity = "low",
        Reasoning = $"Mixed signals: composite={composite:F3} " +
                    $"(C={m.Confusion:P1} D={m.Doubt:P1} F={m.Frustration:P1}). " +
                    $"Dominant: {dominant}.",
        NewSystemPrompt =
            "The speaker is showing mixed low-level signals of disengagement. " +
            "Increase engagement: ask a brief clarifying question, " +
            "use their name if known, offer a relevant example, " +
            "and keep responses concise and actionable."
    };

    private static AdaptationResult BuildProactive(MomentumSnapshot momentum, string dominant) => new()
    {
        Strategy = "Proactive",
        Severity = "low",
        Reasoning = $"Trend {momentum.Trend} (avgC={momentum.AvgConfusion:P1} avgD={momentum.AvgDoubt:P1} " +
                    $"avgF={momentum.AvgFrustration:P1}). Dominant: {dominant}.",
        NewSystemPrompt =
            "Subtle signs suggest the conversation may be heading toward difficulty. " +
            "Proactively check in: briefly summarize what you've discussed, " +
            "ask if anything needs clarification, and offer to approach the topic differently."
    };

    private static AdaptationResult BuildBaseline(EmotionMetrics m, string dominant) => new()
    {
        Strategy = "Baseline",
        Severity = "none",
        Reasoning = $"Normal range (C={m.Confusion:P1} D={m.Doubt:P1} F={m.Frustration:P1}). " +
                    $"Dominant: {dominant}.",
        NewSystemPrompt =
            "Continue with the current conversational approach. " +
            "Be clear, friendly, and helpful."
    };
}

/// <summary>Point-in-time snapshot of rolling emotion averages and trend direction.</summary>
public readonly record struct MomentumSnapshot(
    double AvgConfusion,
    double AvgDoubt,
    double AvgFrustration,
    string Trend)
{
    public static readonly MomentumSnapshot Empty = new(0, 0, 0, "stable");
}
