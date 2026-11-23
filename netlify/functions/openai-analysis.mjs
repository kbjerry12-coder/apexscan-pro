// APEXSCAN PRO — Fast Directional Market Brain
// Netlify function: netlify/functions/openai-analysis.mjs
// Keltner Channel + ADX + Donchian Channel
// Directional AI — no directional fallback on AI failure

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

const ALLOWED_HOLDS = [15, 30, 60, 180, 300, 900, 1800, 3600, 14400];

const reply = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const ema = (arr, period) => {
  if (!arr.length) return [];
  const alpha = 2 / (period + 1);
  const out = [arr[0]];

  for (let i = 1; i < arr.length; i++) {
    out.push(arr[i] * alpha + out[i - 1] * (1 - alpha));
  }

  return out;
};

// ================================
// INDICATOR CALCULATIONS
// ================================
function indicators(candles) {
  const close = candles.map(x => Number(x.close));
  const high = candles.map(x => Number(x.high));
  const low = candles.map(x => Number(x.low));

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 0; i < candles.length; i++) {
    const prevClose = i ? close[i - 1] : close[i];
    const up = i ? high[i] - high[i - 1] : 0;
    const down = i ? low[i - 1] - low[i] : 0;

    tr.push(Math.max(
      high[i] - low[i],
      Math.abs(high[i] - prevClose),
      Math.abs(low[i] - prevClose)
    ));

    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }

  const atr = ema(tr, 14);
  const middle = ema(close, 20);

  const upper = middle.map((v, i) => v + 1.5 * (atr[i] || 0));
  const lower = middle.map((v, i) => v - 1.5 * (atr[i] || 0));

  const window = Math.min(20, candles.length);
  const donchianHigh = Math.max(...high.slice(-window));
  const donchianLow = Math.min(...low.slice(-window));

  const plusDI = plusDM.map((v, i) =>
    atr[i] ? 100 * v / atr[i] : 0
  );

  const minusDI = minusDM.map((v, i) =>
    atr[i] ? 100 * v / atr[i] : 0
  );

  const dx = plusDI.map((v, i) =>
    v + minusDI[i] === 0
      ? 0
      : 100 * Math.abs(v - minusDI[i]) / (v + minusDI[i])
  );

  const adxSeries = ema(dx, 14);
  const last = close.length - 1;
  const previous = Math.max(0, last - 1);

  const price = close[last];

  return {
    price,
    atr: atr[last],

    keltner: {
      mid: middle[last],
      upper: upper[last],
      lower: lower[last],
      position:
        upper[last] !== lower[last]
          ? (price - lower[last]) / (upper[last] - lower[last])
          : 0,
      midSlope: middle[last] - middle[previous]
    },

    adx: {
      value: adxSeries[last] || 0,
      plusDI: plusDI[last] || 0,
      minusDI: minusDI[last] || 0
    },

    donchian: {
      high: donchianHigh,
      low: donchianLow,
      range: donchianHigh - donchianLow,
      position:
        donchianHigh !== donchianLow
          ? (price - donchianLow) / (donchianHigh - donchianLow)
          : 0
    },

    priceChange: price - close[previous],
    changePct: close[previous]
      ? 100 * (price - close[previous]) / close[previous]
      : 0
  };
}

