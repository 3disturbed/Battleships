// Tiny promise-based WS test client: buffered inbox with typed take().

import WebSocket from 'ws';

export class TestClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.inbox = [];
    this.waiters = [];
    this.closed = new Promise((res) => this.ws.on('close', res));
    this.open = new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const w = this.waiters.findIndex((x) => x.match(msg));
      if (w >= 0) this.waiters.splice(w, 1)[0].resolve(msg);
      else this.inbox.push(msg);
    });
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  // Next message where msg.t === type (searches backlog first).
  take(type, timeoutMs = 5000) {
    const match = (m) => m.t === type;
    const buffered = this.inbox.findIndex(match);
    if (buffered >= 0) return Promise.resolve(this.inbox.splice(buffered, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timed out waiting for "${type}"`));
      }, timeoutMs);
      const wrapped = (msg) => { clearTimeout(timer); resolve(msg); };
      this.waiters.push({ match, resolve: wrapped });
    });
  }

  // Drain every buffered message of a type (e.g. piled-up states).
  drain(type) {
    const out = this.inbox.filter((m) => m.t === type);
    this.inbox = this.inbox.filter((m) => m.t !== type);
    return out;
  }

  close() { this.ws.close(); return this.closed; }
  terminate() { this.ws.terminate(); return this.closed; }
}

// Convenience: latest state after letting broadcasts settle.
export async function lastState(client) {
  const s = await client.take('state');
  let latest = s;
  for (const extra of client.drain('state')) latest = extra;
  return latest;
}
