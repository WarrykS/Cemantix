-- Plusieurs jeux sur le même site : cemantix, sutom, mots (mots croisés)
-- À exécuter une fois dans Supabase → projet cemantix → SQL Editor → Run.
alter table public.results add column game text not null default 'cemantix' check (game in ('cemantix', 'sutom', 'mots'));
alter table public.results add column won boolean not null default true;
alter table public.results alter column word drop not null;
drop index public.results_puzzle_pseudo_key;
create unique index results_game_puzzle_pseudo_key on public.results (game, puzzle, lower(btrim(pseudo)));

alter table public.games add column game text not null default 'cemantix' check (game in ('cemantix', 'sutom', 'mots'));
alter table public.games drop constraint games_pkey;
alter table public.games add primary key (player_id, game, puzzle);

drop function public.cemantix_load_game(text, integer);
create function public.cemantix_load_game(p_token text, p_puzzle integer, p_game text default 'cemantix')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare p public.players := public.cemantix_player(p_token);
begin
  return (select g.state from public.games g where g.player_id = p.id and g.game = p_game and g.puzzle = p_puzzle);
end;
$$;

drop function public.cemantix_save_game(text, integer, jsonb);
create function public.cemantix_save_game(p_token text, p_puzzle integer, p_state jsonb, p_game text default 'cemantix')
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare p public.players := public.cemantix_player(p_token);
begin
  if p_puzzle not between public.cemantix_today() - 1 and public.cemantix_today() then
    raise exception 'Partie hors délai.' using errcode = '22023';
  end if;
  if octet_length(p_state::text) > 100000 then
    raise exception 'Partie trop volumineuse.' using errcode = '22023';
  end if;
  insert into public.games (player_id, game, puzzle, state) values (p.id, p_game, p_puzzle, p_state)
  on conflict (player_id, game, puzzle) do update set state = excluded.state, updated_at = now();
end;
$$;

drop function public.cemantix_submit(text, integer, integer, text, integer);
create function public.cemantix_submit(p_token text, p_puzzle integer, p_tries integer, p_word text, p_duration_s integer,
                                       p_game text default 'cemantix', p_won boolean default true)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare p public.players := public.cemantix_player(p_token);
begin
  if p_puzzle not between public.cemantix_today() - 1 and public.cemantix_today() then
    raise exception 'Résultat hors délai.' using errcode = '22023';
  end if;
  insert into public.results (game, puzzle, pseudo, tries, word, duration_s, won, player_id)
  values (p_game, p_puzzle, p.pseudo, p_tries, nullif(p_word, ''), p_duration_s, coalesce(p_won, true), p.id);
  return 'ok';
exception when unique_violation then
  return 'duplicate';
end;
$$;

drop function public.cemantix_history();
create function public.cemantix_history()
returns table (game text, puzzle integer, pseudo text, tries integer, won boolean, word text, duration_s integer, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.game, r.puzzle, btrim(r.pseudo), r.tries, r.won,
         case when r.puzzle < public.cemantix_today() then r.word end,
         r.duration_s, r.created_at
  from public.results r
  order by r.puzzle desc, r.tries asc, r.created_at asc
  limit 10000;
$$;

revoke all on function public.cemantix_load_game(text, integer, text), public.cemantix_save_game(text, integer, jsonb, text),
  public.cemantix_submit(text, integer, integer, text, integer, text, boolean), public.cemantix_history() from public;
grant execute on function public.cemantix_load_game(text, integer, text), public.cemantix_save_game(text, integer, jsonb, text),
  public.cemantix_submit(text, integer, integer, text, integer, text, boolean), public.cemantix_history() to anon, authenticated;
