// WS connection with auto-reconnect and token resume. app.js owns dispatch.

const PROTOCOL_VERSION = 1;

export function createNet({ onMessage, onStatus }) {
  let ws = null;
  let attempts = 0;
  let wantOpen = true;
  let identity = { name: 'Sailor', avatar: '⚓' };
  let reconnectTimer = null;

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  function connect() {
    clearTimeout(reconnectTimer);
    onStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    ws = new WebSocket(url);

    ws.onopen = () => {
      attempts = 0;
      onStatus('online');
      const hello = { t: 'hello', v: PROTOCOL_VERSION, ...identity };
      const token = localStorage.getItem('bs_token');
      if (token) hello.reconnectToken = token;
      ws.send(JSON.stringify(hello));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    };

    ws.onclose = (ev) => {
      ws = null;
      if (!wantOpen || ev.code === 4426 /* version */) return;
      onStatus('offline');
      attempts++;
      reconnectTimer = setTimeout(connect, Math.min(10_000, 700 * attempts));
    };
    ws.onerror = () => ws?.close();
  }

  return {
    start(id) { identity = id; connect(); },
    setIdentity(id) { identity = id; },
    send(obj) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    rehello() { // fresh hello (e.g. after dropping a dead token)
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, ...identity }));
      }
    },
    stop() { wantOpen = false; ws?.close(); },
  };
}
