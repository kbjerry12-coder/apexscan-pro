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

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
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
You are Claude acting as an independent OTC candle signal analyst.

Analyze the supplied:
- 30-second forming candle
- Completed candles
- Current price
- Indicator snapshot
- Market context
- Historical learning data, if supplied

Make your OWN directional decision.
Do not automatically copy the local indicator direction.

Return ONLY valid JSON with these keys:

{
  "signal": "CALL | PUT | WAIT",
  "direction": "BULLISH | BEARISH | NEUTRAL",
  "evidenceScore": 0,
  "holdSeconds": 30,
  "summary": "",
  "reasoning": "",
  "confirmations": [],
  "conflicts": [],
  "riskFlags": [],
  "waitReason": ""
}

RULES:

- CALL means upward expectation.
- PUT means downward expectation.
- WAIT means insufficient evidence.
- Evidence score is strength of evidence, NOT win probability.
- Favor WAIT when data is stale, incomplete, contradictory, choppy, or lacks a clear edge.
- Never invent missing data.
- Never claim certainty.
- Evaluate candle body and wick structure.
- Evaluate momentum and recent price structure.
- Evaluate volatility.
- Evaluate indicator confluence and conflicting indicators.
- Suggest a reasonable hold duration based on the evidence.
- Hold duration must be one of:
  15, 30, 60, 180, 300, 900, 1800, 3600, 14400 seconds.
- A hold duration is a suggestion, not a guarantee.

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
          temperature: 0.2,
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

    // Return actual Anthropic error for diagnosis
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
      .join("");

    let out;

    try {
      const cleaned = text
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, "")
        .trim();

      out = JSON.parse(cleaned);
    } catch {
      return json(502, {
        error: "Claude response was not valid JSON.",
        model,
        preview: text.slice(0, 300)
      });
    }

    // Validate signal
    const signals = ["CALL", "PUT", "WAIT"];

    if (!signals.includes(out.signal)) {
      out.signal = "WAIT";
    }

    // Normalize direction
    out.direction =
      out.signal === "CALL"
        ? "BULLISH"
        : out.signal === "PUT"
        ? "BEARISH"
        : "NEUTRAL";

    // Validate evidence score
    out.evidenceScore = Math.max(
      0,
      Math.min(100, Number(out.evidenceScore) || 0)
    );

    // Validate hold duration
    const holds = [
      15,
      30,
      60,
      180,
      300,
      900,
      1800,
      3600,
      14400
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

    // Normalize text
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
