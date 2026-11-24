// APEXSCAN PRO — single-symbol OTC live stream relay (Netlify EDGE Function)
// File: netlify/edge-functions/otc-stream.js   → served at /api/otc-stream
//
// Why an Edge Function: regular Netlify Functions are hard-stopped after 30–60 s,
// which kills a live stream and causes the endless "STREAM RECONNECTING" loop.
// Edge Functions only count CPU time, so they can hold an SSE stream open.
// The browser still owns reconnection. Each invocation opens ONE upstream stream.

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store, no-transform",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
};

const HEARTBEAT_MS = 15_000;        // keep proxies / mobile networks from closing an idle stream
const IDLE_LIMIT_MS = 75_000;       // upstream silent this long = stuck; tell the browser to reconnect
const MAX_LIFETIME_MS = 10 * 60_000; // rotate cleanly every 10 min instead of being cut off by a platform limit
const CONNECT_TIMEOUT_MS = 15_000;

const encoder = new TextEncoder();
const encodeEvent = (name, payload) =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

const sseError = (payload) =>
  new Response(`retry: 5000\n\n${encodeEvent("stream_error", payload)}`, {
    status: 200,
    headers: SSE_HEADERS,
  });

const getKey = () => {
  try {
    // Netlify global is available in Edge Functions
    // eslint-disable-next-line no-undef
    return Netlify.env.get("OTCHARTS_API_KEY");
  } catch {
    return undefined;
  }
};

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const key = getKey();
  if (!key) {
    return sseError({
      error: "OTCHARTS_API_KEY is missing from Netlify environment variables.",
      retryable: false,
    });
  }

  const incoming = new URL(request.url);
  const symbol = incoming.searchParams.get("symbol") || "EURUSD_otc";
  const venue = incoming.searchParams.get("venue") || "otc";

  if (venue !== "otc" || !/^[A-Z0-9#]+_otc$/i.test(symbol)) {
    return sseError({ error: "Invalid OTC stream request.", symbol, venue, retryable: false });
  }

  const upstreamUrl = new URL("https://otcharts.com/v1/stream");
  upstreamUrl.searchParams.set("venue", "otc");
  upstreamUrl.searchParams.set("symbol", symbol);

  // One controller for the upstream request: aborted when the browser leaves,
  // when we rotate, or when the upstream goes silent. This frees the stream slot.
  const upstreamAbort = new AbortController();
  const abortUpstream = () => {
    try { upstreamAbort.abort(); } catch { /* already aborted */ }
  };
  request.signal?.addEventListener("abort", abortUpstream, { once: true });

  let upstream;
  const connectTimer = setTimeout(abortUpstream, CONNECT_TIMEOUT_MS);
  try {
    upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "User-Agent": "APEXSCAN-PRO",
      },
      signal: upstreamAbort.signal,
    });
  } catch (error) {
    return sseError({
      error: upstreamAbort.signal.aborted
        ? "OTCharts did not answer in time."
        : "Could not reach OTCharts stream service.",
      details: error?.message || "Network request failed",
      symbol,
      retryable: true,
    });
  } finally {
    clearTimeout(connectTimer);
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    let details;
    try { details = JSON.parse(raw); } catch { details = raw.slice(0, 1500); }
    const status = upstream.status;
    return sseError({
      error: details?.error || details?.message || `OTCharts rejected the stream (HTTP ${status}).`,
      status,
      statusText: upstream.statusText,
      details,
      symbol,
      retryAfter: upstream.headers.get("retry-after"),
      retryable: status === 408 || status === 425 || status === 429 || status >= 500,
    });
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const body = await upstream.text().catch(() => "");
    return sseError({
      error: "OTCharts responded, but the response was not an event stream.",
      contentType,
      details: body.slice(0, 1500),
      symbol,
      retryable: false,
    });
  }

  if (!upstream.body) {
    return sseError({ error: "OTCharts returned an empty stream body.", symbol, retryable: true });
  }

  const reader = upstream.body.getReader();
  let cancelled = false;
  let heartbeat = null;
  let lifetime = null;
  let endReason = null; // "idle" | "rotate" | null
  let lastData = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk) => {
        if (cancelled) return false;
        try {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
          return true;
        } catch {
          cancelled = true;
          return false;
        }
      };

      // retry: tells EventSource how long to wait if the connection drops on its own.
      send(`retry: 3000\n\n`);
      send(encodeEvent("connected", { status: "connected", symbol, venue: "otc", time: Date.now() }));

      heartbeat = setInterval(() => {
        if (Date.now() - lastData > IDLE_LIMIT_MS) {
          endReason = "idle";
          abortUpstream();
          return;
        }
        // SSE comment line: ignored by EventSource, keeps the connection warm.
        send(`: ping ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);

      lifetime = setTimeout(() => {
        endReason = "rotate";
        abortUpstream();
      }, MAX_LIFETIME_MS);

      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) {
            send(encodeEvent("upstream_end", {
              error: "OTCharts ended the live stream.",
              symbol,
              time: Date.now(),
              retryable: true,
            }));
            break;
          }
          lastData = Date.now();
          if (!send(value)) break;
        }
      } catch (error) {
        if (endReason === "rotate") {
          send(encodeEvent("rotate", { symbol, time: Date.now(), reason: "scheduled refresh" }));
        } else if (!cancelled) {
          send(encodeEvent("stream_error", {
            error: endReason === "idle"
              ? `No data from OTCharts for ${Math.round(IDLE_LIMIT_MS / 1000)}s.`
              : "OTCharts stream was interrupted while relaying data.",
            details: error?.message || "Upstream read failed",
            symbol,
            time: Date.now(),
            retryable: true,
          }));
        }
      } finally {
        cancelled = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        abortUpstream();
        try { await reader.cancel(); } catch { /* already closed */ }
        try { reader.releaseLock(); } catch { /* ignore */ }
        try { controller.close(); } catch { /* client already closed */ }
      }
    },

    async cancel() {
      // Browser closed the EventSource (pair switch, tab closed, reconnect).
      cancelled = true;
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      abortUpstream();
      try { await reader.cancel(); } catch { /* already closed */ }
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
};

export const config = { path: "/api/otc-stream" };
