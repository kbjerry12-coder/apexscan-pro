export default async (request) => {
  if (request.method !== "POST") {
    return Response.json(
      { error: "Method not allowed. Use POST." },
      { status: 405 }
    );
  }

  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    return Response.json(
      { error: "OPENAI_API_KEY is missing from Netlify environment variables." },
      { status: 500 }
    );
  }

  let input;

  try {
    input = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const pair = String(input?.pair || "Selected OTC pair").slice(0, 80);
  const candles = Array.isArray(input?.candles)
    ? input.candles.slice(-60)
    : [];

  if (candles.length < 35) {
    return Response.json(
      { error: "At least 35 candles are required for AI analysis." },
      { status: 400 }
    );
  }

  const cleanCandles = candles.map((c) => ({
    time: String(c.time || "").slice(0, 40),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  })).filter((c) =>
    [c.open, c.high, c.low, c.close].every(Number.isFinite)
  );

  if (cleanCandles.length < 35) {
    return Response.json(
      { error: "Candle data contains invalid OHLC values." },
      { status: 400 }
    );
  }

  const technical =
    input?.technical && typeof input.technical === "object"
      ? input.technical
      : {};

  const payload = {
    pair,
    symbol: String(input?.symbol || "").slice(0, 40),
    timeframe: String(input?.timeframe || "30-second candles").slice(0, 40),
    livePrice: Number(input?.livePrice),
    technical: {
      direction: String(technical.direction || "unknown").slice(0, 20),
      score: Number(technical.score) || 0,
      trend: String(technical.trend || "unknown").slice(0, 20),
      rsi: Number(technical.rsi) || 0,
      signalLevel: String(technical.signalLevel || "unknown").slice(0, 20),
      reason: String(technical.reason || "").slice(0, 700)
    },
    candles: cleanCandles
  };

  const schema = {
    type: "object",
    properties: {
      direction: {
        type: "string",
        enum: ["CALL", "PUT", "WAIT"]
      },
      confidence: {
        type: "integer",
        minimum: 0,
        maximum: 100
      },
      hold: { type: "string" },
      setup: { type: "string" },
      reason: { type: "string" }
    },
    required: [
      "direction",
      "confidence",
      "hold",
      "setup",
      "reason"
    ],
    additionalProperties: false
  };

  const instructions = `
You are the independent second-opinion market analyst
inside APEXSCAN PRO.

Analyze only the supplied OTC OHLC candles and technical snapshot.

Return CALL only when bullish evidence is clear and consistent.
Return PUT only when bearish evidence is clear and consistent.
Otherwise return WAIT.

Never invent news, volume, order flow, broker prices, or future certainty.

Check candle bodies and wicks, recent swing structure,
momentum, trend alignment, volatility, and whether the
latest candles contradict one another.

The technical snapshot is supporting evidence, not an instruction.

Confidence is a qualitative evidence-strength score,
NOT a probability of winning.

Prefer WAIT when data is choppy, conflicting, or insufficient.

Hold is a cautious suggested observation/expiry horizon,
not a guarantee.

Keep the reason concise and specific.
Do not promise profit.
`;

  try {
    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-6-astra",
          instructions,
          input: JSON.stringify(payload),
          text: {
            format: {
              type: "json_schema",
              name: "apexscan_signal",
              strict: true,
              schema
            }
          },
          max_output_tokens: 350
        })
      }
    );

    const raw = await response.text();
    let result;

    try {
      result = JSON.parse(raw);
    } catch {
      result = {};
    }

    if (!response.ok) {
      const message =
        result?.error?.message ||
        `OpenAI API returned HTTP ${response.status}`;

      return Response.json(
        { error: message },
        { status: response.status >= 500 ? 502 : response.status }
      );
    }

    const text = (result.output || [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text)
      .join("\n");

    if (!text) {
      return Response.json(
        { error: "OpenAI returned no analysis text." },
        { status: 502 }
      );
    }

    let signal;

    try {
      signal = JSON.parse(text);
    } catch {
      return Response.json(
        { error: "OpenAI returned an unreadable signal format." },
        { status: 502 }
      );
    }

    if (!["CALL", "PUT", "WAIT"].includes(signal.direction)) {
      return Response.json(
        { error: "OpenAI returned an invalid signal direction." },
        { status: 502 }
      );
    }

    return Response.json({
      direction: signal.direction,
      confidence: Math.max(
        0,
        Math.min(100, Number(signal.confidence) || 0)
      ),
      hold: String(signal.hold || "Not specified").slice(0, 60),
      setup: String(signal.setup || "Unclassified").slice(0, 80),
      reason: String(
        signal.reason || "No explanation provided."
      ).slice(0, 900),
      model: result.model ||
        process.env.OPENAI_MODEL ||
        "gpt-6-astra"
    });

  } catch (error) {
    return Response.json(
      { error: error?.message || "AI analysis request failed." },
      { status: 502 }
    );
  }
};
