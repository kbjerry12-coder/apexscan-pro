export default async (request) => {
  const key = process.env.OTCHARTS_API_KEY;

  if (!key) {
    return Response.json({
      error: "OTCHARTS_API_KEY is missing from Netlify environment variables."
    }, { status: 500 });
  }

  const url = new URL(request.url);

  const raw = url.searchParams.get("symbol") || "EURUSD_otc";

  const symbols = [...new Set(
    raw.split(",").map(s => s.trim()).filter(Boolean)
  )];

  // OTCharts Lite supports up to 5 instruments per stream.
  if (
    !symbols.length ||
    symbols.length > 5 ||
    symbols.some(s => !/^[A-Z0-9#]+_otc$/.test(s))
  ) {
    return Response.json({
      error: "Invalid OTC stream symbols.",
      received: symbols
    }, { status: 400 });
  }

  const upstream = new URL("https://otcharts.com/v1/stream");

  upstream.searchParams.set("venue", "otc");
  upstream.searchParams.set("symbol", symbols.join(","));

  try {
    const response = await fetch(upstream, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "User-Agent": "APEXSCAN-PRO"
      },
      signal: request.signal
    });

    if (!response.ok) {
      const text = await response.text();

      let body = {};

      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }

      return Response.json({
        error:
          body.error ||
          body.message ||
          `OTCharts returned HTTP ${response.status}`,

        status: response.status,
        details: body,

        retryAfter:
          response.headers.get("retry-after")
      }, {
        status: response.status,
        headers: {
          ...(response.headers.get("retry-after")
            ? {
                "Retry-After":
                  response.headers.get("retry-after")
              }
            : {})
        }
      });
    }

    if (!response.body) {
      return Response.json({
        error: "OTCharts returned no stream body."
      }, { status: 502 });
    }

    // Forward the actual upstream SSE stream.
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
        "Retry": "3000",

        ...(response.headers.get("x-otc-dropped")
          ? {
              "X-OTC-Dropped":
                response.headers.get("x-otc-dropped")
            }
          : {})
      }
    });

  } catch (error) {
    return Response.json({
      error:
        error?.name === "AbortError"
          ? "Stream connection was cancelled."
          : "OTCharts connection failed.",

      details: error?.message || "Unknown network error"
    }, { status: 502 });
  }
};
