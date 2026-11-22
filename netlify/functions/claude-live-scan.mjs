// APEXSCAN PRO — Claude Live OTC Signal Scanner
// Netlify Function: /.netlify/functions/claude-live-scan
// AI-only signal decision (CALL / PUT / WAIT); paper-analysis output only.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders
  });
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseModelJSON(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const match = text.match(/\{[\s\S]*\}/);

  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  return null;
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  if (request.method !== "POST") {
    return json({
      success: false,
      error: "Method not allowed. Use POST."
    }, 405);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return json({
      success: false,
      error: "ANTHROPIC_API_KEY is missing from Netlify environment variables."
    }, 500);
  }

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      success: false,
      error: "Request body must be valid JSON."
    }, 400);
  }

  const symbol =
    body.symbol ||
    body.pair ||
    body.asset ||
    "UNKNOWN";

  const timeframe =
    body.timeframe ||
    body.tf ||
    "30s";

  const scanMode =
    body.scanMode ||
    body.mode ||
    "CLAUDE_LIVE_OTC_30S";

  const formingCandle =
    body.formingCandle ||
    body.currentCandle ||
    body.targetCandle ||
    body.newCandle ||
    body.candle ||
    null;

  const completedCandles =
    body.completedCandles ||
    body.previousCandles ||
    body.history ||
    body.candles ||
    [];

  const indicators =
    body.indicators ||
    body.indicatorData ||
    {};

  const livePrice =
    safeNumber(body.livePrice) ??
    safeNumber(body.price) ??
    safeNumber(body.currentPrice);

  const learning =
    body.learning ||
    body.historicalLearning ||
    body.performanceLearning ||
    null;

  const candleAge = safeNumber(
    body.formingCandleAgeSeconds ??
    body.candleAgeSeconds ??
    body.ageSeconds
  );

  // A forming candle is required for a live scan.
  if (!formingCandle) {
    return json({
      success: false,
      error: "Missing forming candle.",
      message:
        "Send formingCandle/currentCandle/targetCandle. Completed candles alone are not a scan target."
    }, 400);
  }

  const scanData = {
    symbol,
    timeframe,
    scanMode,
    formingCandleAgeSeconds: candleAge,
    livePrice,
    formingCandle,
    completedCandles,
    indicators,
    learning,
    marketContext: body.marketContext || null,
    scanTimestamp: body.scanTimestamp || new Date().toISOString()
  };

  const system = `You are Claude, the independent AI decision engine for APEXSCAN PRO's LIVE OTC SIGNAL SCANNER. Analyze the supplied data and make your own evidence-based decision. This is analysis only; never place trades and never promise profit.

TARGET & DATA RULES:
- The supplied FORMING CANDLE is the sole target for the scan. Completed candles are context only.
- Evaluate actual OHLC, body/wicks, current price vs open, momentum, developing structure, volatility, trend, rejection/breakout evidence, support/resistance if calculable, and supplied indicators.
- Use only the supplied data. Do not invent prices, indicator values, candle details, volume, outcomes, or win rates.
- If data is missing, stale, malformed, contradictory, or weak—or indicators materially conflict—prefer WAIT.
- Confidence is an evidence-strength score (0-100), NOT a probability of winning.
- Do not force a CALL or PUT. WAIT is a valid decision.
- Historical learning is secondary context; it must not override current evidence or small samples.
- Choose a hold duration only from: 15, 30, 60, 180, 300, 900, 1800, 3600, or 14400 seconds.

OUTPUT:
Return only one valid JSON object with exactly this schema (no markdown):
{
  "signal": "CALL",
  "direction": "BULLISH",
  "evidenceScore": 0,
  "holdSeconds": 30,
  "targetCandle": "FORMING",
  "candleStatus": "FORMING",
  "summary": "Concise scan summary",
  "reasoning": ["Specific evidence"],
  "confirmations": [],
  "conflicts": [],
  "riskFlags": [],
  "waitReason": ""
}

signal must be CALL, PUT, or WAIT. direction must be BULLISH, BEARISH, or NEUTRAL. evidenceScore must be an integer 0-100. When WAIT, direction should normally be NEUTRAL and waitReason must explain why. Keep reasoning specific and concise.`;

  const user = `Run an independent Claude LIVE OTC scan now. The forming candle is the target; completed candles are context only.

SCAN DATA:
${JSON.stringify(scanData, null, 2)}`;

  try {
    const response = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          max_tokens: 1200,
          system,
          messages: [
            {
              role: "user",
              content: user
            }
          ]
        }),
        signal: AbortSignal.timeout(45000)
      }
    );

    const raw = await response.text();

    let apiResponse;

    try {
      apiResponse = JSON.parse(raw);
    } catch {
      return json({
        success: false,
        error: "Anthropic returned a non-JSON response.",
        details: raw.slice(0, 500)
      }, 502);
    }

    if (!response.ok) {
      return json({
        success: false,
        error:
          apiResponse?.error?.message ||
          `Anthropic API returned HTTP ${response.status}`,
        status: response.status
      }, 502);
    }

    const outputText = (apiResponse.content || [])
      .filter(item => item?.type === "text" && item.text)
      .map(item => item.text)
      .join("\n")
      .trim();

    if (!outputText) {
      return json({
        success: false,
        error: "Claude response contained no text output."
      }, 502);
    }

    const analysis = parseModelJSON(outputText);

    if (!analysis) {
      return json({
        success: true,
        symbol,
        timeframe,
        targetCandle: "FORMING",
        signal: "WAIT",
        direction: "NEUTRAL",
        evidenceScore: 0,
        holdSeconds: 30,
        summary: outputText,
        reasoning: [],
        confirmations: [],
        conflicts: [],
        riskFlags: [
          "Claude output was not valid structured JSON."
        ],
        waitReason:
          "Structured analysis could not be parsed.",
        model,
        aiEngine: "Claude",
        paperOnly: true
      });
    }

    // Validate Claude's output.
    const validSignals = [
      "CALL",
      "PUT",
      "WAIT"
    ];

    const validDirections = [
      "BULLISH",
      "BEARISH",
      "NEUTRAL"
    ];

    const validHolds = [
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

    const signal = validSignals.includes(analysis.signal)
      ? analysis.signal
      : "WAIT";

    const direction = validDirections.includes(analysis.direction)
      ? analysis.direction
      : "NEUTRAL";

    const evidenceScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          safeNumber(analysis.evidenceScore) ?? 0
        )
      )
    );

    const holdSeconds = validHolds.includes(
      Number(analysis.holdSeconds)
    )
      ? Number(analysis.holdSeconds)
      : 30;

    return json({
      success: true,
      symbol,
      timeframe,
      targetCandle: "FORMING",
      candleStatus: "FORMING",
      scanTimestamp: scanData.scanTimestamp,
      signal,
      direction,
      evidenceScore,
      holdSeconds,
      summary: String(analysis.summary || ""),
      reasoning: Array.isArray(analysis.reasoning)
        ? analysis.reasoning.slice(0, 8)
        : [],
      confirmations: Array.isArray(analysis.confirmations)
        ? analysis.confirmations
        : [],
      conflicts: Array.isArray(analysis.conflicts)
        ? analysis.conflicts
        : [],
      riskFlags: Array.isArray(analysis.riskFlags)
        ? analysis.riskFlags
        : [],
      waitReason: String(analysis.waitReason || ""),
      model,
      aiEngine: "Claude",
      paperOnly: true
    });

  } catch (error) {
    return json({
      success: false,
      error:
        error?.message ||
        "Claude analysis request failed.",
      type:
        error?.name ||
        "UnknownError"
    }, 502);
  }
}
