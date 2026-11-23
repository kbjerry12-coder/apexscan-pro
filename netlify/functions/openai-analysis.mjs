// APEXSCAN PRO — ChatGPT Deep Scan Analysis
// File: netlify/functions/openai-analysis.mjs
//
// Target: newly FORMING candle
// Completed candles: context only
// Trading execution: paper analysis only
//
// Works with the ApexScan HTML page: it POSTs one `candles` array whose LAST
// item is the forming candle, and reads `signal.{direction,confidence,reasoning}`.

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

function extractOutputText(response) {
  if (typeof response?.output_text === "string") {
    return response.output_text.trim();
  }

  const parts = [];

  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;

    for (const content of item.content || []) {
      if (content?.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function parseModelJSON(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // Try to recover JSON if the model surrounded it with markdown.
    const match = text.match(/\{[\s\S]*\}/);

    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }

  return null;
}

export default async function handler(request) {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  if (request.method !== "POST") {
    return json(
      {
        success: false,
        error: "Method not allowed. Use POST."
      },
      405
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return json(
      {
        success: false,
        error: "OPENAI_API_KEY is missing from Netlify environment variables."
      },
      500
    );
  }

  const model = process.env.OPENAI_MODEL || "gpt-5.5";

  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        success: false,
        error: "Request body must be valid JSON."
      },
      400
    );
  }

  // Accept common frontend payload names
  const symbol =
    body.symbol ||
    body.pair ||
    body.asset ||
    "UNKNOWN";

  const rawTimeframe =
    body.timeframe ||
    body.tf ||
    "1m";

  const timeframe =
    typeof rawTimeframe === "number" ? `${rawTimeframe}s` : rawTimeframe;

  let formingCandle =
    body.formingCandle ||
    body.currentCandle ||
    body.targetCandle ||
    body.newCandle ||
    body.candle ||
    null;

  let completedCandles =
    body.completedCandles ||
    body.previousCandles ||
    body.history ||
    [];

  // HTML page payload: one `candles` array, last item = forming candle.
  if (Array.isArray(body.candles) && body.candles.length) {
    if (!formingCandle && body.candles.length > 1) {
      formingCandle = body.candles[body.candles.length - 1];
      completedCandles = body.candles.slice(0, -1);
    } else if (!completedCandles.length) {
      completedCandles = body.candles;
    }
  }

  if (Array.isArray(completedCandles)) {
    completedCandles = completedCandles.slice(-100);
  }

  const requestedHoldSeconds = safeNumber(
    body.hold_seconds ?? body.holdSeconds
  );

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

  const scanMode =
    body.scanMode ||
    body.mode ||
    "FORMING_CANDLE_DEEP_SCAN";

  // The current forming candle must be supplied.
  if (!formingCandle) {
    return json(
      {
        success: false,
        error: "Missing forming candle.",
        message:
          "Send formingCandle/currentCandle/targetCandle in the request. Completed candles alone cannot be used as the scan target."
      },
      400
    );
  }

  const formingTime = safeNumber(formingCandle?.time);

  const candleAge =
    safeNumber(
      body.formingCandleAgeSeconds ??
      body.candleAgeSeconds ??
      body.ageSeconds
    ) ??
    (formingTime
      ? Math.max(0, Math.round(Date.now() / 1000 - formingTime))
      : null);

  const scanData = {
    symbol,
    timeframe,
    scanMode,
    formingCandleAgeSeconds: candleAge,
    livePrice,
    formingCandle,
    completedCandles,
    requestedHoldSeconds,
    indicators,
    learning,
    marketContext: body.marketContext || null,
    scanTimestamp: body.scanTimestamp || new Date().toISOString()
  };

  const instructions = `
You are APEXSCAN PRO's candle-analysis engine.

Analyze market evidence objectively. You are NOT allowed to claim guaranteed,
certain, or highly reliable profits.

TARGET CANDLE RULES:
1. The FORMING CANDLE is the only target candle.
2. Completed candles are CONTEXT ONLY.
3. Do not generate a signal for a previous candle.
4. Evaluate the forming candle's actual OHLC, current price, body, wick,
   momentum, location, and developing structure.
5. If the forming candle data is missing, malformed, stale, or contradictory,
   return WAIT.
6. Do not invent indicator values, prices, volume, candle data, or outcomes.
7. Do not invent a win rate or probability of success.
8. Confidence is an evidence-strength score from 0 to 100, NOT a probability
   of winning.
9. Historical learning is context only. Small samples must not override
   current market evidence.
10. When evidence conflicts, is weak, or lacks confirmation, return WAIT.
11. Do not force a CALL or PUT just because the user requested a scan.
12. This is paper-analysis output only. Do not place trades.

ANALYSIS:
Evaluate:
- Forming-candle direction and body/wick balance
- Current live price relative to the candle open
- Recent price momentum
- Trend and structure from completed candles
- Rejection or breakout evidence
- Support/resistance context if supplied or calculable
- MACD if supplied
- Stochastic if supplied
- Bollinger/Keltner position if supplied
- Donchian Channel if supplied
- OsMA if supplied
- CCI if supplied
- Agreement/conflict between indicators
- Historical learning only when relevant samples exist

OUTPUT:
Return ONLY valid JSON. No markdown, no code fences.

Use exactly this JSON structure:

{
  "signal": "CALL",
  "direction": "BULLISH",
  "evidenceScore": 0,
  "holdSeconds": 60,
  "targetCandle": "FORMING",
  "candleStatus": "FORMING",
  "summary": "Short explanation",
  "reasoning": [
    "Evidence item 1",
    "Evidence item 2",
    "Evidence item 3"
  ],
  "confirmations": [],
  "conflicts": [],
  "riskFlags": [],
  "waitReason": ""
}

SIGNAL RULE:
- signal must be CALL, PUT, or WAIT.
- direction must be BULLISH, BEARISH, or NEUTRAL.
- evidenceScore must be an integer 0-100.
- holdSeconds must be one of 15, 30, 60, 120, 180, 300, 900, 1800, 3600, or 14400.
- If requestedHoldSeconds is supplied, judge the direction over that holding
  window and use it as holdSeconds.
- When signal is WAIT, direction should normally be NEUTRAL,
  evidenceScore should reflect weak/conflicting evidence,
  and waitReason must explain why.
- If the candle is too early, evidence is insufficient, or conditions are
  conflicting, prefer WAIT over forcing a direction.
- Never call evidenceScore a win probability.

Keep the reasoning concise and specific to the supplied data.
`;

  const userInput = `
Analyze this APEXSCAN forming-candle scan.

Remember:
- formingCandle is the TARGET.
- completedCandles are context only.
- Never switch the target to a completed candle.

SCAN DATA:
${JSON.stringify(scanData)}
`;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        instructions,
        input: userInput,
        max_output_tokens: 1200
      }),
      signal: AbortSignal.timeout(28000)
    });

    const raw = await response.text();

    let apiResponse;

    try {
      apiResponse = JSON.parse(raw);
    } catch {
      return json(
        {
          success: false,
          error: "OpenAI returned a non-JSON response.",
          details: raw.slice(0, 500)
        },
        502
      );
    }

    if (!response.ok) {
      return json(
        {
          success: false,
          error:
            apiResponse?.error?.message ||
            `OpenAI API returned HTTP ${response.status}`,
          status: response.status
        },
        502
      );
    }

    const outputText = extractOutputText(apiResponse);

    if (!outputText) {
      return json(
        {
          success: false,
          error: "AI response contained no text output."
        },
        502
      );
    }

    const analysis = parseModelJSON(outputText);

    // If JSON parsing fails, return the raw analysis safely.
    if (!analysis) {
      return json({
        success: true,
        signal: {
          direction: "WAIT",
          confidence: 0,
          reasoning: "AI advises WAIT: structured analysis could not be parsed.",
          riskFlags: ["Model output was not valid structured JSON."]
        },
        analysis: {
          symbol,
          timeframe,
          targetCandle: "FORMING",
          signal: "WAIT",
          direction: "NEUTRAL",
          evidenceScore: 0,
          summary: outputText,
          waitReason: "Structured analysis could not be parsed."
        }
      });
    }

    // Normalize and validate AI fields
    const validSignals = ["CALL", "PUT", "WAIT"];
    const validDirections = ["BULLISH", "BEARISH", "NEUTRAL"];
    const validHolds = [15, 30, 60, 120, 180, 300, 900, 1800, 3600, 14400];

    const signal = validSignals.includes(analysis.signal)
      ? analysis.signal
      : "WAIT";

    const direction = validDirections.includes(analysis.direction)
      ? analysis.direction
      : "NEUTRAL";

    const score = Math.max(
      0,
      Math.min(100, Math.round(safeNumber(analysis.evidenceScore) ?? 0))
    );

    const holdSeconds = validHolds.includes(Number(analysis.holdSeconds))
      ? Number(analysis.holdSeconds)
      : 60;

    const summary = String(analysis.summary || "");
    const reasoning = Array.isArray(analysis.reasoning)
      ? analysis.reasoning.slice(0, 8)
      : [];
    const confirmations = Array.isArray(analysis.confirmations)
      ? analysis.confirmations
      : [];
    const conflicts = Array.isArray(analysis.conflicts)
      ? analysis.conflicts
      : [];
    const riskFlags = Array.isArray(analysis.riskFlags)
      ? analysis.riskFlags
      : [];
    const waitReason = String(analysis.waitReason || "");

    // One short string for the HTML page's "AI:" note.
    const reasoningText =
      signal === "WAIT"
        ? `AI advises WAIT: ${waitReason || summary || "evidence is weak or conflicting."}`
        : [summary, ...reasoning.slice(0, 2).map(String)]
            .filter(Boolean)
            .join(" · ");

    const full = {
      symbol,
      timeframe,
      targetCandle: "FORMING",
      candleStatus: "FORMING",
      scanTimestamp: scanData.scanTimestamp,
      signal,
      direction,
      evidenceScore: score,
      holdSeconds,
      summary,
      reasoning,
      confirmations,
      conflicts,
      riskFlags,
      waitReason,
      model,
      paperOnly: true
    };

    // The HTML page reads j.signal as an OBJECT with
    // direction (CALL/PUT/WAIT), confidence (0-100) and reasoning (string).
    // The full structured result is under `analysis`.
    return json({
      success: true,
      signal: {
        direction: signal,
        confidence: score,
        reasoning: reasoningText,
        summary,
        confirmations,
        conflicts,
        riskFlags,
        waitReason,
        holdSeconds
      },
      analysis: full
    });
  } catch (error) {
    return json(
      {
        success: false,
        error:
          error?.name === "TimeoutError"
            ? "OpenAI analysis timed out after 28 seconds. Try again on the next scan."
            : (error?.message || "AI analysis request failed."),
        type: error?.name || "UnknownError"
      },
      502
    );
  }
}
