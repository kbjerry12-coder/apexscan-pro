export default async (request) => {
  const key = process.env.OTCHARTS_API_KEY;

  if (!key) {
    return new Response(
      `event: stream_error
data: ${JSON.stringify({
  error: "OTCHARTS_API_KEY is missing from Netlify environment variables."
})}

`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-store",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }

  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") || "EURUSD_otc";

  if (!/^[A-Z0-9#]+_otc$/.test(symbol)) {
    return new Response(
      `event: stream_error
data: ${JSON.stringify({
  error: "Invalid OTC symbol",
  symbol
})}

`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache"
        }
      }
    );
  }

  const upstream = new URL("https://otcharts.com/v1/stream");

  upstream.searchParams.set("venue", "otc");
  upstream.searchParams.set("symbol", symbol);

  try {
    const response = await fetch(upstream.toString(), {
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
      const raw = await response.text();

      let details;

      try {
        details = JSON.parse(raw);
      } catch {
        details = raw;
      }

      const errorPayload = {
        error: "OTCharts stream connection rejected",
        status: response.status,
        statusText: response.statusText,
        symbol,
        details,
        retryAfter: response.headers.get("retry-after")
      };

      return new Response(
        `event: stream_error
data: ${JSON.stringify(errorPayload)}

`,
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no"
          }
        }
      );
    }

    if (!response.body) {
      return new Response(
        `event: stream_error
data: ${JSON.stringify({
  error: "OTCharts returned HTTP 200 but no stream body.",
  symbol
})}

`,
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache"
          }
        }
      );
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store, no-transform",
        "X-Accel-Buffering": "no"
      }
    });

  } catch (error) {
    return new Response(
      `event: stream_error
data: ${JSON.stringify({
  error: "OTCharts connection failed",
  details: error?.message || "Unknown network error",
  symbol
})}

`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-store"
        }
      }
    );
  }
};
