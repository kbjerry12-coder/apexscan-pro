// APEXSCAN PRO · Claude Run Deep endpoint
// Requires ANTHROPIC_API_KEY in Netlify environment variables.

const ALLOWED_DIRECTIONS = new Set(["CALL", "PUT", "WAIT"]);
const ALLOWED_HOLDS = new Set([15, 30, 60, 120, 300]);

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  },
  body: JSON.stringify(body),
});

function extractJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) return null;

  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}

  // Extract first balanced JSON object.
  // Ignores braces inside quoted strings.
  const start = cleaned.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;

      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);

        try {
          const parsed = JSON.parse(candidate);
          if (
            parsed &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) {
            return parsed;
          }
        } catch {}

        return null;
      }
    }
  }

  return null;
}

async function callClaude({
  apiKey,
  model,
  system,
  messages,
  maxTokens = 700,
  timeoutMs = 25000,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
          max_tokens: maxTokens,
          system,
          messages,
        }),
        signal: controller.signal,
      }
    );

    const responseText = await upstream.text();

    let responseJson;

    try {
      responseJson = JSON.parse(responseText);
    } catch {
      return {
        ok: false,
        status: upstream.status,
        error: "Anthropic returned an unreadable API response.",
      };
    }

    if (!upstream.ok) {
      return {
        ok: false,
        status: upstream.status,
        error:
          responseJson?.error?.message ||
          "Anthropic API request failed",
      };
    }

    const raw = (responseJson.content || [])
      .filter((x) => x.type === "text")
      .map((x) => x.text || "")
      .join("\n")
      .trim();

    return {
      ok: true,
      raw,
      responseJson,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error?.name === "AbortError"
          ? "Claude request timed out."
          : error?.message || "Claude request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatDeepScan(o) {
  const lines = [
    `${o.direction} · Strength ${o.strength}/100 · Risk ${o.risk}`,
    o.reason,
    `Invalidation: ${o.invalidation}`,
  ];

  if (o.holdSeconds) lines.push(`Suggested hold: ${o.holdSeconds}s`);
  lines.push(`Caution: ${o.caution}`);

  return lines.filter(Boolean).join("\n\n");
}

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

  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return json(400, {
      error: "Request payload must be an object",
    });
  }

  // The HTML page sends `candles`; older callers send `recentCandles`.
  const rawCandles = Array.isArray(input.recentCandles)
    ? input.recentCandles
    : Array.isArray(input.candles)
    ? input.candles
    : [];

  const candles = rawCandles.slice(-40);

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

  const num = (v) =>
    v == null || v === ""
      ? null
      : Number.isFinite(Number(v))
      ? Number(v)
      : null;

  const ind =
    input.indicators && typeof input.indicators === "object"
      ? input.indicators
      : {};

  const payload = {
    pair: String(
      input.pair || input.symbol || "Unknown pair"
    ).slice(0, 80),

    symbol: String(input.symbol || "").slice(0, 80),

    market: String(input.market || "OTC").slice(0, 30),

    timeframe: String(
      input.scanTimeframe ||
        (num(input.timeframe) > 0
          ? `${num(input.timeframe)}-second candles`
          : "30-second candles")
    ).slice(0, 40),

    requestedHoldSeconds: num(input.hold_seconds ?? input.holdSeconds),

    indicators: {
      macd: num(ind.macd),
      macdSignal: num(ind.macdSignal),
      stochasticK: num(ind.stochasticK),
      stochasticD: num(ind.stochasticD),
      ema9: num(ind.ema9),
      ema21: num(ind.ema21),
      bollinger: Array.isArray(ind.bollinger)
        ? ind.bollinger.slice(0, 3).map(num)
        : null,
    },

    forecast: String(
      input.forecast || "next candle"
    ).slice(0, 60),

    price: num(input.price) ?? safeCandles[safeCandles.length - 1].close,

    localDirection: ALLOWED_DIRECTIONS.has(
      input.localDirection
    )
      ? input.localDirection
      : "WAIT",

    localScore: Math.max(
      0,
      Math.min(
        100,
        Math.round(Number(input.localScore) || 0)
      )
    ),

    candleBody: String(
      input.candleBody || ""
    ).slice(0, 80),

    bodyPercent: Math.max(
      0,
      Math.min(
        100,
        Math.round(Number(input.bodyPercent) || 0)
      )
    ),

    wickStructure: String(
      input.wickStructure || ""
    ).slice(0, 100),

    momentum: String(
      input.momentum || ""
    ).slice(0, 50),

    volumeRatio: Number.isFinite(
      Number(input.volumeRatio)
    )
      ? Number(input.volumeRatio)
      : null,

    riskAssessment: String(
      input.riskAssessment || ""
    ).slice(0, 100),

    indicatorLayers: Array.isArray(input.indicatorLayers)
      ? input.indicatorLayers
          .slice(0, 12)
          .map((x) => ({
              name: String(x.name || "").slice(0, 60),
              value: String(x.value || "").slice(0, 100),
              bull: !!x.bull,
              bear: !!x.bear,
            }))
      : [],

    candles: safeCandles,
  };

  const system = `You are Claude acting as an independent market-structure analyst for APEXSCAN PRO.

Analyze supplied OTC candles and indicators:
- Candle direction and body strength
- Wicks and rejection
- Momentum
- RSI
- Stochastic
- CCI
- MACD
- Support and resistance
- Candle patterns
- Trend continuation versus reversal
- Indicator agreement and disagreement
- Setup reliability

Use only the indicators actually supplied (this page supplies MACD, Stochastic,
Bollinger bands and EMA 9/21). Never invent RSI, CCI or other values that were
not supplied. If requestedHoldSeconds is supplied, judge direction over that
holding window.

Do not blindly follow the local scanner.
Independently analyze the supplied data.

This is analysis only. Do not claim certainty or guaranteed wins.
If evidence is mixed or insufficient, choose WAIT.

Return ONE JSON object only. No markdown and no extra text.

Use exactly these keys:
{
  "direction": "CALL | PUT | WAIT",
  "strength": 0,
  "reason": "Short analysis",
  "risk": "Low | Moderate | High",
  "invalidation": "What invalidates this analysis",
  "holdSeconds": 15,
  "caution": "Risk or limitation"
}

Rules:
- strength must be an integer from 0 to 100.
- holdSeconds must be 15, 30, 60, 120, 300, or null.
- Do not return markdown.
- Do not add text outside the JSON.`;

  const userPrompt = `Analyze this live market snapshot:

${JSON.stringify(payload)}

Return the required JSON object only.`;

  const model =
    process.env.ANTHROPIC_MODEL ||
    "claude-sonnet-5-5";

  try {
    // First request: normal analysis.
    const first = await callClaude({
      apiKey,
      model,
      system,
      messages: [
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    if (!first.ok) {
      return json(
        first.status >= 500
          ? 502
          : first.status || 502,
        {
          error:
            first.error ||
            "Claude Deep Scan failed",
        }
      );
    }

    let result = extractJsonObject(first.raw);
    let repairAttempted = false;

    // Retry only when the output format is invalid.
    // Normal valid scans do not incur another request.
    if (!result) {
      repairAttempted = true;

      const repair = await callClaude({
        apiKey,
        model,
        maxTokens: 500,
        timeoutMs: 15000,

        system:
          "You are a strict JSON repair service. " +
          "Convert the supplied Claude analysis into one valid " +
          "JSON object matching the required schema. " +
          "Do not add new market claims. " +
          "If a field is missing, use conservative defaults. " +
          "Return only JSON.",

        messages: [
          {
            role: "user",
            content: `Repair/format this response as valid JSON with keys:
direction (CALL/PUT/WAIT),
strength (0-100 integer),
reason,
risk (Low/Moderate/High),
invalidation,
holdSeconds (15/30/60/120/300/null),
caution.

Preserve the analysis meaning.
Do not invent evidence.

Original response:
${first.raw}`,
          },
        ],
      });

      if (repair.ok) {
        result = extractJsonObject(repair.raw);
      }
    }

    if (!result) {
      return json(502, {
        error:
          "Claude response could not be converted to valid JSON after one repair attempt.",
        repairAttempted,
        detail:
          "No directional forecast was issued because the response format could not be validated.",
      });
    }

    const direction = String(
      result.direction || ""
    ).toUpperCase();

    if (!ALLOWED_DIRECTIONS.has(direction)) {
      return json(502, {
        error: "Claude returned an invalid direction",
        repairAttempted,
      });
    }

    const strength = Math.max(
      0,
      Math.min(
        100,
        Math.round(Number(result.strength) || 0)
      )
    );

    const hold = Number(result.holdSeconds);

    const out = {
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

      holdSeconds: ALLOWED_HOLDS.has(hold)
        ? hold
        : null,

      caution: String(
        result.caution ||
          "AI analysis is uncertain and is not a guarantee."
      ).slice(0, 300),

      model,
      repairAttempted,
    };

    // The HTML page shows `deepScan` as plain text.
    return json(200, { ...out, deepScan: formatDeepScan(out) });
  } catch (error) {
    return json(502, {
      error:
        error?.message ||
        "Claude Deep Scan could not complete",
    });
  }
}
