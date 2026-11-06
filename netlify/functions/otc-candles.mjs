export default async (request) => {
  const key = process.env.OTCHARTS_API_KEY;

  if (!key) {
    return Response.json(
      { error: "OTCHARTS_API_KEY is missing from Netlify environment variables." },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") || "EURUSD_otc";

  if (!/^[A-Z0-9#]+_otc$/.test(symbol)) {
    return Response.json(
      { error: "Invalid OTC symbol." },
      { status: 400 }
    );
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
      }
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return Response.json(
        { error: body.error || `OTCharts returned HTTP ${response.status}` },
        { status: response.status }
      );
    }

    return Response.json(body, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch {
    return Response.json(
      { error: "Could not reach OTCharts. Try again later." },
      { status: 502 }
    );
  }
};
