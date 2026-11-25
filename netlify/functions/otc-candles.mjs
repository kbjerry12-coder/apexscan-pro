// APEXSCAN PRO — OTC historical candle endpoint
// File: netlify/functions/otc-candles.mjs

const UPSTREAM_TF = 30;
const UPSTREAM_MAX = 500;
const SUPPORTED_TF = [30, 60];

function toCandle(x) {
  if (!x || typeof x !== "object") return null;

  let t = x.time ?? x.timestamp ?? x.ts ?? x.t ?? x.date;
  if (typeof t === "string" && Number.isNaN(Number(t))) {
    t = Date.parse(t);
  }

  t = Number(t);
  if (t > 1e12) t /= 1000;

  const candle = {
    time: Math.floor(t),
    open: Number(x.open ?? x.o),
    high: Number(x.high ?? x.h),
    low: Number(x.low ?? x.l),
    close: Number(x.close ?? x.c)
  };

  return Object.values(candle).every(Number.isFinite)
    ? candle
    : null;
}

function aggregate(src, seconds) {
  const out = [];

  for (const c of src) {
    const bucket = Math.floor(c.time / seconds) * seconds;
    const last = out[out.length - 1];

    if (!last || last.time !== bucket) {
      out.push({
        time: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      });
    } else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    }
  }

  if (out.length > 1 && src[0].time % seconds !== 0) {
    out.shift();
  }

  return out;
}

export default async (request) => {
  const key = process.env.OTCHARTS_API_KEY;

  if (!key) {
    return Response.json(
      { error: "OTCHARTS_API_KEY is missing from Netlify." },
      { status: 500 }
    );
  }

  const params = new URL(request.url).searchParams;

  const symbol = params.get("symbol") || "EURUSD_otc";
  const tf = Number(params.get("tf") || "30");

  const requestedLimit = Number(
    params.get("limit") || UPSTREAM_MAX
  );

  const limit = Math.min(
    UPSTREAM_MAX,
    Math.max(30, requestedLimit)
  );

  if (!/^[A-Z0-9#]+_otc$/.test(symbol)) {
    return Response.json(
      { error: "Invalid OTC symbol." },
      { status: 400 }
    );
  }

  if (!SUPPORTED_TF.includes(tf)) {
    return Response.json(
      {
        error: "Unsupported timeframe. Use tf=30 or 60.",
        supportedTimeframes: SUPPORTED_TF
      },
      { status: 400 }
    );
  }

  if (!Number.isFinite(limit)) {
    return Response.json(
      { error: "Invalid candle limit." },
      { status: 400 }
    );
  }

  const upstreamLimit =
    tf === UPSTREAM_TF ? limit : UPSTREAM_MAX;

  const upstream = new URL(
    "https://otcharts.com/v1/candles"
  );

  upstream.searchParams.set("venue", "otc");
  upstream.searchParams.set("symbol", symbol);
  upstream.searchParams.set("tf", String(UPSTREAM_TF));
  upstream.searchParams.set("limit", String(upstreamLimit));

  try {
    const response = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });

    const raw = await response.text();
    let body;

    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json(
        {
          error: "Invalid JSON returned by OTCharts.",
          details: raw.slice(0, 300)
        },
        { status: 502 }
      );
    }

    if (!response.ok) {
      return Response.json(
        {
          error:
            body?.error ||
            body?.message ||
            `OTCharts HTTP ${response.status}`,
          upstreamStatus: response.status
        },
        { status: 502 }
      );
    }

    const found = [
      body,
      body?.candles,
      body?.data?.candles,
      body?.data,
      body?.results,
      body?.result?.candles
    ].find(Array.isArray);

    const normalized = (found || [])
      .map(toCandle)
      .filter(Boolean)
      .sort((a, b) => a.time - b.time)
      .filter(
        (c, i, a) =>
          i === 0 || c.time !== a[i - 1].time
      );

    if (!normalized.length) {
      return Response.json(
        {
          error: "No usable candles returned.",
          responseKeys: Object.keys(body || {}),
          responsePreview: JSON.stringify(body).slice(0, 500)
        },
        { status: 502 }
      );
    }

    const candles =
      tf === UPSTREAM_TF
        ? normalized.slice(-limit)
        : aggregate(normalized, tf).slice(-limit);

    return Response.json(
      {
        success: true,
        symbol,
        timeframe: tf,
        interval: `${tf}s`,
        scannerTimeframe: 30,
        scannerInterval: "30s",
        candleSource:
          tf === UPSTREAM_TF
            ? "otcharts_historical_30s"
            : `otcharts_30s_aggregated_${tf}s`,
        historicalContextTimeframe: 30,
        count: candles.length,
        candles,
        serverTime: Date.now()
      },
      {
        headers: {
          "Cache-Control":
            "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
          Expires: "0"
        }
      }
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error?.message ||
          "OTCharts connection failed.",
        type: error?.name || "NetworkError"
      },
      { status: 502 }
    );
  }
};
