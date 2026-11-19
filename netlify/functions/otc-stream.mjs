export default async (request) => {
  const key = process.env.OTCHARTS_API_KEY;

  const headers = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  };

  const sendError = (payload) =>
    new Response(
      `event: stream_error\ndata: ${JSON.stringify(payload)}\n\n`,
      {
        status: 200,
        headers,
      }
    );

  if (!key) {
    return sendError({
      error: "OTCHARTS_API_KEY is missing from Netlify environment variables.",
    });
  }

  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") || "EURUSD_otc";

  if (!/^[A-Z0-9#]+_otc$/.test(symbol)) {
    return sendError({
      error: "Invalid OTC symbol",
      symbol,
    });
  }

  const upstream = new URL("https://otcharts.com/v1/stream");
  upstream.searchParams.set("venue", "otc");
  upstream.searchParams.set("symbol", symbol);

  let upstreamResponse;

  try {
    upstreamResponse = await fetch(upstream.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "User-Agent": "APEXSCAN-PRO",
      },
      signal: request.signal,
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
        retryAfter: upstreamResponse.headers.get("retry-after"),
      });
    }

    if (!upstreamResponse.body) {
      return sendError({
        error: "OTCharts returned HTTP 200 but no stream body.",
        symbol,
      });
    }

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();

    let heartbeat;
    let cancelled = false;

    const stream = new ReadableStream({
      async start(controller) {
        heartbeat = setInterval(() => {
          if (!cancelled) {
            try {
              controller.enqueue(
                new TextEncoder().encode(": keep-alive\n\n")
              );
            } catch {
              // Client connection is likely closed.
            }
          }
        }, 15000);

        try {
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
            const payload = {
              error: "OTCharts upstream stream ended",
              details: error?.message || "Stream interrupted",
              symbol,
            };

            try {
              controller.enqueue(
                new TextEncoder().encode(
                  `event: stream_error\ndata: ${JSON.stringify(payload)}\n\n`
                )
              );
              controller.close();
            } catch {
              // Client already disconnected.
            }
          }
        } finally {
          cancelled = true;

          if (heartbeat) {
            clearInterval(heartbeat);
          }

          try {
            reader.releaseLock();
          } catch {
            // Ignore cleanup errors.
          }
        }
      },

      async cancel() {
        cancelled = true;

        if (heartbeat) {
          clearInterval(heartbeat);
        }

        try {
          await reader.cancel();
        } catch {
          // Upstream may already be closed.
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers,
    });
  } catch (error) {
    return sendError({
      error: "OTCharts connection failed",
      details: error?.message || "Unknown network error",
      symbol,
    });
  }
};
