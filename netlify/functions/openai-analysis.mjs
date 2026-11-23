// APEXSCAN PRO — OpenAI Auto Analysis
// Early + Regular signals
// Requires OPENAI_API_KEY in Netlify environment variables

const MODEL = process.env.OPENAI_MODEL || "gpt-6";

const ALLOWED_HOLDS = [15, 30, 60, 180, 300, 900, 1800, 3600, 14400];

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(body),
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeDirection(value) {
  const direction = String(value || "WAIT").toUpperCase();
  return ["CALL", "PUT", "WAIT"].includes(direction) ? direction : "WAIT";
}

function normalizeHold(value) {
  const hold = Number(value);
  return ALLOWED_HOLDS.includes(hold) ? hold : 60;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.slice(0, 8).map(String);
  return [];
}

function normalizeAnalysis(value = {}) {
  return {
    bullishEvidence: normalizeArray(value.bullishEvidence),
    bearishEvidence: normalizeArray(value.bearishEvidence),
    momentum: String(value.momentum || "Unclear"),
    trend: String(value.trend || "Unclear"),
    candleStructure: String(value.candleStructure || "Unclear"),
    chartPattern: String(value.chartPattern || "No confirmed pattern"),
    conflicts: normalizeArray(value.conflicts),
    riskFlags: normalizeArray(value.riskFlags),
    reasoning: String(value.reasoning || ""),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "POST only" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "OPENAI_API_KEY is missing" });
  }

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON request body" });
  }

  const candles = Array.isArray(input.completedCandles)
    ? input.completedCandles.slice(-60)
    : [];

  const payload = {
    scanType: input.scanType || "REGULAR",
    pair: input.pair || "UNKNOWN",
    timeframe: input.timeframe || "1m",
    timeframeSeconds: Number(input.timeframeSeconds) || null,
    livePrice: input.livePrice ?? null,
    priceTimestamp: input.priceTimestamp || null,
    candleTimestamp: input.candleTimestamp || null,
    formingCandle: input.formingCandle || null,
    formingCandleAgeSeconds:
      input.formingCandleAgeSeconds ?? null,
    indicators: input.indicators || {},
    ruleSignal: input.ruleSignal || null,
    marketStructure: input.marketStructure || null,
    completedCandles: candles,
  };

  const system = `
You are the primary market-analysis brain for APEXSCAN PRO.

Analyze the provided OTC market data and chart structure.
Do not impose artificial confirmation delays.
When a newly forming candle is supplied, analyze the developing market
structure and provide an early signal when the evidence supports one.

Analyze:
- Bullish and bearish evidence
- Momentum and directional strength
- Trend and market structure
- Candle formations and chart patterns
- Support/resistance reactions if data supports them
- Conflicting evidence
- Risk flags and uncertainty

Respect scanType:
EARLY = analyze the developing candle and emerging structure.
REGULAR = analyze the latest market context for the next move.

Do not fabricate candles, prices, indicators, or timestamps.
Do not claim the price is live if its timestamp is stale.
Do not force a trade if evidence is weak or conflicting.

If the evidence is insufficient, return WAIT.
WAIT must remain WAIT. Never disguise WAIT as CALL or PUT.

Return ONLY valid JSON in this schema:
{
  "direction": "CALL|PUT|WAIT",
  "evidenceScore": 0,
  "bullishEvidence": [],
  "bearishEvidence": [],
  "momentum": "",
  "trend": "",
  "candleStructure": "",
  "chartPattern": "",
  "conflicts": [],
  "riskFlags": [],
  "reasoning": "",
  "holdSeconds": 60
}

Allowed holdSeconds:
15,30,60,180,300,900,1800,3600,14400.
`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return json(response.status, {
        error: data?.error?.message || `OpenAI HTTP ${response.status}`,
      });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return json(502, { error: "OpenAI returned an empty analysis" });
    }

    const parsed = JSON.parse(content);
    const direction = normalizeDirection(parsed.direction);
    const analysis = normalizeAnalysis(parsed);

    return json(200, {
      model: data.model || MODEL,
      scanType: payload.scanType,
      pair: payload.pair,
      timeframe: payload.timeframe,
      priceTimestamp: payload.priceTimestamp,
      candleTimestamp: payload.candleTimestamp,
      signal: {
        direction,
        evidenceScore: clamp(
          Math.round(Number(parsed.evidenceScore) || 0),
          0,
          100
        ),
        reasoning: analysis.reasoning,
        holdSeconds: normalizeHold(parsed.holdSeconds),
        analysis,
      },
    });
  } catch (error) {
    return json(500, {
      error: String(error?.message || error),
    });
  }
};