// ================================
// LOCAL INDICATOR BIAS
// Used as analytical context only.
// Never issued as a fallback signal.
// ================================
function localBias(candles, ind) {
  const last = candles.at(-1);
  const previous = candles.at(-2);
  const price = Number(last.close);

  let score = 0;
  const evidence = [];

  // Candle direction
  if (last.close > last.open) {
    score += 1.2;
    evidence.push("Latest candle bullish");
  } else if (last.close < last.open) {
    score -= 1.2;
    evidence.push("Latest candle bearish");
  }

  // Price movement
  if (previous) {
    if (last.close > previous.close) {
      score += 0.8;
      evidence.push("Price rising");
    } else if (last.close < previous.close) {
      score -= 0.8;
      evidence.push("Price falling");
    }
  }

  // ADX directional movement
  if (ind.adx.plusDI > ind.adx.minusDI) {
    score += 1;
    evidence.push("+DI exceeds -DI");
  } else if (ind.adx.minusDI > ind.adx.plusDI) {
    score -= 1;
    evidence.push("-DI exceeds +DI");
  }

  // Keltner direction
  if (ind.keltner.midSlope > 0) {
    score += 0.7;
    evidence.push("Keltner midline slopes upward");
  } else if (ind.keltner.midSlope < 0) {
    score -= 0.7;
    evidence.push("Keltner midline slopes downward");
  }

  // Donchian breakout pressure
  if (price >= ind.donchian.high) {
    score += 0.8;
    evidence.push("Donchian upper breakout pressure");
  }

  if (price <= ind.donchian.low) {
    score -= 0.8;
    evidence.push("Donchian lower breakdown pressure");
  }

  // Keltner location
  if (ind.keltner.position > 0.65) {
    score += 0.35;
    evidence.push("Price in upper Keltner region");
  } else if (ind.keltner.position < 0.35) {
    score -= 0.35;
    evidence.push("Price in lower Keltner region");
  }

  return {
    direction: score >= 0 ? "CALL" : "PUT",
    score,
    confidence: clamp(52 + Math.abs(score) * 9, 52, 86),
    evidence
  };
}

