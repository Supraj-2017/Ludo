# Ludo – online multiplayer (Supabase)

```
index.html                                   the whole game (offline + online)
supabase/migrations/20250101000000_ludo_online.sql   tables, RLS policies, realtime publication
supabase/functions/game/index.ts             Edge Function entry point (service-role writes)
supabase/functions/game/logic.ts             authoritative rules + room logic (dice, turns, captures, wins)
```

## How it works
* Each device signs in **anonymously** with Supabase Auth, which gives a stable user id (kept in the browser's storage) used for seats and reconnection.
* The browser can only **read** rooms it sits in (Row Level Security) and listen via **Realtime**. It has no insert/update/delete rights.
* Every action (create/join/ready/start/**roll**/**move**/leave…) is sent to the `game` Edge Function. It checks the caller's JWT, turn ownership, game phase and legal moves, **rolls the dice itself** with a secure RNG, applies captures/safe squares/extra turns/win, and saves the new state with a version check (compare-and-set), so duplicate or simultaneous requests can't both succeed.
* Clients animate the confirmed `last_event` and then snap to the saved state, so a missed event or a reconnect always converges to the database state.
* Realtime **Presence** shows who is connected; a 20 s heartbeat records `last_seen`. After 60 s of silence any connected player may skip an absent player's turn or take over as host (the server enforces the 60 s rule). Rooms expire after 2 h without game activity.

## 1. Create the Supabase project
1. https://supabase.com → **New project** (free tier is fine). Wait until it is ready.
2. **Authentication → Sign In / Providers →** enable **Allow anonymous sign-ins**. (Strongly recommended: also enable CAPTCHA / rate limits under Authentication → Attack Protection.)
3. Apply the schema – either:
   * **SQL Editor:** paste `supabase/migrations/20250101000000_ludo_online.sql` and run it, **or**
   * CLI: `supabase login && supabase link --project-ref <your-ref> && supabase db push`
4. Check **Database → Publications → supabase_realtime** lists `rooms` and `room_players` (the SQL adds them).

## 2. Deploy the Edge Function
```bash
npm i -g supabase            # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref <your-ref>
supabase functions deploy game      # keep JWT verification ON (the default)
```
Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` into the function as secrets – you do **not** put them anywhere yourself. If your project uses the newer key format and the function logs complain about a missing variable, set it with `supabase secrets set NAME=value` (from your own terminal only).

## 3. Put the PUBLIC settings in index.html
Dashboard → **Project Settings → API**. Copy the **Project URL** and the **anon / publishable key** into the block near the top of `index.html`:
```js
window.LUDO_CONFIG={SUPABASE_URL:'https://xxxx.supabase.co',SUPABASE_ANON_KEY:'eyJ...your public key...'};
```
Only the public key goes here. **Never** paste the `service_role` / secret key into any frontend file or commit it to git. Leave both empty and the game still works offline.

## 4. Run locally and test with two players
```bash
cd <folder with index.html>
python3 -m http.server 8080        # or: npx serve
```
* Open http://localhost:8080 → **Play Online → Create Room**, copy the 6-character code.
* On a **second device** (phone on mobile data is a good test, since the backend is in the cloud) open the game at your computer's LAN address `http://<your-ip>:8080` – or just use the deployed URL below – then **Join Room** with the code.
* ⚠ Two tabs of the **same browser share one anonymous identity**, so they count as the same player. Use a different browser/profile, a private window, or another device for the second player.
* Test reconnection by turning Wi-Fi off for a few seconds (red warning appears, state is kept), then on again; or close the tab and use **Rejoin last room**.

## 5. Deploy so friends can play
`index.html` is a static file – upload it to any static host (HTTPS):
* **Netlify:** drag the folder onto https://app.netlify.com/drop
* **Cloudflare Pages / Vercel / GitHub Pages:** create a project from the folder or repo; no build step, output directory = the folder.

Then (optional hardening) change `Access-Control-Allow-Origin: '*'` in `supabase/functions/game/index.ts` to your site's origin and redeploy the function.
To clear old rooms automatically, enable **pg_cron** and run the `cron.schedule(...)` line in the migration.

## Known limits (be aware)
* Identity is the anonymous session stored in the browser. Clearing site data loses the seat (that player can no longer rejoin that match).
* Players who leave a started match cannot rejoin it; the host can return everyone to the lobby for a new match.
* No spectators, chat, or per-user rate limiting (use Supabase Auth rate limits / CAPTCHA).
* I tested the server logic and the frontend against an in-memory stand-in for Supabase, **not** against a live Supabase project. Please run the two-device test above after setup.
