export default async (request) => {
  if (request.method !== "POST") {
    return Response.json(
      { error: "POST required" },
      { status: 405 }
    );
  }

  try {
    const key = process.env.OPENAI_API_KEY;

    if (!key) {
      return Response.json(
        { error: "OPENAI_API_KEY is missing" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const image = body.image;

    if (
      typeof image !== "string" ||
      !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)
    ) {
      return Response.json(
        { error: "Upload a valid PNG, JPG or WEBP chart." },
        { status: 400 }
      );
    }

    const prompt = `
You are APEX AI VISION.

Analyze this trading chart visually.

Check:
1. Candlestick direction and structure.
2. Bullish or bearish momentum.
3. MACD if visible.
4. Support and resistance.
5. Reversal patterns.
6. Whether the next direction favors CALL or PUT.

If evidence is unclear, return WAIT.
Never invent indicator readings.

Return the analysis using the required JSON fields.
The evidence score is NOT a win probability.
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
            format: {
              type: "json_schema",
              name: "apex_chart_analysis",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  direction: {
                    type: "string",
                    enum: ["CALL", "PUT", "WAIT"]
                  },
                  evidence_score: {
                    type: "integer"
                  },
                  pattern: { type: "string" },
                  trend: { type: "string" },
                  support_resistance: { type: "string" },
                  reason: { type: "string" },
                  risk_flags: {
                    type: "array",
                    items: { type: "string" }
                  }
                },
                required: [
                  "direction",
                  "evidence_score",
                  "pattern",
                  "trend",
                  "support_resistance",
                  "reason",
                  "risk_flags"
                ],
                additionalProperties: false
              }
            }
          },
          max_output_tokens: 700,
          store: false
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return Response.json({
        error: data.error?.message || "OpenAI request failed"
      }, { status: 502 });
    }

    const output = (data.output || [])
      .flatMap(item => item.content || [])
      .find(item => item.type === "output_text")?.text;

    if (!output) {
      return Response.json({
        error: "AI returned no analysis."
      }, { status: 502 });
    }

    let result;

    try {
      result = JSON.parse(output);
    } catch {
      return Response.json({
        error: "AI response was not valid JSON. Please scan again."
      }, { status: 502 });
    }

    const original = result.direction;

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
        Math.min(100, result.evidence_score)
      ),
      pattern: result.pattern,
      trend: result.trend,
      support_resistance: result.support_resistance,
      reason: result.reason,
      risk_flags: result.risk_flags
    });

  } catch (error) {
    return Response.json({
      error: error.message || "Vision analysis failed"
    }, { status: 500 });
  }
};
