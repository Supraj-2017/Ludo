-- Ludo online multiplayer schema. Run once (SQL editor or `supabase db push`).
-- All WRITES go through the `game` Edge Function (service role). Browsers only get SELECT on rooms they sit in.

create table public.rooms (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  host_id       uuid not null,
  capacity      smallint not null default 4 check (capacity between 2 and 4),
  design        text not null default 'classic',
  status        text not null default 'lobby' check (status in ('lobby','playing','finished','abandoned')),
  turn          smallint check (turn between 0 and 3),           -- colour index (0 red,1 green,2 yellow,3 blue)
  phase         text not null default 'roll' check (phase in ('roll','move')),
  dice          smallint check (dice between 1 and 6),
  legal         smallint[] not null default '{}',                 -- token indexes the current player may move
  sixes         smallint not null default 0,
  tokens        jsonb not null default '{}',                      -- {"0":[-1,-1,-1,-1], ...}  -1 base, 0..50 track, 51..55 home column, 56 home
  winner        smallint,
  version       integer not null default 0,                       -- move counter; every state change increments it
  last_event    jsonb,                                            -- what just happened (used by clients to animate)
  last_activity timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create table public.room_players (
  room_id   uuid not null references public.rooms(id) on delete cascade,
  user_id   uuid not null,                                        -- auth.uid() of the (anonymous) user
  slot      smallint not null check (slot between 0 and 3),
  name      text not null check (char_length(name) between 1 and 16),
  ready     boolean not null default false,
  has_left  boolean not null default false,
  last_seen timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id),                                 -- one seat per user per room
  unique (room_id, slot)                                          -- one user per seat
);
create index on public.rooms (last_activity);
create index on public.room_players (user_id);

-- Row Level Security: members can read their room; nobody can write from the browser.
alter table public.rooms        enable row level security;
alter table public.room_players enable row level security;

create function public.is_room_member(rid uuid) returns boolean
language sql security definer stable set search_path = public as
$$ select exists (select 1 from public.room_players where room_id = rid and user_id = auth.uid()) $$;
revoke all on function public.is_room_member(uuid) from public, anon;
grant execute on function public.is_room_member(uuid) to authenticated;

create policy rooms_member_select on public.rooms        for select to authenticated using (public.is_room_member(id));
create policy players_member_select on public.room_players for select to authenticated using (public.is_room_member(room_id));

revoke all on public.rooms, public.room_players from anon, authenticated;
grant select on public.rooms, public.room_players to authenticated;
-- (no INSERT/UPDATE/DELETE policies or grants => the browser cannot change game state)

-- Realtime (Postgres Changes respects the SELECT policies above)
alter publication supabase_realtime add table public.rooms, public.room_players;

-- Housekeeping: remove rooms idle for 24h. Schedule with pg_cron (Database > Extensions > pg_cron) if you like:
--   select cron.schedule('ludo-cleanup', '*/30 * * * *', 'select public.cleanup_rooms()');
create function public.cleanup_rooms() returns void
language sql security definer set search_path = public as
$$ delete from public.rooms where last_activity < now() - interval '24 hours' $$;
revoke all on function public.cleanup_rooms() from public, anon, authenticated;
