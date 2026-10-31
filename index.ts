// Supabase Edge Function "game": the ONLY writer of room/game state. Runs with the service-role key,
// which Supabase injects as an environment secret – it is never sent to the browser.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { Err, handle, type Store } from './logic.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const db = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CORS = { 'Access-Control-Allow-Origin': '*', // tighten to your site origin in production
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const dup = (e: any) => e?.code === '23505';

const store: Store = {
  async roomByCode(code) { const { data, error } = await db.from('rooms').select('*').eq('code', code).maybeSingle(); if (error) throw error; return data; },
  async room(id) { const { data, error } = await db.from('rooms').select('*').eq('id', id).maybeSingle(); if (error) throw error; return data; },
  async players(id) { const { data, error } = await db.from('room_players').select('*').eq('room_id', id).order('slot'); if (error) throw error; return data ?? []; },
  async insertRoom(r) { const { data, error } = await db.from('rooms').insert(r).select().single(); if (error) { if (dup(error)) return null; throw error; } return data; },
  async insertPlayer(p) { const { error } = await db.from('room_players').insert(p); if (error) { if (dup(error)) return false; throw error; } return true; },
  async updatePlayer(rid, uid, patch) { const { error } = await db.from('room_players').update(patch).eq('room_id', rid).eq('user_id', uid); if (error) throw error; },
  async deletePlayer(rid, uid) { const { error } = await db.from('room_players').delete().eq('room_id', rid).eq('user_id', uid); if (error) throw error; },
  async updateRoom(id, version, patch) { // compare-and-set => two simultaneous actions can never both succeed
    const { data, error } = await db.from('rooms').update({ ...patch, version: version + 1 }).eq('id', id).eq('version', version).select().maybeSingle();
    if (error) throw error; return data; },
  async touchRoom(id, iso) { const { error } = await db.from('rooms').update({ last_activity: iso }).eq('id', id); if (error) throw error; },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, code: 'METHOD', error: 'POST only' }, 405);
  try {
    // Identify the caller from their Supabase Auth JWT (never from the request body).
    const authed = createClient(URL_, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
    const { data, error } = await authed.auth.getUser();
    if (error || !data.user) return json({ ok: false, code: 'UNAUTHENTICATED', error: 'Please reload the page and try again' }, 401);
    const body = await req.json().catch(() => null);
    return json(await handle(store, data.user.id, body));
  } catch (e) {
    if (e instanceof Err) return json({ ok: false, code: e.code, error: e.message });
    console.error(e); return json({ ok: false, code: 'SERVER', error: 'Server error – please try again' }, 500);
  }
});
