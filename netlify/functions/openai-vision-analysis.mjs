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
    const image = body?.image;

    if (
      typeof image !== "string" ||
      !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image)
    ) {
      return Response.json({
        error: "Please upload a valid chart screenshot."
      }, { status: 400 });
    }

    if (image.length > 11500000) {
      return Response.json({
        error: "Image too large. Maximum 8 MB."
      }, { status: 413 });
    }

    const pair = String(body.pair || "Unknown pair");
    const timeframe = String(body.timeframe || "1 minute");

    const prompt = `
You are APEX AI VISION, an expert visual chart analysis assistant.

Analyze the uploaded trading chart.

IMPORTANT:
- Read the visible candlesticks.
- Identify bullish or bearish momentum.
- Read MACD if visible.
- Identify support and resistance.
- Examine candle structure.
- Identify possible reversals.
- Do not invent unreadable values.
- Do not claim guaranteed wins.
- If evidence is unclear, return WAIT.

Market: ${pair}
Timeframe: ${timeframe}

Determine the original chart direction:

CALL = bullish
PUT = bearish
WAIT = unclear

Return a JSON response with:

{
 "direction": "CALL, PUT, or WAIT",
 "evidence_score": 0,
 "pattern": "",
 "trend": "",
 "support_resistance": "",
 "reason": "",
 "risk_flags": []
}

The evidence score is not a win probability.
`;

    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          input: [{
            role: "user",
            content: [
              {
                type: "input_text",
                text: prompt
              },
              {
                type: "input_image",
                image_url: image,
                detail: "high"
              }
            ]
          }],
          text: {
            format: { type: "json_object" }
          },
          max_output_tokens: 700,
          store: false
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return Response.json({
        error: data?.error?.message || "AI analysis failed."
      }, { status: 502 });
    }

    const output = (data.output || [])
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join("\n");

    if (!output) {
      throw new Error("No AI analysis returned.");
    }

    const result = JSON.parse(output);

    const original = ["CALL", "PUT", "WAIT"]
      .includes(String(result.direction).toUpperCase())
      ? String(result.direction).toUpperCase()
      : "WAIT";

    // APEXSCAN reverse signal mode
    const reversed =
      original === "CALL" ? "PUT" :
      original === "PUT" ? "CALL" :
      "WAIT";

    return Response.json({
      success: true,
      original_direction: original,
      direction: reversed,
      reverse_mode: true,
      evidence_score: Math.max(
        0,
        Math.min(100, Number(result.evidence_score) || 0)
      ),
      pattern: result.pattern || "Unknown",
      trend: result.trend || "Unknown",
      support_resistance:
        result.support_resistance || "Not identified",
      reason: result.reason || "Insufficient evidence",
      risk_flags: Array.isArray(result.risk_flags)
        ? result.risk_flags
        : []
    });

  } catch (error) {
    return Response.json({
      error: error.message || "Analysis failed."
    }, { status: 500 });
  }
};
