
export default async (request) => {
  const key = process.env.OTCHARTS_API_KEY;

  if (!key) {
    return Response.json({
      error: "OTCHARTS_API_KEY is missing from Netlify environment variables."
    }, { status: 500 });
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get("symbol") || "EURUSD_otc";

  const symbols = [
    ...new Set(
      raw.split(",").map(s => s.trim()).filter(Boolean)
    )
  ];

  // OTCharts Lite: maximum five instruments per stream.
  if (
    !symbols.length ||
    symbols.length > 5 ||
    symbols.some(s => !/^[A-Z0-9#]+_otc$/.test(s))
  ) {
    return Response.json({
      error: "Invalid OTC stream symbols. Supply 1–5 comma-separated symbols ending in _otc.",
      received: symbols
    }, { status: 400 });
  }

  const upstream = new URL("https://otcharts.com/v1/stream");

  upstream.searchParams.set("venue", "otc");
  upstream.searchParams.set("symbol", symbols.join(","));

  try {
    const response = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "text/event-stream"
      },
      signal: request.signal
    });

    if (!response.ok) {
      const text = await response.text();
      let body = {};

      try {
        body = JSON.parse(text);
      } catch {}

      return Response.json({
        error: body.error ||
          body.message ||
          `OTCharts stream returned HTTP ${response.status}`,
        details: body,
        retryAfter: response.headers.get("retry-after")
      }, {
        status: response.status,
        headers: response.headers.get("retry-after")
          ? { "Retry-After": response.headers.get("retry-after") }
          : {}
      });
    }

    if (!response.body) {
      return Response.json({
        error: "OTCharts returned no stream body."
      }, { status: 502 });
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no"
      }
    });

  } catch (error) {
    return Response.json({
      error: error?.name === "AbortError"
        ? "OTCharts stream was closed by the browser."
        : "OTCharts stream connection failed: " +
          (error?.message || "network error")
    }, { status: 502 });
  }
};
