# Resonance

Adaptive AI conversational agent that detects emotional cues in real-time and self-corrects its behavior to maintain productive dialogue.

**Live demo:** http://resonance.rateflowapp.com/

---

## What It Does

Resonance connects to [Hume EVI](https://www.hume.ai/) (Empathic Voice Interface) and analyzes the prosody (vocal tone, pitch, rhythm) of each speaker turn. When it detects rising confusion, doubt, or frustration, a server-side policy engine evaluates the emotional trajectory and pivots the AI's conversational strategy in real-time -- without the user needing to ask for help.

### The Feedback Loop

```
User speaks
    |
    v
Hume EVI transcribes + returns prosody scores (48 emotions)
    |
    v
Browser extracts confusion, doubt, frustration metrics
    |
    v
.NET Policy Engine evaluates thresholds + rolling momentum
    |
    v
Strategy pivot decision (Simplification / Authority / De-escalation / etc.)
    |
    v
New system prompt injected into Hume EVI via session_settings
    |
    v
AI adapts its next response accordingly
```

### Strategy Catalog

| Strategy | Trigger | What Changes |
|---|---|---|
| Baseline | No distress detected | Standard empathetic assistant |
| Simplification | Confusion above threshold | Shorter sentences, step-by-step, plain language |
| Authority | Doubt above threshold | Confident tone, evidence-backed, decisive |
| De-escalation | Frustration above threshold | Acknowledgment, calm pacing, solution-focused |
| Engagement | Composite distress (blended) | Warm check-ins, open questions |
| Proactive | Trend rising across turns | Pre-emptive clarification before distress peaks |

## Architecture

```
Resonance/
  Controllers/
    HomeController.cs        # MVC routes + Hume config API proxy + pivot endpoint
  Services/
    PolicyEngine.cs          # Stateful strategy evaluator with rolling momentum
  Models/
    EmotionMetrics.cs        # Prosody-derived scores sent from browser
    AdaptationResult.cs      # Strategy + new system prompt returned to browser
  Views/
    Home/
      Index.cshtml           # Live Agent page (connect, monitor, adapt)
      Dashboard.cshtml       # Analytics dashboard (transcript, pivots, charts)
      About.cshtml           # Project overview
    Shared/
      _Layout.cshtml         # Shared layout with sticky header + hamburger menu
  wwwroot/
    js/
      app.js                 # Application orchestrator
      modules/
        AudioManager.js      # Microphone capture, PCM encoding, playback
        HumeClient.js        # WebSocket connection to Hume EVI
        MeetCapture.js       # Google Meet tab audio capture + speaker profiling
        EmotionTracker.js    # Metric extraction, event persistence, backend calls
    css/
      site.css               # Card-based dark theme
```

### Tech Stack

- ASP.NET Core MVC (.NET 10)
- Hume AI EVI v3 (WebSocket, prosody analysis)
- Web Audio API (microphone + tab capture)
- Vanilla JavaScript (ES modules, no framework)
- CSS Grid card-based layout

## Getting Started

### Prerequisites

- .NET 10 SDK
- A Hume AI API key (get one at https://www.hume.ai/)

### Run Locally

```bash
cd Resonance
dotnet run
```

Open https://localhost:7077 (or the port shown in console output).

1. Enter your Hume API key
2. Click **Connect** -- a config is auto-created if you leave Config ID blank
3. Speak into your microphone
4. Watch emotion scores update in real-time
5. Open the **Analytics Dashboard** from the hamburger menu to see the full transcript

### Google Meet Integration

1. Connect to Hume on the Live Agent page
2. Open Google Meet in a separate browser tab
3. Click **Capture Meet Audio** (enable this panel from the hamburger menu)
4. Select the Meet tab and check **Share tab audio**
5. Remote speakers are profiled and labeled automatically (Customer 1, Customer 2, etc.)

## Dashboard

The analytics dashboard auto-refreshes every 3 seconds and displays:

- **Session Summary** -- total turns, average confusion/doubt/frustration, strategy pivot count
- **Participants** -- per-speaker emotion breakdown (Agent, AI Assistant, Customer N)
- **Transcript Feed** -- conversation-style cards with speaker, transcript, top emotion, and metrics
- **Self-Correction Log** -- every strategy pivot with severity, reasoning, and trigger scores
- **Emotion Timeline** -- per-turn bar chart of confusion, doubt, frustration
- **Dominant Emotions** -- top 10 emotions aggregated across the session

All data is stored in `localStorage` and can be exported to CSV.

## How the Policy Engine Works

The `PolicyEngine` is a stateful singleton that maintains a rolling window of the last 10 turns. On each turn it:

1. Records the new metrics into the history buffer
2. Computes momentum -- rolling averages and trend direction (rising / stable / falling)
3. Evaluates a priority-ordered rule chain:
   - Frustration rules fire first (most urgent)
   - Then confusion, doubt, composite blend, and proactive trend detection
4. Returns a strategy name, severity level, reasoning string, and a new system prompt
5. The browser injects the new prompt into Hume EVI via `session_settings`

Thresholds are calibrated to realistic Hume prosody score ranges (typically 0.01 - 0.20 for conversational speech).

## Deployment

The project includes a publish profile for SmartASP.NET hosting. To deploy:

```bash
dotnet publish -c Release
```

Docker is also supported via the included `.dockerignore` and project configuration.

## License

This project was built for the Ruya AI Hackathon.
