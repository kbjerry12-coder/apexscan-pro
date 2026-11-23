const ALLOWED_HOLDS = [15, 30, 60, 180, 300, 900, 1800, 3600, 14400];

const cleanList = (v) =>
  Array.isArray(v) ? v.slice(0, 10).map(x => String(x).slice(0, 240)) : [];

const clamp = (n, min, max) =>
  Math.max(min, Math.min(max, Number(n) || min));

const direction = (v) =>
  ['CALL', 'PUT', 'WAIT'].includes(String(v).toUpperCase())
    ? String(v).toUpperCase()
    : 'WAIT';

const hold = (v) =>
  ALLOWED_HOLDS.includes(Number(v)) ? Number(v) : 60;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 204, headers: cors(), body: '' };

  if (event.httpMethod !== 'POST')
    return reply(405, { error: 'POST required' });

  if (!process.env.OPENAI_API_KEY)
    return reply(500, { error: 'OPENAI_API_KEY is missing' });

  let data;

  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return reply(400, { error: 'Invalid JSON body' });
  }

  const candles = Array.isArray(data.completedCandles)
    ? data.completedCandles.slice(-120)
    : [];

  const payload = {
    pair: String(data.pair || data.symbol || 'unknown'),
    timeframe: String(data.timeframe || data.timeframeSeconds || 'unknown'),
    scanType: String(data.scanType || 'EARLY'),
    currentPrice: data.latestVerifiedPrice ?? data.formingCandle?.close ?? null,
    priceTimestamp: data.priceTimestamp ?? data.formingCandle?.time ?? null,
    formingCandle: data.formingCandle || null,
    formingCandleAgeSeconds: data.formingCandleAgeSeconds ?? null,
    indicators: data.indicators || {},
    candlestickPatterns: cleanList(data.candlePatterns),
    chartPatterns: cleanList(data.chartPatterns),
    recentCompletedCandles: candles,
    localEvidence: data.ruleSignal || null
  };

  const system = `You are APEXSCAN PRO's decisive OTC market-direction analyst.

You are NOT a rigid signal detector, checklist, or confirmation gate.

YOUR JOB:
Read the market and make a directional decision based on what price is
actually doing. Do not sit on WAIT while price action and indicators
provide a reasonably readable directional bias.

ANALYZE:
- Current candle direction and developing movement
- Recent candle sequence and color
- Higher highs and higher lows
- Lower highs and lower lows
- Momentum and momentum acceleration/deceleration
- Candle body size relative to wick size
- Rejection wicks and exhaustion
- Engulfing and reversal behavior
- Pullbacks and continuation
- Breakouts and breakdowns
- Support and resistance
- Market structure
- Trend direction
- MACD and signal relationship
- Stochastic K/D relationship and position
- Bollinger position and middle-band behavior
- EMA relationships when supplied
- Conflicting signals and their relative strength

CANDLE PATTERN RECOGNITION:
Recognize these when supported by actual candle data:

Bullish:
Hammer, inverted hammer, bullish engulfing, piercing pattern,
morning star, bullish harami, dragonfly doji, tweezer bottom,
three white soldiers, rising three methods, bullish marubozu,
three inside up, bullish kicker, bullish belt hold, bullish pin bar,
abandoned baby bullish, bullish breakout, bullish continuation.

Bearish:
Shooting star, hanging man, bearish engulfing, dark cloud cover,
evening star, bearish harami, gravestone doji, tweezer top,
three black crows, falling three methods, bearish marubozu,
three inside down, bearish kicker, bearish belt hold, bearish pin bar,
abandoned baby bearish, bearish breakdown, bearish continuation.

CHART PATTERN RECOGNITION:
Identify when evidence exists:
Double top, double bottom, head and shoulders,
inverse head and shoulders, ascending triangle, descending triangle,
symmetrical triangle, rising wedge, falling wedge,
bull flag, bear flag, bullish pennant, bearish pennant,
ascending channel, descending channel, range breakout,
range breakdown, compression, expansion, trend continuation,
trend reversal, swing failure, support rejection, resistance rejection.

Do not invent a pattern. If it is forming but not confirmed,
identify it as a developing or candidate pattern.

DIRECTIONAL DECISION:
Indicators are evidence, NOT gates.

Do not require:
- All indicators to agree
- Multiple confirmations
- Perfect pattern completion
- A minimum confluence checklist
- A fully closed candle for EARLY scans
- An arbitrarily high confidence threshold

When bullish evidence is stronger, choose CALL.
When bearish evidence is stronger, choose PUT.

When indicators conflict, WEIGH THEM. Determine which side has
the stronger price action and momentum. Do not automatically turn
conflict into WAIT.

If the market is moving clearly green with bullish momentum,
recognize the bullish bias.

If the market is moving clearly red with bearish momentum,
recognize the bearish bias.

WAIT is reserved for genuinely flat, chaotic, or directionless price
action with no credible directional advantage, or unreliable/stale data.

If one side has even a moderate but credible directional advantage,
make the directional call and explain its risk.

EARLY SCAN:
Analyze the currently developing candle and immediate live movement.
Make a timely directional judgment. Clearly note that a forming candle
can reverse before close. Do not wait for candle completion.

REGULAR SCAN:
Analyze the latest completed candle together with the broader structure.
Do not mechanically copy the previous EARLY signal. Re-evaluate the market.

OUTPUT:
Return a CALL, PUT, or WAIT.
Give a realistic evidence score from 0-100.
Select holdSeconds only from the allowed list.
Explain the actual price behavior behind your decision.
List bullish evidence, bearish evidence, detected patterns, momentum,
trend, candle structure, chart pattern, conflicts, and risk flags.

Never fabricate candles, prices, indicators, volume, or patterns.
Use only the supplied data.

Return valid JSON only.`;

  const schema = {
    type: 'object',
    properties: {
      signal: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['CALL', 'PUT', 'WAIT']
          },
          evidenceScore: {
            type: 'integer',
            minimum: 0,
            maximum: 100
          },
          holdSeconds: {
            type: 'integer',
            enum: ALLOWED_HOLDS
          },
          reasoning: {
            type: 'string'
          }
        },
        required: [
          'direction',
          'evidenceScore',
          'holdSeconds',
          'reasoning'
        ],
        additionalProperties: false
      },
      analysis: {
        type: 'object',
        properties: {
          bullishEvidence: {
            type: 'array',
            items: { type: 'string' }
          },
          bearishEvidence: {
            type: 'array',
            items: { type: 'string' }
          },
          momentum: { type: 'string' },
          trend: { type: 'string' },
          candleStructure: { type: 'string' },
          chartPattern: { type: 'string' },
          detectedPatterns: {
            type: 'array',
            items: { type: 'string' }
          },
          conflicts: {
            type: 'array',
            items: { type: 'string' }
          },
          riskFlags: {
            type: 'array',
            items: { type: 'string' }
          },
          finalReasoning: { type: 'string' }
        },
        required: [
          'bullishEvidence',
          'bearishEvidence',
          'momentum',
          'trend',
          'candleStructure',
          'chartPattern',
          'detectedPatterns',
          'conflicts',
          'riskFlags',
          'finalReasoning'
        ],
        additionalProperties: false
      }
    },
    required: ['signal', 'analysis'],
    additionalProperties: false
  };

  try {
    const response = await fetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-6',
          temperature: 0.35,
          max_tokens: 1100,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'apexscan_directional_analysis',
              strict: true,
              schema
            }
          },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(payload) }
          ]
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      return reply(
        response.status,
        { error: result?.error?.message || `OpenAI API HTTP ${response.status}` }
      );
    }

    const content = result?.choices?.[0]?.message?.content;

    if (!content)
      return reply(502, { error: 'OpenAI returned empty analysis' });

    const parsed = JSON.parse(content);

    parsed.signal.direction = direction(parsed.signal.direction);
    parsed.signal.evidenceScore = Math.round(
      clamp(parsed.signal.evidenceScore, 0, 100)
    );
    parsed.signal.holdSeconds = hold(parsed.signal.holdSeconds);

    parsed.analysis.bullishEvidence =
      cleanList(parsed.analysis.bullishEvidence);
    parsed.analysis.bearishEvidence =
      cleanList(parsed.analysis.bearishEvidence);
    parsed.analysis.detectedPatterns =
      cleanList(parsed.analysis.detectedPatterns);
    parsed.analysis.conflicts =
      cleanList(parsed.analysis.conflicts);
    parsed.analysis.riskFlags =
      cleanList(parsed.analysis.riskFlags);

    parsed.model = process.env.OPENAI_MODEL || 'gpt-6';

    return reply(200, parsed);

  } catch (err) {
    return reply(
      502,
      { error: `OpenAI scan failed: ${err.message || err}` }
    );
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...cors(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  };
}
