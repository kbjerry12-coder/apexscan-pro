// APEXSCAN PRO · Claude Run Deep endpoint
// Requires ANTHROPIC_API_KEY in Netlify environment variables.
// Optional ANTHROPIC_MODEL lets you choose a supported model.

const ALLOWED_DIRECTIONS = new Set(["CALL", "PUT", "WAIT"]);
const ALLOWED_HOLDS = new Set([15, 30, 60]);

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  },
  body: JSON.stringify(body),
});

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return json(500, {
      error: "ANTHROPIC_API_KEY is not configured in Netlify.",
    });
  }

  let input;

  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON request body" });
  }

  if (!input || typeof input !== "object") {
    return json(400, {
      error: "Request payload must be an object",
    });
  }

  const candles = Array.isArray(input.recentCandles)
    ? input.recentCandles.slice(-40)
    : [];

  if (candles.length < 8) {
    return json(400, {
      error: "At least 8 recent candles are required",
    });
  }

  const safeCandles = candles
    .map((c) => ({
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number.isFinite(Number(c.volume))
        ? Number(c.volume)
        : null,
    }))
    .filter((c) =>
      [c.open, c.high, c.low, c.close].every(Number.isFinite)
    );

  if (safeCandles.length < 8) {
    return json(400, {
      error: "Candle data is incomplete or invalid",
    });
  }

  const payload = {
    pair: String(input.pair || input.symbol || "Unknown pair").slice(0, 80),
    symbol: String(input.symbol || "").slice(0, 80),
    market: String(input.market || "OTC").slice(0, 30),
    timeframe: String(input.scanTimeframe || "30-second candles").slice(0, 40),
    forecast: String(input.forecast || "next candle").slice(0, 60),
    price: Number(input.price),

    localDirection: ALLOWED_DIRECTIONS.has(input.localDirection)
      ? input.localDirection
      : "WAIT",

    localScore: Math.max(
      0,
      Math.min(100, Math.round(Number(input.localScore) || 0))
    ),

    candleBody: String(input.candleBody || "").slice(0, 80),

    bodyPercent: Math.max(
      0,
      Math.min(100, Math.round(Number(input.bodyPercent) || 0))
    ),

    wickStructure: String(input.wickStructure || "").slice(0, 100),
    momentum: String(input.momentum || "").slice(0, 50),

    volumeRatio: Number.isFinite(Number(input.volumeRatio))
      ? Number(input.volumeRatio)
      : null,

    riskAssessment: String(input.riskAssessment || "").slice(0, 100),

    indicatorLayers: Array.isArray(input.indicatorLayers)
      ? input.indicatorLayers.slice(0, 12).map((x) => ({
          name: String(x.name || "").slice(0, 60),
          value: String(x.value || "").slice(0, 100),
          bull: !!x.bull,
          bear: !!x.bear,
        }))
      : [],

    candles: safeCandles,
  };

  const system = `
You are Claude acting as an independent market-structure analyst
for APEXSCAN PRO.

Analyze the supplied OTC candle snapshot and technical indicators.

Consider:
- Candle direction and body strength
- Upper and lower wick rejection
- Momentum and momentum changes
- RSI
- Stochastic
- CCI
- MACD
- Support and resistance
- Recent candle patterns
- Trend continuation versus reversal
- Indicator agreement and disagreement
- Whether the setup is weak, noisy, or unreliable

Do not blindly follow the local scanner's direction.
Independently analyze the supplied data.

This is analysis only. Do not claim certainty.
Never describe strength as a guaranteed win probability.
If evidence is mixed or insufficient, choose WAIT.

Return ONLY valid JSON using this exact structure:

{
  "direction": "CALL | PUT | WAIT",
  "strength": 0,
  "reason": "Short analysis",
  "risk": "Low | Moderate | High",
  "invalidation": "What would invalidate this analysis",
  "holdSeconds": 15,
  "caution": "Risk or limitation"
}

strength must be an integer from 0 to 100.

holdSeconds must be 15, 30, 60, or null.

Do not return markdown.
Do not add text outside the JSON.
`;

  const userPrompt = `
Analyze this live market snapshot:

${JSON.stringify(payload)}

Return the JSON object exactly in the required schema.
`;

  const model =
    process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

  try {
    const upstream = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 700,
          temperature: 0.2,
          system,
          messages: [
            {
              role: "user",
              content: userPrompt,
            },
          ],
        }),
      }
    );

    const responseText = await upstream.text();

    if (!upstream.ok) {
      let errMsg = "Anthropic API request failed";

      try {
        errMsg =
          JSON.parse(responseText)?.error?.message || errMsg;
      } catch {}

      return json(
        upstream.status >= 500 ? 502 : upstream.status,
        { error: errMsg }
      );
    }

    let responseJson;

    try {
      responseJson = JSON.parse(responseText);
    } catch {
      return json(502, {
        error: "Unexpected response from Anthropic API",
      });
    }

    const raw = (responseJson.content || [])
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("\n")
      .trim();

    let result;

    try {
      result = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);

      if (!match) {
        return json(502, {
          error: "Claude returned non-JSON output",
        });
      }

      try {
        result = JSON.parse(match[0]);
      } catch {
        return json(502, {
          error: "Claude response JSON could not be parsed",
        });
      }
    }

    const direction = String(result.direction || "").toUpperCase();

    if (!ALLOWED_DIRECTIONS.has(direction)) {
      return json(502, {
        error: "Claude returned an invalid direction",
      });
    }

    const strength = Math.max(
      0,
      Math.min(100, Math.round(Number(result.strength) || 0))
    );

    const hold = Number(result.holdSeconds);

    return json(200, {
      direction,
      strength,

      reason: String(
        result.reason || "No reasoning provided"
      ).slice(0, 900),

      risk: String(
        result.risk || "Unspecified"
      ).slice(0, 160),

      invalidation: String(
        result.invalidation || "Not clear"
      ).slice(0, 220),

      holdSeconds: ALLOWED_HOLDS.has(hold) ? hold : null,

      caution: String(
        result.caution ||
          "AI analysis is uncertain and is not a guarantee."
      ).slice(0, 300),

      model,
    });
  } catch (error) {
    return json(502, {
      error:
        error?.message ||
        "Claude Deep Scan could not complete",
    });
  }
}
