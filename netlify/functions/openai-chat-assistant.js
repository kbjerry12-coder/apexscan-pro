// APEXSCAN PRO V7.0
// ChatGPT Trading Assistant
// Netlify Function
// Keep OPENAI_API_KEY in Netlify environment variables.

export default async (request) => {
  if (request.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405 }
    );
  }

  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    return Response.json({
      error: "OPENAI_API_KEY is missing from Netlify."
    }, { status: 500 });
  }

  try {
    const body = await request.json();

    const messages = Array.isArray(body?.messages)
      ? body.messages.slice(-12)
      : [];

    if (
      !messages.length ||
      messages.some(m =>
        !["user", "assistant"].includes(m?.role) ||
        typeof m?.content !== "string"
      )
    ) {
      return Response.json({
        error: "Send a valid chat message history."
      }, { status: 400 });
    }

    const cleanMessages = messages.map(m => ({
      role: m.role,
      content: m.content.slice(0, 1200)
    }));

    const market = body?.market || {};

    const marketContext = JSON.stringify({
      pair: String(market.pair || "Unknown").slice(0, 60),
      symbol: String(market.symbol || "").slice(0, 40),
      timeframe: String(market.timeframe || "Unknown"),
      feedFresh: market.feedFresh === true,
      livePrice: Number.isFinite(Number(market.livePrice))
        ? Number(market.livePrice) : null,
      liveTickAgeSeconds: Number.isFinite(
        Number(market.liveTickAgeSeconds)
      ) ? Number(market.liveTickAgeSeconds) : null,
      technical: market.technical || {},
      candles: Array.isArray(market.candles)
        ? market.candles.slice(-24) : []
    });

    const instructions = `
You are ChatGPT embedded inside APEXSCAN PRO.

You are an independent technical market analyst
inside a Pocket Option OTC paper-trading dashboard.

YOUR RESPONSIBILITIES:

1. Analyze MACD momentum.
2. Analyze bullish and bearish candle structures.
3. Identify support and resistance.
4. Identify possible reversals and breakouts.
5. Compare 1m, 5m and 15m direction when supplied.
6. Explain why a market may be moving against a signal.
7. Provide CALL, PUT or WAIT assessments when requested.
8. Explain risks and conflicting indicators.

IMPORTANT RULES:

- Never invent market prices or indicator values.
- Never invent volume or missing candle information.
- Never claim guaranteed profits.
- Never claim a signal is 100% accurate.
- If market data is stale or insufficient, explain that.
- Prefer WAIT when evidence is conflicting.
- The dashboard may use reverse mode.
- Do not reverse an already reversed technical direction.
- Technical scores are not win probabilities.
- Never execute or claim to execute trades.
- Keep answers concise and understandable.

SIGNAL FORMAT:

CALL = Bullish directional assessment.
PUT = Bearish directional assessment.
WAIT = Insufficient or conflicting evidence.
NONE = Ordinary conversation without a signal request.

Return ONLY valid JSON with exactly:

{
  "reply": "Your explanation and analysis",
  "signal": "CALL, PUT, WAIT, or NONE"
}
`;

    const input = [
      {
        role: "user",
        content:
          "CURRENT APEXSCAN MARKET SNAPSHOT:\n" +
          marketContext +
          "\nContinue this conversation using the messages below."
      },
      ...cleanMessages
    ];

    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          instructions,
          input,
          text: {
            format: { type: "json_object" }
          },
          max_output_tokens: 900,
          store: false
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return Response.json({
        error:
          data?.error?.message ||
          `OpenAI API returned HTTP ${response.status}`
      }, {
        status: response.status >= 500 ? 502 : 400
      });
    }

    const outputText = (data.output || [])
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join("\n");

    if (!outputText) {
      return Response.json({
        error: "ChatGPT returned no readable response."
      }, { status: 502 });
    }

    let result;

    try {
      result = JSON.parse(outputText);
    } catch {
      return Response.json({
        error: "ChatGPT response was not valid JSON."
      }, { status: 502 });
    }

    const signal = ["CALL", "PUT", "WAIT"].includes(
      String(result.signal).toUpperCase()
    )
      ? String(result.signal).toUpperCase()
      : "NONE";

    return Response.json({
      reply: String(
        result.reply || "I couldn't form a useful answer."
      ).slice(0, 4000),
      signal
    });

  } catch (error) {
    return Response.json({
      error: error?.message || "Chat assistant failed."
    }, { status: 500 });
  }
};
