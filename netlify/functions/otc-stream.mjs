// APEXSCAN PRO — resilient single-symbol OTC live stream relay
// File: netlify/functions/otc-stream.mjs

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store, no-transform",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
};

const encodeEvent = (name, payload) =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

const sseError = (payload, status = 200) =>
  new Response(encodeEvent("stream_error", payload), {
    status,
    headers: SSE_HEADERS,
  });

export default async (request) => {
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: {
        Allow: "GET",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const key = process.env.OTCHARTS_API_KEY;

  if (!key) {
    return sseError({
      error:
        "OTCHARTS_API_KEY is missing from Netlify environment variables.",
      retryable: false,
    });
  }

  const incoming = new URL(request.url);

  const symbol =
    incoming.searchParams.get("symbol") || "EURUSD_otc";

  const venue =
    incoming.searchParams.get("venue") || "otc";

  if (
    venue !== "otc" ||
    !/^[A-Z0-9#]+_otc$/i.test(symbol)
  ) {
    return sseError({
      error:
        "Invalid OTC stream request. Expected one OTC symbol ending in _otc.",
      symbol,
      venue,
      retryable: false,
    });
  }

  const upstreamUrl = new URL(
    "https://otcharts.com/v1/stream"
  );

  upstreamUrl.searchParams.set("venue", "otc");
  upstreamUrl.searchParams.set("symbol", symbol);

  let upstream;

  try {
    upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "User-Agent": "APEXSCAN-PRO",
      },
      signal: request.signal,
    });
  } catch (error) {
    return sseError({
      error: "Could not reach OTCharts stream service.",
      details: error?.message || "Network request failed",
      symbol,
      retryable: true,
    });
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");

    let details;

    try {
      details = JSON.parse(raw);
    } catch {
      details = raw.slice(0, 1500);
    }

    const status = upstream.status;

    return sseError({
      error:
        details?.error ||
        details?.message ||
        `OTCharts rejected the stream (HTTP ${status}).`,
      status,
      statusText: upstream.statusText,
      details,
      symbol,
      retryAfter: upstream.headers.get("retry-after"),
      retryable:
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status >= 500,
    });
  }

  const contentType =
    upstream.headers.get("content-type") || "";

  if (
    !contentType.toLowerCase().includes("text/event-stream")
  ) {
    const body = await upstream.text().catch(() => "");

    return sseError({
      error:
        "OTCharts responded, but the response was not an event stream.",
      contentType,
      details: body.slice(0, 1500),
      symbol,
      retryable: false,
    });
  }

  if (!upstream.body) {
    return sseError({
      error: "OTCharts returned an empty stream body.",
      symbol,
      retryable: true,
    });
  }

  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();

  let cancelled = false;
  let heartbeatTimer = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk) => {
        if (cancelled) return false;

        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          cancelled = true;
          return false;
        }
      };

      send(
        encodeEvent("connected", {
          status: "connected",
          symbol,
          venue: "otc",
          time: Date.now(),
        })
      );

      // Keep downstream SSE alive during quiet periods.
      // SSE comments do not create market ticks.
      heartbeatTimer = setInterval(() => {
        if (!cancelled) {
          send(": keep-alive\n\n");
        }
      }, 15000);

      try {
        while (!cancelled) {
          const { done, value } = await reader.read();

          if (done) {
            send(
              encodeEvent("upstream_end", {
                error: "OTCharts ended the live stream.",
                symbol,
                time: Date.now(),
                retryable: true,
              })
            );

            break;
          }

          if (!send(value)) break;
        }
      } catch (error) {
        send(
          encodeEvent("stream_error", {
            error:
              "OTCharts stream was interrupted while relaying data.",
            details:
              error?.message || "Upstream read failed",
            symbol,
            time: Date.now(),
            retryable: true,
          })
        );
      } finally {
        cancelled = true;

        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }

        heartbeatTimer = null;

        try {
          await reader.cancel();
        } catch {}

        try {
          reader.releaseLock();
        } catch {}

        try {
          controller.close();
        } catch {}
      }
    },

    async cancel() {
      cancelled = true;

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }

      heartbeatTimer = null;

      try {
        await reader.cancel();
      } catch {}
    },
  });

  return new Response(stream, {
    status: 200,
    headers: SSE_HEADERS,
  });
};
