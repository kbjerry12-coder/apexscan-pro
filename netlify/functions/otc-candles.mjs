// APEXSCAN PRO — OTC candles endpoint (1-minute compatibility)
// Netlify Function: /.netlify/functions/otc-candles

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
  const tf = params.get("tf") || "60";
  const limit = Math.min(
    500,
    Math.max(30, Number(params.get("limit") || 500))
  );

  if (!/^[A-Z0-9#]+_otc$/.test(symbol)) {
    return Response.json(
      { error: "Invalid OTC symbol." },
      { status: 400 }
    );
  }

  // Configured for native 1-minute candles.
  if (tf !== "60") {
    return Response.json(
      {
        error: "This APEXSCAN endpoint is configured for 1-minute candles (tf=60).",
        supportedTimeframes: [60]
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

  const upstream = new URL("https://otcharts.com/v1/candles");
  upstream.searchParams.set("venue", "otc");
  upstream.searchParams.set("symbol", symbol);
  upstream.searchParams.set("tf", "60");
  upstream.searchParams.set("limit", String(limit));

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

    const candidates = [
      body,
      body?.candles,
      body?.data?.candles,
      body?.data,
      body?.results,
      body?.result?.candles
    ];

    const candles = candidates.find(Array.isArray);

    if (!candles?.length) {
      return Response.json(
        {
          error: "No candle array returned.",
          responseKeys: Object.keys(body || {}),
          responsePreview: JSON.stringify(body).slice(0, 500)
        },
        { status: 502 }
      );
    }

    return Response.json(
      {
        success: true,
        symbol,
        timeframe: 60,
        interval: "1m",
        count: candles.length,
        candles: candles.slice(-limit),
        serverTime: Date.now()
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
        error: error?.message || "OTCharts connection failed.",
        type: error?.name || "NetworkError"
      },
      { status: 502 }
    );
  }
};
