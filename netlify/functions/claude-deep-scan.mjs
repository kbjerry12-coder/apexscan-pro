// APEXSCAN PRO — Claude Run Deep endpoint
// File: netlify/functions/claude-deep-scan.mjs
// Requires ANTHROPIC_API_KEY in Netlify environment variables.

const ALLOWED_DIRECTIONS = new Set(["CALL", "PUT", "WAIT"]);
const ALLOWED_HOLDS = new Set([15, 30, 60, 120, 300]);

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const rateBuckets = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const key = String(ip || "unknown").slice(0, 100);
  const bucket = rateBuckets.get(key) || [];
  const recent = bucket.filter((t) => now - t < RATE_WINDOW_MS);

  if (recent.length >= RATE_MAX) return true;

  recent.push(now);
  rateBuckets.set(key, recent);

  if (rateBuckets.size > 500) {
    for (const [k, v] of rateBuckets) {
      if (!v.length || now - v[v.length - 1] > RATE_WINDOW_MS) {
        rateBuckets.delete(k);
      }
    }
  }

  return false;
}

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  },
  body: JSON.stringify(body)
});

function extractJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) return null;

  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}

  const start = cleaned.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;

      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);

        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
          }
        } catch {}

        return null;
      }
    }
  }

  return null;
}

async function callClaude({
  apiKey,
  model,
  system,
  messages,
  maxTokens = 700,
  timeoutMs = 25000
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages
      }),
      signal: controller.signal
    });

    const responseText = await upstream.text();
    let responseJson;

    try {
      responseJson = JSON.parse(responseText);
    } catch {
      return {
        ok: false,
        status: upstream.status,
        error: "Anthropic returned an unreadable API response."
      };
    }

    if (!upstream.ok) {
      return {
        ok: false,
        status: upstream.status,
        error: responseJson?.error?.message || "Anthropic API request failed"
      };
    }

    const raw = (responseJson.content || [])
      .filter((x) => x.type === "text")
      .map((x) => x.text || "")
      .join("\n")
      .trim();

    return { ok: true, raw, responseJson };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "AbortError"
        ? "Claude request timed out."
        : error?.message || "Claude request failed"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatDeepScan(o) {
  const lines = [
    `${o.direction} · Strength ${o.strength}/100 · Risk ${o.risk}`,
    o.reason,
    `Invalidation: ${o.invalidation}`
  ];

  if (o.holdSeconds) lines.push(`Suggested hold: ${o.holdSeconds}s`);
  lines.push(`Caution: ${o.caution}`);

  return lines.filter(Boolean).join("\n\n");
}

