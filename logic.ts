// Authoritative Ludo server logic. No Deno/Supabase imports, so it is unit-testable in Node.
export const IDS: Record<number, number[]> = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };
export const OFF = [0, 13, 26, 39];
export const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
export const DESIGNS = ['classic','crown','robot','ninja','football','animal','emoji','diamond','knight','astronaut','fire','gold','crystal','cartoon','neon'];
export const IDLE_MS = 60_000;          // a player silent this long may be skipped / replaced as host
export const EXPIRE_MS = 2 * 3600_000;  // rooms with no game activity for 2h expire

export class Err extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

export interface Room { id: string; code: string; host_id: string; capacity: number; design: string;
  status: 'lobby' | 'playing' | 'finished' | 'abandoned'; turn: number | null; phase: 'roll' | 'move';
  dice: number | null; legal: number[]; sixes: number; tokens: Record<string, number[]>; winner: number | null;
  version: number; last_event: any; last_activity: string; created_at: string; }
export interface Player { room_id: string; user_id: string; slot: number; name: string; ready: boolean;
  has_left: boolean; last_seen: string; joined_at: string; }
export interface Store {
  roomByCode(code: string): Promise<Room | null>;
  room(id: string): Promise<Room | null>;
  players(roomId: string): Promise<Player[]>;
  insertRoom(r: Partial<Room>): Promise<Room | null>;            // null on code collision
  insertPlayer(p: Partial<Player>): Promise<boolean>;            // false on unique violation (seat/user taken)
  updatePlayer(roomId: string, uid: string, patch: Partial<Player>): Promise<void>;
  deletePlayer(roomId: string, uid: string): Promise<void>;
  updateRoom(id: string, version: number, patch: Partial<Room>): Promise<Room | null>; // compare-and-set; bumps version; null if version changed
  touchRoom(id: string, iso: string): Promise<void>;             // bump last_activity only (fires a realtime event, no version change)
}

const iso = (n: number) => new Date(n).toISOString();
const colourOf = (r: Room, p: Player) => IDS[r.capacity][p.slot];
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () => { const b = new Uint8Array(6); crypto.getRandomValues(b); return Array.from(b, x => ALPHA[x % 32]).join(''); };
export function rollDie() { const b = new Uint32Array(1); do { crypto.getRandomValues(b); } while (b[0] >= 4294967292); return (b[0] % 6) + 1; }
const cleanName = (s: unknown) => {
  const n = String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
  if (!n) throw new Err('BAD_NAME', 'Please enter a name (1–16 characters)'); return n;
};

export function legalMoves(tokens: number[], d: number) {
  const L: number[] = [];
  tokens.forEach((p, i) => { if (p === -1) { if (d === 6) L.push(i); } else if (p < 56 && p + d <= 56) L.push(i); });
  return L;
}
const goneSet = (r: Room, ps: Player[]) => new Set(ps.filter(p => p.has_left).map(p => colourOf(r, p)));
export function nextColour(ids: number[], cur: number, gone: Set<number>) {
  let i = ids.indexOf(cur);
  for (let k = 0; k < ids.length; k++) { i = (i + 1) % ids.length; if (!gone.has(ids[i])) return ids[i]; }
  return cur;
}
const freshTokens = (ids: number[]) => Object.fromEntries(ids.map(c => [String(c), [-1, -1, -1, -1]]));
const sorted = (ps: Player[]) => [...ps].sort((a, b) => a.slot - b.slot);

async function out(st: Store, rid: string) { return { ok: true, room: (await st.room(rid))!, players: await st.players(rid) }; }

