// APEXSCAN PRO — isolated US stock and ETF candle endpoint
// Uses the existing TWELVE_DATA_API_KEY. Does not call or modify OTCharts.

const ALLOWED = new Set(["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "META", "SPY", "GOOGL"]);
const INTERVALS = new Map([[60, "1min"], [300, "5min"]]);

function exchangeLocalToEpoch(raw, timeZone) {
  const match = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return Date.parse(raw);

  const [, y, mo, d, h, mi, sec = "0"] = match;
  const target = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  let guess = target;

  // Convert exchange wall-clock time to UTC.
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess))
        .filter(p => p.type !== "literal")
        .map(p => [p.type, p.value])
    );

    const observed = Date.UTC(
      +parts.year,
      +parts.month - 1,
      +parts.day,
      +parts.hour,
      +parts.minute,
      +parts.second
    );

    const delta = target - observed;
    guess += delta;

    if (!delta) break;
  }

  return guess;
}

function parseCandle(row, exchangeTimezone = "America/New_York") {
  const raw = String(row?.datetime ?? row?.time ?? "");
  const hasOffset = /[zZ]|[+-]\d\d:\d\d$/.test(raw);

  const ms = hasOffset
    ? Date.parse(raw)
    : exchangeLocalToEpoch(raw, exchangeTimezone);

  const candle = {
    time: Math.floor(ms / 1000),
    open: Number(row?.open),
    high: Number(row?.high),
    low: Number(row?.low),
    close: Number(row?.close)
  };

  return Number.isFinite(candle.time) &&
    [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
    ? candle
    : null;
}

export default async (request) => {
  if (request.method !== "GET") {
    return Response.json({ error: "GET required" }, { status: 405 });
  }

  const key = process.env.TWELVE_DATA_API_KEY;

  if (!key) {
    return Response.json(
      { error: "TWELVE_DATA_API_KEY is missing from Netlify environment variables." },
      { status: 500 }
    );
  }

  const params = new URL(request.url).searchParams;
  const symbol = String(params.get("symbol") || "AAPL").toUpperCase();
  const seconds = Number(params.get("tf") || "60");
  const interval = INTERVALS.get(seconds);
  const requestedLimit = Number(params.get("limit") || "300");

  if (!ALLOWED.has(symbol)) {
    return Response.json(
      {
        error: "Unsupported stock symbol.",
        allowedSymbols: [...ALLOWED]
      },
      { status: 400 }
    );
  }

  if (!interval) {
    return Response.json(
      {
        error: "Stock candles support 60 seconds (1min) and 300 seconds (5min) only.",
        supportedTimeframes: [60, 300]
      },
      { status: 400 }
    );
  }

  if (!Number.isFinite(requestedLimit)) {
    return Response.json(
      { error: "Invalid candle limit." },
      { status: 400 }
    );
  }

  const limit = Math.min(500, Math.max(30, Math.floor(requestedLimit)));

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(limit));
  url.searchParams.set("order", "ASC");
  url.searchParams.set("apikey", key);

  try {
    const upstream = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      cache: "no-store"
    });

    const body = await upstream.json().catch(() => null);

    if (!upstream.ok || body?.status === "error" || body?.code) {
      return Response.json(
        {
          error: body?.message || body?.msg ||
            `Twelve Data HTTP ${upstream.status}`,
          provider: "Twelve Data",
          upstreamStatus: upstream.status,
          providerCode: body?.code || null
        },
        { status: 502 }
      );
    }

    const exchangeTimezone =
      body?.meta?.exchange_timezone || "America/New_York";

    const candles = (Array.isArray(body?.values) ? body.values : [])
      .map(row => parseCandle(row, exchangeTimezone))
      .filter(Boolean)
      .sort((a, b) => a.time - b.time)
      .filter((c, i, all) => i === 0 || c.time !== all[i - 1].time)
      .slice(-limit);

    if (candles.length < 8) {
      return Response.json(
        {
          error: `Twelve Data returned only ${candles.length} usable ${interval} candles for ${symbol}. The market may be closed or the plan may not include this data.`,
          symbol,
          interval,
          count: candles.length,
          provider: "Twelve Data"
        },
        { status: 502 }
      );
    }

    return Response.json(
      {
        success: true,
        market: "US equities",
        provider: "Twelve Data",
        symbol,
        timeframe: seconds,
        interval,
        count: candles.length,
        candles,
        serverTime: Date.now(),
        exchangeTimezone,
        exchange: body?.meta?.exchange || null
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
          Expires: "0"
        }
      }
    );
  } catch (error) {
    return Response.json(
      {
        error: error?.message || "Twelve Data connection failed.",
        provider: "Twelve Data",
        type: error?.name || "NetworkError"
      },
      { status: 502 }
    );
  }
};
