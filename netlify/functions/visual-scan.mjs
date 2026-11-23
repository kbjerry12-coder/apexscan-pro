// APEXSCAN PRO - Experimental Screenshot Visual Scan
// Requires OPENAI_API_KEY in Netlify environment variables.

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "POST required" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(503, {
      error: "OPENAI_API_KEY is not configured in Netlify",
    });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Request body must be valid JSON" });
  }

  const {
    image,
    pair = "unknown pair",
    timeframe = "unknown timeframe",
    duration = "1 minute",
  } = body || {};

  if (typeof image !== "string" || !image.startsWith("data:image/")) {
    return json(400, {
      error: "Upload a screenshot image as a data URL",
    });
  }

  const match = image.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/
  );

  if (!match || !ALLOWED.has(match[1])) {
    return json(400, {
      error: "Supported image types: PNG, JPG, WebP",
    });
  }

  const base64 = match[2];
  const approxBytes = Math.floor(base64.length * 3 / 4);

  if (approxBytes > MAX_IMAGE_BYTES) {
    return json(413, {
      error: "Screenshot is too large (8 MB maximum)",
    });
  }

  const model =
    process.env.VISUAL_SCAN_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-4.1-mini";

  const prompt = `
You are the experimental screenshot-based chart-reading module
for APEXSCAN PRO.

Analyze ONLY the visible chart image.

Do not pretend to know live prices, hidden indicators,
exact candles, or market conditions that are not visible.

If the chart is unclear, cropped, low-resolution,
or stale-looking, say so and choose WAIT.

Dashboard context:
Pair: ${String(pair).slice(0, 80)}
Timeframe: ${String(timeframe).slice(0, 30)}
Requested paper duration: ${String(duration).slice(0, 30)}

Return concise, valid JSON with exactly these keys:

{
  "direction": "CALL | PUT | WAIT",
  "confidence": 0,
  "chart_read": "brief trend and structure description",
  "momentum": "bullish | bearish | mixed | unclear",
  "key_levels": {
    "support": [],
    "resistance": []
  },
  "setup": "pattern or setup visible",
  "risk_flags": [],
  "entry_timing": "now | wait for candle close | avoid | unclear",
  "reasoning": [],
  "disclaimer": "Screenshot-only experimental opinion; not a verified live feed or trading instruction."
}

Use WAIT if evidence is mixed, chart reading is unreliable,
or confidence would be below 55.

Confidence reflects image clarity and visible confluence,
NOT the probability of winning.

Never guarantee a win.
Never invent information that is not visible.
`;

  try {
    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                {
                  type: "input_image",
                  image_url: image,
                  detail: "high",
                },
              ],
            },
          ],
          max_output_tokens: 700,
        }),
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.error?.message ||
        `OpenAI request failed (${response.status})`;

      return json(
        response.status === 429 ? 429 : 502,
        { error: message }
      );
    }

    const outputText = (data.output || [])
      .flatMap((item) => item.content || [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (!outputText) {
      return json(502, {
        error: "The vision model returned no analysis text",
      });
    }

    return json(200, {
      analysis: outputText,
      model,
      experimental: true,
    });

  } catch (error) {
    return json(502, {
      error: error?.message || "Visual Scan request failed",
    });
  }
}