// ================================
// NETLIFY HANDLER
// ================================
export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: CORS
    });
  }

  if (request.method !== "POST") {
    return reply({ error: "POST required" }, 405);
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return reply({ error: "OPENAI_API_KEY is missing" }, 500);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return reply({ error: "Invalid JSON body" }, 400);
  }

  const inputCandles = Array.isArray(body.completedCandles)
    ? body.completedCandles
    : [];

  const forming = body.formingCandle;

  const all = (
    forming && Number.isFinite(Number(forming.close))
      ? [...inputCandles, forming]
      : inputCandles
  ).filter(x =>
    [x.open, x.high, x.low, x.close].every(v =>
      Number.isFinite(Number(v))
    )
  );

  if (all.length < 5) {
    return reply({
      error: `Need at least 5 valid OHLC candles; received ${all.length}`
    }, 422);
  }

  const usable = all.slice(-80);
  const ind = indicators(usable);
  const local = localBias(usable, ind);

  const patternData = {
    candlestickPatterns: Array.isArray(body.candlePatterns)
      ? body.candlePatterns.slice(0, 12)
      : [],
    chartPatterns: Array.isArray(body.chartPatterns)
      ? body.chartPatterns.slice(0, 12)
      : []
  };

  // ================================
  // OPENAI MARKET ANALYSIS PROMPT
  // ================================
  const prompt = `
You are APEXSCAN PRO's fast, decisive directional market-reading AI.

Your task is to analyze the newly forming candle and choose CALL or PUT
based on the stronger near-term directional lean.

WAIT IS NOT YOUR DEFAULT.

Use WAIT only when price is genuinely flat, chaotic, or data is unusable.

DO NOT REQUIRE:
- Indicator confirmation
- All indicators to agree
- Pattern completion
- High ADX
- Multiple confirmation candles
- Arbitrary confidence thresholds

INDICATORS:

KELTNER CHANNEL:
Interpret channel riding, midline slope, squeeze, expansion, rejection,
and price position.

ADX:
Measure trend strength. Low ADX does NOT block directional signals.

+DI / -DI:
Compare bullish and bearish directional pressure.

DONCHIAN CHANNEL:
Analyze range boundaries, upper/lower tests, breakout and breakdown pressure.

ALSO ANALYZE:
- Current candle direction
- Candle body and wick
- Recent candle sequence
- Momentum
- Swing structure
- Higher highs and higher lows
- Lower highs and lower lows
- Trend continuation
- Reversals
- Pullbacks
- Bullish patterns
- Bearish patterns
- Chart patterns

DECISION:

Bullish evidence stronger = CALL.
Bearish evidence stronger = PUT.

If evidence conflicts, WEIGH IT and choose the stronger side.
Do not automatically turn conflicts into WAIT.

If the candle is moving bullish with bullish pressure, favor CALL.
If the candle is moving bearish with bearish pressure, favor PUT.

Make your decision quickly and explain it concisely.

Never invent prices, indicators, candles, or patterns.

Return JSON only with these fields:
direction, evidenceScore, holdSeconds, reasoning,
bullishEvidence, bearishEvidence, momentum, trend,
candleStructure, chartPattern, detectedPatterns,
conflicts, riskFlags, finalReasoning.

Allowed holdSeconds:
${ALLOWED_HOLDS.join(", ")}
`;

  const userData = {
    symbol: body.symbol || body.pair || "unknown",
    pair: body.pair || "",
    timeframe: body.timeframe || body.timeframeSeconds || "unknown",
    scanType: body.scanType || "EARLY",
    formingCandle: forming || usable.at(-1),
    candles: usable.slice(-40),
    calculatedIndicators: ind,
    localDirectionalBias: local,
    patterns: patternData
  };

  let ai = null;
  const model = process.env.OPENAI_MODEL || "gpt-6.1-sol";

  // ================================
  // OPENAI REQUEST
  // ================================
  try {
    const res = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          temperature: 0.25,
          max_tokens: 650,
          response_format: {
            type: "json_object"
          },
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: JSON.stringify(userData) }
          ]
        })
      }
    );

    const data = await res.json();

    if (!res.ok) {
      throw new Error(
        data?.error?.message || `OpenAI HTTP ${res.status}`
      );
    }

    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("Empty OpenAI response");
    }

    ai = JSON.parse(content);

  } catch (err) {
    // FAIL CLOSED:
    // Do not return a directional local fallback when OpenAI fails.
    return reply({
      error: String(err.message || err),
      modelUnavailable: true,
      signal: {
        direction: "WAIT",
        evidenceScore: 0,
        holdSeconds: 60,
        reasoning: "OpenAI unavailable; no fallback direction generated."
      },
      analysis: {
        riskFlags: [
          "OpenAI unavailable; directional fallback disabled"
        ]
      }
    }, 503);
  }

  // Validate AI direction. Invalid directions become WAIT.
  const direction = ["CALL", "PUT", "WAIT"].includes(
    String(ai.direction || "").toUpperCase()
  )
    ? String(ai.direction).toUpperCase()
    : "WAIT";

  const holdSeconds = ALLOWED_HOLDS.includes(Number(ai.holdSeconds))
    ? Number(ai.holdSeconds)
    : 60;

  const output = {
    signal: {
      direction,
      evidenceScore: clamp(
        Math.round(Number(ai.evidenceScore) || local.confidence),
        0,
        100
      ),
      holdSeconds,
      reasoning: String(
        ai.reasoning ||
        ai.finalReasoning ||
        local.evidence.join("; ")
      )
    },

    analysis: {
      bullishEvidence: Array.isArray(ai.bullishEvidence)
        ? ai.bullishEvidence.slice(0, 8)
        : [],
      bearishEvidence: Array.isArray(ai.bearishEvidence)
        ? ai.bearishEvidence.slice(0, 8)
        : [],
      momentum: String(ai.momentum || ""),
      trend: String(ai.trend || ""),
      candleStructure: String(ai.candleStructure || ""),
      chartPattern: String(ai.chartPattern || ""),
      detectedPatterns: Array.isArray(ai.detectedPatterns)
        ? ai.detectedPatterns.slice(0, 10)
        : [],
      conflicts: Array.isArray(ai.conflicts)
        ? ai.conflicts.slice(0, 8)
        : [],
      riskFlags: Array.isArray(ai.riskFlags)
        ? ai.riskFlags.slice(0, 8)
        : [],
      finalReasoning: String(
        ai.finalReasoning || ai.reasoning || ""
      )
    },

    model: ai.modelUnavailable ? "UNAVAILABLE" : model,
    indicators: ind,
    modelUnavailable: Boolean(ai.modelUnavailable)
  };

  return reply(output);
};
