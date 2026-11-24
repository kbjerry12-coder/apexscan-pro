// APEXSCAN PRO — single-symbol OTC live stream relay
// File: netlify/functions/otc-stream.mjs

export default async (request) => {
  const key = process.env.OTCHARTS_API_KEY;

  const headers = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*"
  };

  const sendError = (payload) =>
    new Response(
      `event: stream_error\ndata: ${JSON.stringify(payload)}\n\n`,
      { status: 200, headers }
    );

  if (!key) {
    return sendError({
      error: "OTCHARTS_API_KEY is missing from Netlify environment variables."
    });
  }

  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") || "EURUSD_otc";

  if (!/^[A-Z0-9#]+_otc$/.test(symbol)) {
    return sendError({
      error: "Invalid OTC symbol",
      symbol
    });
  }

  const upstream = new URL("https://otcharts.com/v1/stream");
  upstream.searchParams.set("venue", "otc");
  upstream.searchParams.set("symbol", symbol);

  try {
    const upstreamResponse = await fetch(upstream, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "User-Agent": "APEXSCAN-PRO"
      },
      signal: request.signal
    });

    if (!upstreamResponse.ok) {
      const raw = await upstreamResponse.text();

      let details;
      try {
        details = JSON.parse(raw);
      } catch {
        details = raw;
      }

      return sendError({
        error: "OTCharts stream connection rejected",
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        symbol,
        details,
        retryAfter: upstreamResponse.headers.get("retry-after")
      });
    }

    if (!upstreamResponse.body) {
      return sendError({
        error: "OTCharts returned HTTP 200 but no stream body.",
        symbol
      });
    }

    const reader = upstreamResponse.body.getReader();
    const encoder = new TextEncoder();

    let heartbeat = null;
    let cancelled = false;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(
            encoder.encode(
              `event: connected\ndata: ${JSON.stringify({
                status: "connected",
                symbol,
                time: Date.now()
              })}\n\n`
            )
          );

          heartbeat = setInterval(() => {
            if (cancelled) return;

            try {
              controller.enqueue(
                encoder.encode(`: keep-alive ${Date.now()}\n\n`)
              );
            } catch {
              // Client disconnected
            }
          }, 15000);

          while (!cancelled) {
            const { done, value } = await reader.read();

            if (done) break;

            controller.enqueue(value);
          }

          if (!cancelled) {
            controller.close();
          }
        } catch (error) {
          if (!cancelled) {
            try {
              controller.enqueue(
                encoder.encode(
                  `event: stream_error\ndata: ${JSON.stringify({
                    error: "OTCharts upstream stream ended",
                    details: error?.message || "Stream interrupted",
                    symbol
                  })}\n\n`
                )
              );

              controller.close();
            } catch {
              // Client already disconnected
            }
          }
        } finally {
          cancelled = true;

          if (heartbeat) clearInterval(heartbeat);

          try {
            reader.releaseLock();
          } catch {
            // Ignore cleanup errors
          }
        }
      },

      async cancel() {
        cancelled = true;

        if (heartbeat) clearInterval(heartbeat);

        try {
          await reader.cancel();
        } catch {
          // Upstream already closed
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers
    });
  } catch (error) {
    return sendError({
      error: "OTCharts connection failed",
      details: error?.message || "Unknown network error",
      symbol
    });
  }
};
