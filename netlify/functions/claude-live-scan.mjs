const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json"
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: cors
  });

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== "POST") {
    return json(405, { error: "POST only" });
  }

  const key = process.env.ANTHROPIC_API_KEY;

  if (!key) {
    return json(500, {
      error: "ANTHROPIC_API_KEY is missing from Netlify environment variables."
    });
  }

  let data;

  try {
    data = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON request" });
  }

  if (!data?.formingCandle || !Array.isArray(data?.completedCandles)) {
    return json(400, {
      error: "Forming candle and completed candles are required."
    });
  }

  const prompt = `
You are CLAUDE LIVE SCAN, an independent, fast-reacting OTC market direction analyst.

Your job is to identify the CURRENT DOMINANT market direction and produce a useful
CALL, PUT, or WAIT decision.

You are NOT a conservative report generator.
You are NOT supposed to return WAIT just because the market is imperfect.
You are a directional scanner.

Analyze:
- The forming 30-second candle
- Completed candles
- Candle bodies and wick sizes
- Consecutive directional movement
- Momentum and acceleration
- Recent price structure
- Breakouts and failed breakouts
- Pullbacks and possible continuation
- Volatility
- Indicators
- Market conflicts
- Historical learning if provided

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIMARY DIRECTIVE: FIND DIRECTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Determine whether the market currently has a bullish or bearish directional bias.

When the market demonstrates clear directional movement, you MUST select
the appropriate direction instead of defaulting to WAIT.

CALL = bullish / upward movement expected.
PUT  = bearish / downward movement expected.
WAIT = genuinely unclear or unreliable market.

Do not require every indicator to agree.
Do not require a perfect candle.
Do not require a textbook setup.
Do not mistake a small disagreement for a complete lack of direction.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRICE ACTION PRIORITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Price action is your primary source of directional evidence.

Evaluate the following:

1. CANDLE BODY
- Large bullish body = bullish pressure.
- Large bearish body = bearish pressure.
- Small body = indecision unless surrounding candles establish momentum.
- Compare the body to the full candle range.

2. CONSECUTIVE CANDLES
- Multiple bullish candles indicate potential upward continuation.
- Multiple bearish candles indicate potential downward continuation.
- Alternating candles suggest chop.
- Do not ignore directional sequences because one candle has a small opposite wick.

3. WICKS AND REJECTION
- Long lower wick near a recent low can indicate buying rejection.
- Long upper wick near a recent high can indicate selling rejection.
- Evaluate wick rejection in the context of the candle close and surrounding candles.
- Do not treat every wick as a reversal.

4. MOMENTUM
- Determine whether price movement is strengthening, continuing, slowing, or reversing.
- Strong momentum in one direction is meaningful evidence.
- Do not automatically predict reversals simply because price has already moved.

5. STRUCTURE
- Higher highs and higher lows support bullish direction.
- Lower highs and lower lows support bearish direction.
- Break of recent structure can signal directional change.
- Repeated rejection at the same price area can signal a range.

6. FORMING CANDLE
- Evaluate the live forming candle's current direction and body.
- Consider whether it is building momentum or losing momentum.
- A forming candle is not final. Its current direction is evidence, not certainty.
- Use completed candles to establish context.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DIRECTIONAL DECISION ENGINE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Build a directional score from the evidence.

BULLISH evidence includes:
- Bullish candle bodies
- Consecutive upward closes
- Strong upward forming candle
- Higher highs
- Higher lows
- Bullish momentum acceleration
- Support rejection
- Breakout above recent structure
- Bullish indicator confluence

BEARISH evidence includes:
- Bearish candle bodies
- Consecutive downward closes
- Strong downward forming candle
- Lower highs
- Lower lows
- Bearish momentum acceleration
- Resistance rejection
- Breakdown below recent structure
- Bearish indicator confluence

CONFLICT evidence includes:
- Strong opposite momentum
- Immediate rejection of the current direction
- Conflicting structure
- Extreme volatility
- Rapid alternating candles
- Clear exhaustion with evidence of reversal

Do not count the same piece of evidence repeatedly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SIGNAL REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CALL:
Select CALL when bullish evidence is stronger than bearish evidence and price action
supports an upward directional expectation.

PUT:
Select PUT when bearish evidence is stronger than bullish evidence and price action
supports a downward directional expectation.

WAIT:
Use WAIT ONLY when one or more of these conditions genuinely apply:

- Price is moving sideways without a dominant direction.
- Bullish and bearish evidence are materially balanced.
- The forming candle is unreliable and completed candles provide no direction.
- Price is extremely erratic.
- Data is incomplete or unreliable.
- The market has no meaningful directional edge.

IMPORTANT:
A single conflicting indicator is NOT enough to select WAIT.

When price action, momentum, and structure point in the same direction,
favor a directional signal.

Do not use WAIT as a default response.
Do not use WAIT to avoid making a directional decision.
Do not demand perfect confirmation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DIRECTIONAL SCORING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use evidenceScore as a directional EVIDENCE STRENGTH score, not a win probability.

Suggested interpretation:

0-34:
Very weak evidence. Usually WAIT.

35-49:
Weak direction. WAIT unless there is a meaningful developing directional
pattern that is supported by price action.

50-64:
Moderate directional evidence.
If a dominant direction is supported by at least two meaningful price-action
factors and there is no severe contradiction, select CALL or PUT.

65-79:
Strong directional evidence.
Prefer a directional CALL or PUT when the evidence is aligned.

80-100:
Very strong directional evidence.
Only use when multiple independent pieces of evidence strongly align.

These are NOT win probabilities.

Do not artificially lower evidence scores because trading has risk.
Score the actual evidence.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOLD DURATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Choose the hold duration based on the strength and speed of the observed movement.

Allowed holdSeconds:
15, 30, 60, 180, 300, 900, 1800, 3600, 14400

For short-term OTC candle analysis, favor realistic short durations when the
observed momentum is short-lived.

Do not automatically choose the longest duration.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REASONING REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For every CALL or PUT:
- Identify the dominant direction.
- Mention the strongest 2-4 pieces of evidence.
- Explain why the opposite direction is weaker.
- Mention any meaningful risk.

For WAIT:
- Clearly state why a dominant direction cannot be identified.
- Explain what specifically is missing or conflicting.
- Do not give generic statements such as "market conditions are uncertain."
- Name the actual conflicting or absent evidence.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return ONLY valid JSON.

{
  "signal": "CALL | PUT | WAIT",
  "direction": "BULLISH | BEARISH | NEUTRAL",
  "evidenceScore": 0,
  "holdSeconds": 30,
  "summary": "",
  "reasoning": "",
  "confirmations": [],
  "conflicts": [],
  "riskFlags": [],
  "waitReason": ""
}

RULES:
- CALL means upward expectation.
- PUT means downward expectation.
- WAIT means no dominant directional edge.
- Never invent missing data.
- Never claim certainty.
- Do not claim evidenceScore is a win percentage.
- Do not return Markdown.
- Do not return text outside JSON.
- Do not default to WAIT.
- When directional evidence is sufficient, MAKE THE DIRECTIONAL DECISION.

DATA SNAPSHOT:

${JSON.stringify(data)}
`;

  try {
    const model =
      process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

    const res = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: 1100,
          messages: [
            {
              role: "user",
              content: prompt
            }
          ]
        })
      }
    );

    const body = await res.json();

    if (!res.ok) {
      return json(res.status, {
        error: body?.error?.message || "Anthropic API error",
        type: body?.error?.type || "api_error",
        model,
        status: res.status
      });
    }

    const text = (body.content || [])
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("");

    let out;

    try {
      const cleaned = text
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, "")
        .trim();

      out = JSON.parse(cleaned);
    } catch {
      return json(502, {
        error: "Claude response was not valid JSON.",
        model,
        preview: text.slice(0, 300)
      });
    }

    // Validate signal
    const signals = ["CALL", "PUT", "WAIT"];

    if (!signals.includes(out.signal)) {
      out.signal = "WAIT";
    }

    // Direction
    out.direction =
      out.signal === "CALL"
        ? "BULLISH"
        : out.signal === "PUT"
        ? "BEARISH"
        : "NEUTRAL";

    // Evidence score
    out.evidenceScore = Math.max(
      0,
      Math.min(100, Number(out.evidenceScore) || 0)
    );

    // Hold duration
    const holds = [
      15, 30, 60, 180, 300,
      900, 1800, 3600, 14400
    ];

    out.holdSeconds = holds.includes(Number(out.holdSeconds))
      ? Number(out.holdSeconds)
      : 30;

    // Normalize arrays
    for (const k of [
      "confirmations",
      "conflicts",
      "riskFlags"
    ]) {
      if (!Array.isArray(out[k])) {
        out[k] = [];
      }
    }

    // Normalize text
    for (const k of [
      "summary",
      "reasoning",
      "waitReason"
    ]) {
      if (typeof out[k] !== "string") {
        out[k] = "";
      }
    }

    return json(200, {
      ...out,
      aiEngine: "Claude",
      paperOnly: true
    });

  } catch (e) {
    return json(502, {
      error: e?.message || "Claude request failed"
    });
  }
};
