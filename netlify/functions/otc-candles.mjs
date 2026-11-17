export default async (request) => {
  const key = process.env.OTCHARTS_API_KEY;

  if (!key) {
    return Response.json({
      error: "OTCHARTS_API_KEY is missing from Netlify."
    }, { status: 500 });
  }

  const url = new URL(request.url);

  const symbol =
    url.searchParams.get("symbol") || "EURUSD_otc";

  // Only allow Pocket Option OTC symbols
  if (!/^[A-Z0-9#]+_otc$/.test(symbol)) {
    return Response.json({
      error: "Invalid OTC symbol."
    }, { status: 400 });
  }

  const upstream = new URL(
    "https://otcharts.com/v1/candles"
  );

  upstream.searchParams.set("venue", "otc");
  upstream.searchParams.set("symbol", symbol);

  // Native 30-second timeframe
  upstream.searchParams.set("tf", "30");

  // Candle history
  upstream.searchParams.set("limit", "500");

  try {
    const response = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });

    const text = await response.text();

    let body = {};

    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({
        error: "OTCharts returned invalid JSON."
      }, { status: 502 });
    }

    if (!response.ok) {
      return Response.json({
        error:
          body.error ||
          body.message ||
          `OTCharts HTTP ${response.status}`,
        status: response.status
      }, { status: response.status });
    }

    const candles = Array.isArray(body)
      ? body
      : (
          body.candles ||
          body.data?.candles ||
          body.data ||
          body.results ||
          []
        );

    if (!Array.isArray(candles) || !candles.length) {
      return Response.json({
        error: "No 30-second candles returned.",
        details: Object.keys(body || {})
      }, { status: 502 });
    }

    return Response.json({
      success: true,
      symbol,
      timeframe: 30,
      interval: "30s",
      count: candles.length,
      candles: candles.slice(-500),
      gaps: body.gaps || null,
      serverTime: Date.now()
    }, {
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    });

  } catch (error) {
    return Response.json({
      error:
        error?.name === "TimeoutError"
          ? "OTCharts request timed out."
          : "OTCharts connection failed: " +
            (error?.message || "Network error")
    }, { status: 502 });
  }
};
