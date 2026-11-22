const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json"
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: cors
  });

// Robust JSON extraction
function extractJSON(text) {
  if (!text || typeof text !== "string") return null;

  // Try direct parsing first
  try {
    return JSON.parse(text.trim());
  } catch {}

  // Remove markdown fences
  const cleaned = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  // Try cleaned text
  try {
    return JSON.parse(cleaned);
  } catch {}

  // Extract first balanced JSON object
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (start === -1) {
      if (ch === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;

      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);

        try {
          return JSON.parse(candidate);
        } catch {
          start = -1;
          depth = 0;
        }
      }
    }
  }

  return null;
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: cors
    });
  }

  if (req.method !== "POST") {
    return json(405, { error: "POST only" });
  }

  const key = process.env.ANTHROPIC_API_KEY;

  if (!key) {
    return json(500, {
      error: "ANTHROPIC_API_KEY is missing from Netlify environment variables."
    });
  }

  let data;

  try {
    data = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON request" });
  }

  if (!data?.formingCandle || !Array.isArray(data?.completedCandles)) {
    return json(400, {
      error: "Forming candle and completed candles are required."
    });
  }

  const prompt = `
You are CLAUDE LIVE SCAN, an independent OTC directional market analyst.

Your primary job is to identify the dominant short-term direction.

CALL = bullish upward expectation.
PUT = bearish downward expectation.
WAIT = no meaningful directional edge.

Do not default to WAIT.
When price action, momentum, and structure establish a dominant direction,
make a directional decision.

Analyze:

- Forming candle body and direction
- Candle body size relative to wick
- Recent completed candle sequence
- Consecutive bullish/bearish candles
- Momentum and acceleration
- Higher highs and higher lows
- Lower highs and lower lows
- Breakouts and breakdowns
- Support and resistance rejection
- Pullbacks and continuation
- Volatility
- Indicator confirmation
- Indicator conflicts
- Historical learning, if supplied

PRICE ACTION IS PRIMARY.

Indicators are supporting evidence. A single opposing indicator must not
automatically cancel a clear directional price-action setup.

CALL:
Choose CALL when bullish evidence outweighs bearish evidence.

PUT:
Choose PUT when bearish evidence outweighs bullish evidence.

WAIT:
Use only when the market is genuinely sideways, materially contradictory,
erratic, unreliable, or lacking meaningful directional evidence.

Do not require a perfect setup.
Do not demand every indicator to agree.
Do not mistake minor uncertainty for no direction.
Do not invent data or claim certainty.

EvidenceScore measures evidence strength, NOT win probability.

Suggested evidence score:
0-34: very weak
35-49: weak
50-64: moderate
65-79: strong
80-100: very strong

For directional signals, explain the strongest supporting factors and the
main opposing risk.

Choose holdSeconds from:
15, 30, 60, 180, 300, 900, 1800, 3600, 14400

Return ONLY one JSON object.
No markdown.
No code fences.
No text before or after the JSON.

Required exact schema:

{
  "signal": "CALL",
  "direction": "BULLISH",
  "evidenceScore": 65,
  "holdSeconds": 30,
  "summary": "Short directional summary",
  "reasoning": "Specific candle and momentum explanation",
  "confirmations": [],
  "conflicts": [],
  "riskFlags": [],
  "waitReason": ""
}

DATA SNAPSHOT:

${JSON.stringify(data)}
`;

  try {
    const model =
      process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

    const res = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: 1100,
          messages: [
            {
              role: "user",
              content: prompt
            }
          ]
        })
      }
    );

    const body = await res.json();

    if (!res.ok) {
      return json(res.status, {
        error: body?.error?.message || "Anthropic API error",
        type: body?.error?.type || "api_error",
        model,
        status: res.status
      });
    }

    const text = (body.content || [])
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("")
      .trim();

    // Detect truncation before parsing
    if (body.stop_reason === "max_tokens") {
      return json(502, {
        error: "Claude response was truncated by max_tokens.",
        model,
        stopReason: body.stop_reason,
        preview: text.slice(0, 500)
      });
    }

    let out = extractJSON(text);

    if (!out || typeof out !== "object" || Array.isArray(out)) {
      return json(502, {
        error: "Claude response could not be parsed as JSON.",
        model,
        stopReason: body.stop_reason || null,
        preview: text.slice(0, 700)
      });
    }

    // Validate signal
    const signals = ["CALL", "PUT", "WAIT"];

    if (!signals.includes(out.signal)) {
      return json(502, {
        error: "Claude returned an invalid signal.",
        model,
        signalReceived: out.signal ?? null,
        preview: text.slice(0, 500)
      });
    }

    // Direction normalization
    out.direction =
      out.signal === "CALL"
        ? "BULLISH"
        : out.signal === "PUT"
        ? "BEARISH"
        : "NEUTRAL";

    // Evidence score normalization
    out.evidenceScore = Math.max(
      0,
      Math.min(100, Number(out.evidenceScore) || 0)
    );

    // Hold duration validation
    const holds = [
      15, 30, 60, 180, 300,
      900, 1800, 3600, 14400
    ];

    out.holdSeconds = holds.includes(Number(out.holdSeconds))
      ? Number(out.holdSeconds)
      : 30;

    // Normalize arrays
    for (const k of [
      "confirmations",
      "conflicts",
      "riskFlags"
    ]) {
      if (!Array.isArray(out[k])) {
        out[k] = [];
      }
    }

    // Normalize text fields
    for (const k of [
      "summary",
      "reasoning",
      "waitReason"
    ]) {
      if (typeof out[k] !== "string") {
        out[k] = "";
      }
    }

    return json(200, {
      ...out,
      aiEngine: "Claude",
      paperOnly: true
    });

  } catch (e) {
    return json(502, {
      error: e?.message || "Claude request failed"
    });
  }
};
