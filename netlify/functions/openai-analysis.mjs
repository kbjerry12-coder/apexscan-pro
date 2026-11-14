export default async (request) => {
  const reply = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

  if (request.method !== "POST") {
    return reply({ error: "Use POST for AI analysis." }, 405);
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return reply({
      error: "OPENAI_API_KEY is missing from Netlify environment variables."
    }, 500);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return reply({ error: "Request body must be valid JSON." }, 400);
  }

  const market = String(input?.market || "").slice(0, 80);
  const source = Array.isArray(input?.candles)
    ? input.candles.slice(-45)
    : [];

  if (!market || source.length < 35) {
    return reply({
      error: "A market name and at least 35 OHLC candles are required."
    }, 400);
  }

  const candles = source.map((c) => ({
    time: String(c.time || "").slice(0, 40),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));

  for (const c of candles) {
    if (
      ![c.open, c.high, c.low, c.close].every(Number.isFinite) ||
      c.high < Math.max(c.open, c.close) ||
      c.low > Math.min(c.open, c.close) ||
      c.high < c.low
    ) {
      return reply({
        error: "One or more candles contain invalid OHLC values."
      }, 400);
    }
  }

  const allowed = ["BUY", "SELL", "WAIT"];

  const apexDirection = allowed.includes(input?.apex?.direction)
    ? input.apex.direction
    : "WAIT";

  const apex = {
    direction: apexDirection,
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
    reason: String(input?.apex?.reason || "").slice(0, 700)
  };

  const system = `You are an independent technical market analyst providing a second opinion, not an order executor.
Analyze only the supplied OHLC candles and market context. Do not copy the APEX direction; form an independent view from candle structure, momentum, trend persistence, recent highs/lows, volatility, and possible reversals. If evidence is mixed, weak, or insufficient, choose WAIT. Never promise profit or certainty and do not describe strength as a probability of winning.
Return ONLY valid JSON with exactly these fields: direction (BUY, SELL, or WAIT), strength (LOW, MEDIUM, or HIGH), holdMinutes (one of 1, 5, 15, 30, 60, 240), reason (brief explanation), risks (brief caution).`;

  const user = {
    market,
    currentPrice: Number.isFinite(Number(input?.livePrice))
      ? Number(input.livePrice)
      : null,
    apexTechnicalOpinion: apex,
    recentOneMinuteOHLC: candles
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
      return reply({
        error: result?.error?.message ||
          `OpenAI request failed (HTTP ${response.status}).`
      }, 502);
    }

    const content = result?.choices?.[0]?.message?.content;

    if (!content) {
      return reply({
        error: "OpenAI returned an empty analysis."
      }, 502);
    }

    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch {
      return reply({
        error: "OpenAI returned an invalid analysis format. Please retry."
      }, 502);
    }

    const direction = allowed.includes(analysis.direction)
      ? analysis.direction
      : "WAIT";

    const strengthValue = String(analysis.strength || "LOW").toUpperCase();

    const strength = ["LOW", "MEDIUM", "HIGH"].includes(strengthValue)
      ? strengthValue
      : "LOW";

    const hold = Number(analysis.holdMinutes);

    const holdMinutes = [1, 5, 15, 30, 60, 240].includes(hold)
      ? hold
      : 15;

    return reply({
      direction,
      strength,
      holdMinutes,
      reason: String(
        analysis.reason || "No explanation returned."
      ).slice(0, 500),
      risks: String(
        analysis.risks || "Market conditions can change quickly."
      ).slice(0, 300),
      model: "gpt-4.1-mini"
    });

  } catch (error) {
    return reply({
      error: error?.message || "Unable to reach OpenAI."
    }, 502);
  }
};
