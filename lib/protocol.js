// Wire-format gate: every inbound frame passes through parse() before it can
// touch a room. Malformed input must never throw and never reach the core.

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 4096;
export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

const EMOTE_COUNT = 8;

// Strip control chars, zero-width and bidi tricks; clamp length.
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Sailor';
  const clean = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return clean.length >= 2 ? clean : 'Sailor';
}

export function sanitizeAvatar(raw) {
  if (typeof raw !== 'string') return '⚓';
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  const first = [...clean].slice(0, 2).join('');
  return first || '⚓';
}

const isInt = Number.isInteger;

function checkCells(cells, max) {
  if (!Array.isArray(cells) || cells.length > max) return null;
  const out = [];
  for (const c of cells) {
    if (!c || typeof c !== 'object' || !isInt(c.x) || !isInt(c.y)) return null;
    if (c.x < 0 || c.y < 0 || c.x > 31 || c.y > 31) return null;
    out.push({ x: c.x, y: c.y });
  }
  return out;
}

// parse(raw) -> { ok: true, msg } | { ok: false, error }
// msg is a fresh object containing only whitelisted, type-checked fields.
export function parse(raw) {
  if (typeof raw !== 'string') {
    if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
    else return { ok: false, error: 'Binary frames are not accepted.' };
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) {
    return { ok: false, error: 'Frame too large.' };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Not JSON.' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.t !== 'string') {
    return { ok: false, error: 'No message type.' };
  }

  switch (data.t) {
    case 'hello': {
      if (data.v !== PROTOCOL_VERSION) return { ok: false, error: 'version' };
      const msg = {
        t: 'hello',
        name: sanitizeName(data.name),
        avatar: sanitizeAvatar(data.avatar),
      };
      if (typeof data.reconnectToken === 'string' && data.reconnectToken.length <= 64) {
        msg.reconnectToken = data.reconnectToken;
      }
      return { ok: true, msg };
    }
    case 'create': {
      const settings = data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)
        ? data.settings : {};
      return { ok: true, msg: { t: 'create', settings } };
    }
    case 'join': {
      const code = typeof data.roomCode === 'string' ? data.roomCode.toUpperCase().trim() : '';
      if (!ROOM_CODE_RE.test(code)) return { ok: false, error: 'That room code does not look right.' };
      return { ok: true, msg: { t: 'join', roomCode: code } };
    }
    case 'settings': {
      const patch = data.patch && typeof data.patch === 'object' && !Array.isArray(data.patch)
        ? data.patch : {};
      return { ok: true, msg: { t: 'settings', patch } };
    }
    case 'ready':
      return { ok: true, msg: { t: 'ready', ready: !!data.ready } };
    case 'layout': {
      if (!Array.isArray(data.ships) || data.ships.length > 10) {
        return { ok: false, error: 'Bad layout.' };
      }
      const ships = [];
      for (const s of data.ships) {
        if (!s || typeof s !== 'object' || typeof s.id !== 'string' || s.id.length > 20) {
          return { ok: false, error: 'Bad layout.' };
        }
        if (!isInt(s.x) || !isInt(s.y)) return { ok: false, error: 'Bad layout.' };
        ships.push({ id: s.id, x: s.x, y: s.y, dir: s.dir === 'v' ? 'v' : 'h' });
      }
      return { ok: true, msg: { t: 'layout', ships } };
    }
    case 'aim': {
      const cells = checkCells(data.cells, 24);
      if (!cells) return { ok: false, error: 'Bad aim.' };
      return { ok: true, msg: { t: 'aim', cells } };
    }
    case 'ability': {
      if (typeof data.kind !== 'string' || data.kind.length > 20) {
        return { ok: false, error: 'Bad ability.' };
      }
      const t = data.target && typeof data.target === 'object' && !Array.isArray(data.target)
        ? data.target : {};
      const target = {};
      if (isInt(t.x)) target.x = t.x;
      if (isInt(t.y)) target.y = t.y;
      if (t.dir === 'h' || t.dir === 'v') target.dir = t.dir;
      return { ok: true, msg: { t: 'ability', kind: data.kind, target } };
    }
    case 'emote': {
      if (!isInt(data.id) || data.id < 0 || data.id >= EMOTE_COUNT) {
        return { ok: false, error: 'Bad emote.' };
      }
      return { ok: true, msg: { t: 'emote', id: data.id } };
    }
    case 'addBot': {
      if (!isInt(data.level) || data.level < 1 || data.level > 5) {
        return { ok: false, error: 'Bad bot level.' };
      }
      return { ok: true, msg: { t: 'addBot', level: data.level } };
    }
    case 'removeBot':
      return { ok: true, msg: { t: 'removeBot' } };
    case 'lock':
    case 'rematch':
    case 'claim':
    case 'leave':
      return { ok: true, msg: { t: data.t } };
    default:
      return { ok: false, error: 'Unknown message type.' };
  }
}
