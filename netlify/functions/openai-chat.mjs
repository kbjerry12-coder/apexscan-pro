// APEXSCAN PRO — CHAT WITH ACE
// Netlify Function: /.netlify/functions/openai-chat
// Requires: OPENAI_API_KEY
// Optional: OPENAI_MODEL

export default async (request) => {
  // Allow browser preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }

  if (request.method !== "POST") {
    return Response.json(
      { error: "Method not allowed. Use POST." },
      { status: 405 }
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-6";

  if (!apiKey) {
    return Response.json(
      { error: "OPENAI_API_KEY is missing from Netlify environment variables." },
      { status: 500 }
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON request body." },
      { status: 400 }
    );
  }

  const message = String(body?.message || "").trim();

  if (!message) {
    return Response.json(
      { error: "Message is required." },
      { status: 400 }
    );
  }

  // Context supplied by APEXSCAN's live chart
  const marketContext = body?.marketContext || {};

  const systemPrompt = `
You are ACE, the AI market-analysis assistant inside APEXSCAN PRO.

Your role:
- Explain the connected chart and market data clearly.
- Analyze live OTC price context supplied by the dashboard.
- Explain CALL, PUT, or WAIT signals and their supporting evidence.
- Discuss momentum, candle structure, rejection wicks, support/resistance,
  Keltner Channel, OsMA, Donchian Channel, RSI, and trend when available.
- Use only market information supplied in the request.
- Never claim to see a live chart unless chart data is included in the request.
- Never invent prices, candles, indicators, or live events.
- Treat setup strength as strength of evidence, NOT probability of winning.
- Do not promise profits or guaranteed trading outcomes.
- If data is missing or stale, clearly say so.
- Be concise, direct, and conversational.
- You are ACE; the user may call you Ace.

Connected market context:
${JSON.stringify(marketContext, null, 2)}
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
        instructions: systemPrompt,
        input: message,
        max_output_tokens: 700
      }),
      signal: AbortSignal.timeout(30000)
    });

    const raw = await response.text();
    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return Response.json(
        {
          error: "OpenAI returned an invalid response.",
          details: raw.slice(0, 300)
        },
        { status: 502 }
      );
    }

    if (!response.ok) {
      return Response.json(
        {
          error: data?.error?.message || `OpenAI HTTP ${response.status}`
        },
        { status: 502 }
      );
    }

    // Extract text from Responses API output
    const reply =
      data.output
        ?.flatMap(item => item.content || [])
        ?.filter(item => item.type === "output_text")
        ?.map(item => item.text)
        ?.join("\n") || "I couldn't generate a response.";

    return Response.json(
      {
        success: true,
        reply,
        model,
        timestamp: Date.now()
      },
      {
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    return Response.json(
      {
        error: error?.message || "AI chat request failed.",
        type: error?.name || "NetworkError"
      },
      { status: 502 }
    );
  }
};