export default async function handler(request, context) {
  const cors = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": new URL(request.url).origin,
    "Vary": "Origin"
  };

  const respond = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: cors });

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }

  if (request.method !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  const clientIp =
    context?.ip ||
    request.headers.get("x-nf-client-connection-ip") ||
    "unknown";

  if (rateLimited(clientIp)) {
    return respond(429, {
      error: "Deep Scan limit reached. Try again in about one minute."
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return respond(500, {
      error: "ANTHROPIC_API_KEY is not configured in Netlify."
    });
  }

  let rawBody;

  try {
    rawBody = await request.text();
  } catch {
    return respond(400, { error: "Could not read request body" });
  }

  if (rawBody.length > 40_000) {
    return respond(413, { error: "Deep Scan payload is too large" });
  }

  let input;

  try {
    input = JSON.parse(rawBody || "{}");
  } catch {
    return respond(400, { error: "Invalid JSON request body" });
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return respond(400, { error: "Request payload must be an object" });
  }

  const rawCandles = Array.isArray(input.recentCandles)
    ? input.recentCandles
    : Array.isArray(input.candles)
      ? input.candles
      : [];

  const candles = rawCandles.slice(-40);

  if (candles.length < 8) {
    return respond(400, {
      error: "At least 8 recent candles are required"
    });
  }

  const safeCandles = candles
    .map((c) => ({
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number.isFinite(Number(c.volume))
        ? Number(c.volume)
        : null
    }))
    .filter((c) =>
      [c.open, c.high, c.low, c.close].every(Number.isFinite)
    );

  if (safeCandles.length < 8) {
    return respond(400, {
      error: "Candle data is incomplete or invalid"
    });
  }

  const num = (v) =>
    v == null || v === ""
      ? null
      : Number.isFinite(Number(v))
        ? Number(v)
        : null;

  const ind =
    input.indicators && typeof input.indicators === "object"
      ? input.indicators
      : {};

  const cleanText = (v, max = 240) => String(v ?? "").slice(0, max);

  const cleanList = (v, max = 12) =>
    Array.isArray(v)
      ? v.slice(0, max).map((x) => cleanText(x, 180))
      : [];

  const fc =
    input.fourCandleScan && typeof input.fourCandleScan === "object"
      ? input.fourCandleScan
      : {};

  const formation =
    input.formationBrain && typeof input.formationBrain === "object"
      ? input.formationBrain
      : {};

  const safeContext = {
    direction: cleanText(fc.direction, 20),
    evidenceScore: num(fc.evidenceScore),
    fakeoutRisk: cleanText(fc.fakeoutRisk, 30),
    riskReasons: cleanList(fc.riskReasons),
    waitReasons: cleanList(fc.waitReasons),

    candleDNA: Array.isArray(fc.candleDNA)
      ? fc.candleDNA.slice(-4).map((x) => ({
          candle: num(x.candle),
          type: cleanText(x.type, 100),
          bodyStrength: num(x.bodyStrength),
          upperWick: num(x.upperWick),
          lowerWick: num(x.lowerWick),
          closesIn: cleanText(x.closesIn, 40),
          inControl: cleanText(x.inControl, 30),
          srRejection: cleanText(x.srRejection, 60)
        }))
      : [],

    momentumLoss:
      fc.momentumLoss && typeof fc.momentumLoss === "object"
        ? {
            side: cleanText(fc.momentumLoss.side, 20),
            reasons: cleanList(fc.momentumLoss.reasons)
          }
        : null,

    patterns: Array.isArray(fc.patterns)
      ? fc.patterns.slice(-8).map((x) => ({
          name: cleanText(x.name, 80),
          bias: cleanText(x.bias, 20),
          endsOnCandle: num(x.endsOnCandle)
        }))
      : [],

    oscillators:
      fc.oscillators && typeof fc.oscillators === "object"
        ? {
            deMarker: num(fc.oscillators.deMarker),
            williamsR: num(fc.oscillators.williamsR)
          }
        : {},

    indicatorAgreement: cleanText(fc.indicatorsBullish, 30),

    momentumRadar:
      fc.momentumRadar && typeof fc.momentumRadar === "object"
        ? fc.momentumRadar
        : null,

    patternMemory:
      fc.patternMemory && typeof fc.patternMemory === "object"
        ? fc.patternMemory
        : null,

    evidence: Array.isArray(fc.evidence)
      ? fc.evidence.slice(0, 14).map((x) => ({
          name: cleanText(x.name, 50),
          score: num(x.score),
          detail: cleanText(x.detail, 140)
        }))
      : [],

    formationBrain: {
      direction: cleanText(formation.direction, 40),
      summary: cleanText(formation.summary, 300),
      pattern: cleanText(formation.pattern, 100),
      samples: num(formation.samples),
      wickPressure: cleanText(formation.wickPressure, 80),
      priorMovement: cleanText(formation.priorMovement, 80),
      method: cleanText(formation.method, 240)
    }
  };

  const payload = {
    pair: String(input.pair || input.symbol || "Unknown pair").slice(0, 80),
    symbol: String(input.symbol || "").slice(0, 80),
    market: String(input.market || "OTC").slice(0, 30),

    timeframe: String(
      input.scanTimeframe ||
      (num(input.timeframe) > 0
        ? `${num(input.timeframe)}-second candles`
        : "30-second candles")
    ).slice(0, 40),

    requestedHoldSeconds: num(input.hold_seconds ?? input.holdSeconds),

    indicators: {
      macd: num(ind.macd),
      macdSignal: num(ind.macdSignal),
      stochasticK: num(ind.stochasticK),
      stochasticD: num(ind.stochasticD),
      ema9: num(ind.ema9),
      ema21: num(ind.ema21),
      bollinger: Array.isArray(ind.bollinger)
        ? ind.bollinger.slice(0, 3).map(num)
        : null
    },

    forecast: String(input.forecast || "next candle").slice(0, 60),

    price: num(input.price) ?? safeCandles[safeCandles.length - 1].close,

    localDirection: ALLOWED_DIRECTIONS.has(input.localDirection)
      ? input.localDirection
      : "WAIT",

    localScore: Math.max(
      0,
      Math.min(100, Math.round(Number(input.localScore) || 0))
    ),

    candleBody: String(input.candleBody || "").slice(0, 80),

    bodyPercent: Math.max(
      0,
      Math.min(100, Math.round(Number(input.bodyPercent) || 0))
    ),

    wickStructure: String(input.wickStructure || "").slice(0, 100),
    momentum: String(input.momentum || "").slice(0, 50),

    volumeRatio: Number.isFinite(Number(input.volumeRatio))
      ? Number(input.volumeRatio)
      : null,

    riskAssessment: String(input.riskAssessment || "").slice(0, 100),

    indicatorLayers: Array.isArray(input.indicatorLayers)
      ? input.indicatorLayers.slice(0, 12).map((x) => ({
          name: String(x.name || "").slice(0, 60),
          value: String(x.value || "").slice(0, 100),
          bull: !!x.bull,
          bear: !!x.bear
        }))
      : [],

    candles: safeCandles,
    scannerContext: safeContext
  };

  const system = `You are Claude acting as an independent market-structure analyst for APEXSCAN PRO.

Analyze the supplied completed OTC candles and scannerContext. Use candle direction, body strength, upper/lower wicks, rejection, momentum loss, named candle patterns, DeMarker, Williams %R, momentum-radar readings, pattern-memory counts, evidence scores, fakeout risk and the historical formation estimate when present.

The formationBrain is a nearest-historical-analogs heuristic, not a calibrated probability or a guarantee. Treat its sample count and outcome as supporting context only. Distinguish measured values from descriptive labels. Never invent RSI, CCI, MACD, volume, support/resistance levels, or indicator readings that are absent. If requestedHoldSeconds is supplied, judge direction over that holding window.

Do not blindly follow the local scanner.
Independently analyze the supplied data.

This is analysis only. Do not claim certainty or guaranteed wins.
If evidence is mixed or insufficient, choose WAIT.

Return ONE JSON object only. No markdown and no extra text.

Use exactly these keys:
{
  "direction": "CALL | PUT | WAIT",
  "strength": 0,
  "reason": "Short analysis",
  "risk": "Low | Moderate | High",
  "invalidation": "What invalidates this analysis",
  "holdSeconds": 15,
  "caution": "Risk or limitation"
}

Rules:
- strength must be an integer from 0 to 100.
- holdSeconds must be 15, 30, 60, 120, 300, or null.
- Do not return markdown.
- Do not add text outside the JSON.`;

  const userPrompt = `Analyze this live market snapshot:

${JSON.stringify(payload)}

Return the required JSON object only.`;

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

  try {
    const first = await callClaude({
      apiKey,
      model,
      system,
      messages: [{ role: "user", content: userPrompt }]
    });

    if (!first.ok) {
      return respond(
        first.status >= 500 ? 502 : first.status || 502,
        { error: first.error || "Claude Deep Scan failed" }
      );
    }

    let result = extractJsonObject(first.raw);
    let repairAttempted = false;

    if (!result) {
      repairAttempted = true;

      const repair = await callClaude({
        apiKey,
        model,
        maxTokens: 500,
        timeoutMs: 15000,

        system:
          "You are a strict JSON repair service. " +
          "Convert the supplied Claude analysis into one valid " +
          "JSON object matching the required schema. " +
          "Do not add new market claims. " +
          "If a field is missing, use conservative defaults. " +
          "Return only JSON.",

        messages: [{
          role: "user",
          content: `Repair/format this response as valid JSON with keys:
direction (CALL/PUT/WAIT),
strength (0-100 integer),
reason,
risk (Low/Moderate/High),
invalidation,
holdSeconds (15/30/60/120/300/null),
caution.

Preserve the analysis meaning.
Do not invent evidence.

Original response:
${first.raw}`
        }]
      });

      if (repair.ok) result = extractJsonObject(repair.raw);
    }

    if (!result) {
      return respond(502, {
        error: "Claude response could not be converted to valid JSON after one repair attempt.",
        repairAttempted,
        detail: "No directional forecast was issued because the response format could not be validated."
      });
    }

    const direction = String(result.direction || "").toUpperCase();

    if (!ALLOWED_DIRECTIONS.has(direction)) {
      return respond(502, {
        error: "Claude returned an invalid direction",
        repairAttempted
      });
    }

    const strength = Math.max(
      0,
      Math.min(100, Math.round(Number(result.strength) || 0))
    );

    const hold = Number(result.holdSeconds);

    const out = {
      direction,
      strength,

      reason: String(result.reason || "No reasoning provided").slice(0, 900),
      risk: String(result.risk || "Unspecified").slice(0, 160),
      invalidation: String(result.invalidation || "Not clear").slice(0, 220),

      holdSeconds: ALLOWED_HOLDS.has(hold) ? hold : null,

      caution: String(
        result.caution || "AI analysis is uncertain and is not a guarantee."
      ).slice(0, 300),

      model,
      repairAttempted
    };

    return respond(200, {
      ...out,
      deepScan: formatDeepScan(out)
    });
  } catch (error) {
    return respond(502, {
      error: error?.message || "Claude Deep Scan could not complete"
    });
  }
}
