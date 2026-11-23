// Auto-scan brain: Claude. Needs ANTHROPIC_API_KEY set in Netlify environment variables.
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { error: "ANTHROPIC_API_KEY is not set in Netlify" });

  let d;
  try { d = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON" }); }

  const payload = {
    pair: d.pair, timeframe: d.timeframe, livePrice: d.livePrice,
    formingCandle: d.formingCandle, formingCandleAgeSeconds: d.formingCandleAgeSeconds,
    indicators: d.indicators, ruleSignal: d.ruleSignal,
    completedCandles: (d.completedCandles || []).slice(-60),
  };

  const system =
    "You analyze OTC forex candles for a paper-trading scanner. Using the completed candles, the forming candle and the indicators, " +
    "decide the likely direction of the NEXT candle. Reply with ONLY a JSON object, no markdown: " +
    '{"direction":"CALL"|"PUT"|"WAIT","evidenceScore":0-100,"reasoning":"one or two short sentences","holdSeconds":30|60|120|300}. ' +
    "Use WAIT when the evidence is mixed or weak. Be honest about uncertainty.";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return json(r.status, { error: data?.error?.message || `Anthropic HTTP ${r.status}` });

    const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
    const out = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const direction = String(out.direction || "WAIT").toUpperCase();
    return json(200, {
      model: data.model || MODEL,
      signal: {
        direction: ["CALL", "PUT", "WAIT"].includes(direction) ? direction : "WAIT",
        evidenceScore: Math.max(0, Math.min(100, Math.round(Number(out.evidenceScore) || 0))),
        reasoning: String(out.reasoning || ""),
        holdSeconds: Number(out.holdSeconds) || 60,
      },
    });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};
