// Connection plumbing: WS heartbeat and per-connection/per-IP rate limiting.

export const HEARTBEAT_MS = 30_000;

// Terminate dead sockets; ws 'pong' handlers mark liveness.
export function startHeartbeat(wss) {
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  interval.unref?.();
  return interval;
}

// Token bucket: `rate` tokens/sec, burst up to `burst`. take() → false when dry.
export function makeBucket(rate, burst) {
  let tokens = burst;
  let last = Date.now();
  return {
    take(n = 1) {
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
      last = now;
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
    get level() { return tokens; },
  };
}

// Per-IP buckets with periodic pruning (join/create abuse).
export function makeIpLimiter(rate, burst) {
  const buckets = new Map();
  let lastPrune = Date.now();
  return function allow(ip) {
    const now = Date.now();
    if (now - lastPrune > 3600_000) {
      buckets.clear(); // coarse but bounded
      lastPrune = now;
    }
    let b = buckets.get(ip);
    if (!b) { b = makeBucket(rate, burst); buckets.set(ip, b); }
    return b.take();
  };
}