async function create(st: Store, uid: string, b: any, now: number) {
  const name = cleanName(b.name);
  const capacity = [2, 3, 4].includes(b.capacity) ? b.capacity : 4;
  const design = DESIGNS.includes(b.design) ? b.design : 'classic';
  for (let i = 0; i < 8; i++) {
    const room = await st.insertRoom({ code: genCode(), host_id: uid, capacity, design, status: 'lobby', phase: 'roll', legal: [], sixes: 0,
      tokens: {}, winner: null, version: 0, last_event: { t: 'created', v: 0 }, last_activity: iso(now) });
    if (room) { await st.insertPlayer({ room_id: room.id, user_id: uid, slot: 0, name, ready: true, has_left: false, last_seen: iso(now) }); return out(st, room.id); }
  }
  throw new Err('CODE_FAILED', 'Could not allocate a room code – please try again', 500);
}

async function join(st: Store, uid: string, b: any, now: number) {
  const code = String(b.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Err('BAD_CODE', 'Room codes are 6 letters/numbers');
  const room = await st.roomByCode(code);
  if (!room) throw new Err('NOT_FOUND', 'No room with that code – check it and try again', 404);
  if (room.status === 'abandoned' || now - Date.parse(room.last_activity) > EXPIRE_MS) throw new Err('EXPIRED', 'This room has expired');
  const mine = (await st.players(room.id)).find(p => p.user_id === uid);
  if (mine) {                                            // reconnect: same seat, never a duplicate
    if (mine.has_left) throw new Err('LEFT', 'You left this match and cannot rejoin it');
    await st.updatePlayer(room.id, uid, { last_seen: iso(now) });
    return out(st, room.id);
  }
  if (room.status !== 'lobby') throw new Err('STARTED', 'That game has already started');
  const name = cleanName(b.name);
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await st.players(room.id);
    if (cur.length >= room.capacity) throw new Err('FULL', 'This room is full');
    const taken = new Set(cur.map(p => p.slot)); let slot = 0; while (taken.has(slot)) slot++;
    if (slot >= room.capacity) throw new Err('FULL', 'This room is full');
    if (await st.insertPlayer({ room_id: room.id, user_id: uid, slot, name, ready: false, has_left: false, last_seen: iso(now) })) {
      await st.touchRoom(room.id, iso(now)); return out(st, room.id);
    }                                                    // unique violation => someone took the seat first; retry
  }
  throw new Err('BUSY', 'That seat was just taken – please try again', 409);
}

