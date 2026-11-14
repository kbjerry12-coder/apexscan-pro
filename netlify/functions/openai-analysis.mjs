export default async (request) => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });

  if (request.method !== "POST") {
    return json({ error: "Use POST for AI analysis." }, 405);
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return json({
      error: "OPENAI_API_KEY is missing from Netlify environment variables."
    }, 500);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const market = String(input?.market || "").slice(0, 80);
  const candles = Array.isArray(input?.candles)
    ? input.candles.slice(-45)
    : [];

  if (!market || candles.length < 35) {
    return json({
      error: "A market name and at least 35 OHLC candles are required."
    }, 400);
  }

  const cleanCandles = candles.map((c) => ({
    time: String(c.time || "").slice(0, 40),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));

  for (const c of cleanCandles) {
    if (
      ![c.open, c.high, c.low, c.close].every(Number.isFinite) ||
      c.high < Math.max(c.open, c.close) ||
      c.low > Math.min(c.open, c.close) ||
      c.high < c.low
    ) {
      return json({
        error: "One or more candles contain invalid OHLC values."
      }, 400);
    }
  }

  const apex = {
    direction: ["BUY", "SELL", "WAIT"].includes(input?.apex?.direction)
      ? input.apex.direction
      : "WAIT",
    score: Number.isFinite(Number(input?.apex?.score))
      ? Math.max(0, Math.min(100, Number(input.apex.score)))
      : null,
    trend: String(input?.apex?.trend || "UNKNOWN").slice(0, 20),
    rsi: Number.isFinite(Number(input?.apex?.rsi))
      ? Number(input.apex.rsi)
      : null,
    adx: Number.isFinite(Number(input?.apex?.adx))
      ? Number(input.apex.adx)
      : null,
    atrPct: Number.isFinite(Number(input?.apex?.atrPct))
      ? Number(input.apex.atrPct)
      : null,
    reason: String(input?.apex?.reason || "").slice(0, 700)
  };

  const system = `You are an independent technical market analyst.
Assess only the supplied OHLC candles and context.
Do not simply copy the APEX direction.
Form your own view from candle structure, momentum, trend,
volatility, recent highs/lows, and possible reversals.
If evidence is mixed, weak, or insufficient, choose WAIT.
Never promise profit, certainty, or a win rate.
This is educational analysis, not financial advice.
Return ONLY valid JSON with exactly these fields:
direction (BUY, SELL, or WAIT),
strength (LOW, MEDIUM, or HIGH),
holdMinutes (one of 1, 5, 15, 30, 60, 240),
reason (brief explanation),
risks (brief caution).
Do not output a probability or claim confidence is a win probability.`;

  const user = {
    market,
    currentPrice: Number.isFinite(Number(input?.livePrice))
      ? Number(input.livePrice)
      : null,
    apexTechnicalOpinion: apex,
    recentOneMinuteOHLC: cleanCandles
  };

  try {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          temperature: 0.2,
          max_completion_tokens: 300,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: JSON.stringify(user) }
          ]
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      const message =
        result?.error?.message ||
        `OpenAI request failed (HTTP ${response.status}).`;

      return json(
        { error: message },
        response.status >= 500 ? 502 : 400
      );
    }

    const content = result?.choices?.[0]?.message?.content;

    if (!content) {
      return json({
        error: "OpenAI returned an empty analysis."
      }, 502);
    }

    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch {
      return json({
        error: "OpenAI returned an invalid analysis format. Please retry."
      }, 502);
    }

    const direction = ["BUY", "SELL", "WAIT"].includes(analysis.direction)
      ? analysis.direction
      : "WAIT";

    const strength = ["LOW", "MEDIUM", "HIGH"].includes(
      String(analysis.strength).toUpperCase()
    )
      ? String(analysis.strength).toUpperCase()
      : "LOW";

    const holdMinutes = [1, 5, 15, 30, 60, 240].includes(
      Number(analysis.holdMinutes)
    )
      ? Number(analysis.holdMinutes)
      : 15;

    return json({
      direction,
      strength,
      holdMinutes,
      reason: String(
        analysis.reason || "The model did not provide a reason."
      ).slice(0, 500),
      risks: String(
        analysis.risks || "Market conditions can change quickly."
      ).slice(0, 300),
      model: "gpt-4.1-mini"
    });

  } catch (error) {
    return json({
      error: error?.message || "Unable to reach OpenAI."
    }, 502);
  }
};
