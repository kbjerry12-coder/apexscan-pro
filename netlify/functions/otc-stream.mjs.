export default async (request) => {
  const key = process.env.OTCHARTS_API_KEY;

  if (!key) {
    return Response.json(
      { error: "OTCHARTS_API_KEY is missing." },
      { status: 500 }
    );
  }

  const upstream = new URL("https://otcharts.com/v1/stream");
  upstream.searchParams.set("venue", "otc");
  upstream.searchParams.set(
    "symbol",
    "EURUSD_otc,GBPUSD_otc,USDJPY_otc"
  );

  try {
    const response = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "text/event-stream"
      }
    });

    if (!response.ok) {
      const error = await response.text();
      return new Response(error, {
        status: response.status
      });
    }

    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform"
      }
    });
  } catch {
    return Response.json(
      { error: "OTCharts stream connection failed." },
      { status: 502 }
    );
  }
};