export async function handle(st: Store, uid: string, b: any, now = Date.now()): Promise<any> {
  const a = String(b?.action ?? '');
  if (a === 'create') return create(st, uid, b, now);
  if (a === 'join') return join(st, uid, b, now);
  if (typeof b?.room_id !== 'string') throw new Err('BAD_REQUEST', 'room_id is required');
  const room = await st.room(b.room_id);
  if (!room) throw new Err('NOT_FOUND', 'Room not found', 404);
  const ps = await st.players(room.id);
  const me = ps.find(p => p.user_id === uid);
  if (!me) throw new Err('NOT_MEMBER', 'You are not in this room', 403);
  const expired = room.status === 'abandoned' || now - Date.parse(room.last_activity) > EXPIRE_MS;
  if (expired) { if (a === 'leave') { await st.deletePlayer(room.id, uid); return { ok: true }; } throw new Err('EXPIRED', 'This room has expired'); }
  const host = room.host_id === uid, ids = IDS[room.capacity], myCol = colourOf(room, me);
  const upd = async (patch: Partial<Room>, ev: any) => {
    const n = await st.updateRoom(room.id, room.version, { ...patch, last_event: { ...ev, v: room.version + 1 }, last_activity: iso(now) });
    if (!n) throw new Err('STALE', 'The game just changed – state refreshed, try again', 409); return n;
  };
  const done = (n: Room, players = ps) => ({ ok: true, room: n, players });
  const needHost = () => { if (!host) throw new Err('NOT_HOST', 'Only the host can do that', 403); };
  const needStatus = (s: Room['status'][]) => { if (!s.includes(room.status)) throw new Err('BAD_STATE', 'Not possible right now'); };
  const gone = goneSet(room, ps);

  switch (a) {
    case 'ping': await st.updatePlayer(room.id, uid, { last_seen: iso(now) }); return { ok: true };

    case 'ready': needStatus(['lobby']);
      await st.updatePlayer(room.id, uid, { ready: host ? true : !!b.ready }); await st.touchRoom(room.id, iso(now)); return out(st, room.id);

    case 'set_capacity': { needHost(); needStatus(['lobby']);
      const c = Number(b.capacity); if (![2, 3, 4].includes(c)) throw new Err('BAD_REQUEST', 'Capacity must be 2, 3 or 4');
      if (c < ps.length) throw new Err('TOO_MANY', `${ps.length} players are already seated`);
      const n = await upd({ capacity: c }, { t: 'cap' });
      const s = sorted(ps); for (let i = 0; i < s.length; i++) if (s[i].slot !== i) await st.updatePlayer(room.id, s[i].user_id, { slot: i });
      return done(n, await st.players(room.id)); }

    case 'set_design': { needHost(); needStatus(['lobby']);
      if (!DESIGNS.includes(b.design)) throw new Err('BAD_DESIGN', 'Unknown token design');
      return done(await upd({ design: b.design }, { t: 'design' })); }

    case 'start': case 'restart': { needHost();
      if (a === 'start') { needStatus(['lobby']);
        if (ps.length !== room.capacity) throw new Err('NOT_FULL', 'Wait until every seat is filled (or lower the player count)');
        if (!sorted(ps).every((p, i) => p.slot === i)) throw new Err('BAD_SEATS', 'Seats are inconsistent – ask everyone to rejoin');
        if (!ps.every(p => p.ready || p.user_id === room.host_id)) throw new Err('NOT_READY', 'Everyone must press Ready first');
      } else { needStatus(['playing', 'finished']);
        if (ps.some(p => p.has_left)) throw new Err('PLAYERS_LEFT', 'Someone left – return to the lobby first'); }
      return done(await upd({ status: 'playing', tokens: freshTokens(ids), turn: ids[0], phase: 'roll', dice: null, legal: [], sixes: 0, winner: null }, { t: 'start' })); }

    case 'to_lobby': { needHost(); needStatus(['playing', 'finished']);
      for (const p of ps.filter(p => p.has_left)) await st.deletePlayer(room.id, p.user_id);
      const s = sorted(ps.filter(p => !p.has_left));
      for (let i = 0; i < s.length; i++) await st.updatePlayer(room.id, s[i].user_id, { slot: i, ready: s[i].user_id === room.host_id });
      const n = await upd({ status: 'lobby', tokens: {}, turn: null, phase: 'roll', dice: null, legal: [], sixes: 0, winner: null }, { t: 'lobby' });
      return done(n, await st.players(room.id)); }

    case 'roll': case 'move': {
      needStatus(['playing']);
      if (me.has_left) throw new Err('LEFT', 'You left this match', 403);
      if (room.turn !== myCol) throw new Err('NOT_YOUR_TURN', 'It is not your turn', 403);
      if (!Number.isInteger(b.expected_version) || b.expected_version !== room.version) throw new Err('STALE', 'Out-of-date request – state refreshed', 409);
      const tok = room.tokens[String(myCol)];
      if (a === 'roll') {
        if (room.phase !== 'roll') throw new Err('BAD_STATE', 'You already rolled – move a token');
        const d = rollDie(), sixes = d === 6 ? room.sixes + 1 : 0, ev: any = { t: 'roll', c: myCol, d };
        const pass = { dice: d, sixes: 0, phase: 'roll' as const, legal: [], turn: nextColour(ids, myCol, gone) };
        if (sixes >= 3) { ev.skip = 'sixes'; return done(await upd(pass, ev)); }
        const L = legalMoves(tok, d);
        if (!L.length) { ev.skip = 'nomove'; return done(await upd(pass, ev)); }
        return done(await upd({ dice: d, sixes, phase: 'move', legal: L }, ev));
      }
      if (room.phase !== 'move') throw new Err('BAD_STATE', 'Roll the dice first');
      const i = Number(b.token);
      if (!Number.isInteger(i) || !room.legal.includes(i)) throw new Err('ILLEGAL_MOVE', 'That token cannot move');
      const d = room.dice!, tokens: Record<string, number[]> = JSON.parse(JSON.stringify(room.tokens));
      const t = tokens[String(myCol)], from = t[i], to = from === -1 ? 0 : from + d; t[i] = to;
      const cap: [number, number][] = [];
      if (to <= 50) {
        const abs = (OFF[myCol] + to) % 52;
        if (!SAFE.has(abs)) for (const q of ids) { if (q === myCol) continue;
          tokens[String(q)].forEach((x, u) => { if (x >= 0 && x <= 50 && (OFF[q] + x) % 52 === abs) cap.push([q, u]); }); }
        cap.forEach(([q, u]) => { tokens[String(q)][u] = -1; });
      }
      const extra = cap.length > 0 || to === 56 || d === 6, ev = { t: 'move', c: myCol, i, from, to, d, cap, extra };
      if (t.every(x => x === 56)) return done(await upd({ tokens, status: 'finished', winner: myCol, phase: 'roll', legal: [], turn: myCol }, { ...ev, win: true }));
      return done(await upd({ tokens, phase: 'roll', legal: [], sixes: extra ? room.sixes : 0, turn: extra ? myCol : nextColour(ids, myCol, gone) }, ev)); }

    case 'skip_turn': { needStatus(['playing']);       // skip an absent player so the game never freezes
      const cp = ps.find(p => colourOf(room, p) === room.turn);
      if (cp && !cp.has_left && now - Date.parse(cp.last_seen) <= IDLE_MS) throw new Err('NOT_IDLE', 'That player is still connected');
      return done(await upd({ turn: nextColour(ids, room.turn!, gone), phase: 'roll', legal: [], sixes: 0 }, { t: 'skip', c: room.turn })); }

    case 'claim_host': { if (host) return out(st, room.id);       // host went silent: any member may take over
      const hp = ps.find(p => p.user_id === room.host_id);
      if (hp && !hp.has_left && now - Date.parse(hp.last_seen) <= IDLE_MS) throw new Err('NOT_IDLE', 'The host is still connected (wait about a minute)');
      if (room.status === 'lobby') await st.updatePlayer(room.id, uid, { ready: true });
      return done(await upd({ host_id: uid }, { t: 'host' })); }

    case 'leave': {
      if (room.status === 'lobby') {
        await st.deletePlayer(room.id, uid);
        const rest = sorted(ps.filter(p => p.user_id !== uid));
        if (!rest.length) await upd({ status: 'abandoned' }, { t: 'closed' });
        else if (host) { await st.updatePlayer(room.id, rest[0].user_id, { ready: true }); await upd({ host_id: rest[0].user_id }, { t: 'host' }); }
        else await st.touchRoom(room.id, iso(now));
        return { ok: true };
      }
      await st.updatePlayer(room.id, uid, { has_left: true });
      const alive = ps.filter(p => p.user_id !== uid && !p.has_left), patch: Partial<Room> = {};
      if (!alive.length) patch.status = 'abandoned';
      else {
        if (host) patch.host_id = alive[0].user_id;
        if (room.status === 'playing') {
          if (alive.length === 1) { patch.status = 'finished'; patch.winner = colourOf(room, alive[0]); patch.turn = patch.winner; patch.phase = 'roll'; patch.legal = []; }   // everyone else forfeited
          else if (room.turn === myCol) { patch.turn = nextColour(ids, myCol, new Set([...gone, myCol])); patch.phase = 'roll'; patch.legal = []; patch.sixes = 0; }
        }
      }
      await upd(patch, { t: 'left', c: myCol }); return { ok: true };
    }
    default: throw new Err('BAD_ACTION', 'Unknown action');
  }
}
