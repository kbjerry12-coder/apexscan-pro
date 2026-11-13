export default async (request) => {
  const key = process.env.OTCHARTS_API_KEY;

  if (!key) {
    return Response.json({
      error: "OTCHARTS_API_KEY is missing from Netlify environment variables."
    }, { status: 500 });
  }

  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") || "EURUSD_otc";

  if (!/^[A-Z0-9#]+_otc$/.test(symbol)) {
    return Response.json({
      error: `Invalid OTC symbol: ${symbol}`
    }, { status: 400 });
  }

  const upstream = new URL("https://otcharts.com/v1/candles");
  upstream.searchParams.set("venue", "otc");
  upstream.searchParams.set("symbol", symbol);
  upstream.searchParams.set("tf", "60");
  upstream.searchParams.set("limit", "80");

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
    } catch {}

    if (!response.ok) {
      return Response.json({
        error: body.error || body.message ||
          `OTCharts returned HTTP ${response.status}`,
        upstreamStatus: response.status
      }, { status: response.status });
    }

    const candles = Array.isArray(body) ? body :
      (body.candles || body.data?.candles ||
       body.data || body.results || []);

    if (!Array.isArray(candles) || !candles.length) {
      return Response.json({
        error: "OTCharts responded successfully but did not return a recognized candle array.",
        responseKeys: Object.keys(body || {})
      }, { status: 502 });
    }

    return Response.json({ candles }, {
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    });

  } catch (error) {
    return Response.json({
      error: error?.name === "TimeoutError"
        ? "OTCharts request timed out."
        : "Could not reach OTCharts: " +
          (error?.message || "network error")
    }, { status: 502 });
  }
};
