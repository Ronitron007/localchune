-- supabase/migrations/20260731090000_30_review_queue_live_bands.sql
-- localchune — MIT licensed. See LICENSE.
-- NOTE: the distributed combination is AGPL-3.0 because the analysis
-- worker includes Essentia. LICENSE explains why.
--
-- M4 Task 8, second half. THE CALIBRATION DID NOT REACH THE QUEUE.
--
-- Migration 29 moved t_probable 0.70 -> 0.80 and the recomputed census says
-- the review queue should hold ONE pair. It held ten. The reason is one
-- word in review_queue()'s WHERE clause: `d.band = 'probable'`.
--
-- match_decisions.band is what the scorer decided AT THE TIME, against the
-- thresholds stored alongside it in the same row. That is exactly what it
-- should be: PRD §6 requires that changing a threshold cannot retroactively
-- make a past decision unexplainable, and a frozen band plus a frozen
-- thresholds jsonb is how that promise is kept.
--
-- But it makes the band column the wrong thing for a WORK QUEUE to read.
-- Nine of those ten rows are the unrelated hump's tail — 0-14 shared items
-- over 315-763 frames, 33 to 125 SECONDS of duration delta — and they were
-- labelled `probable` only because 0.70 was too low. Reading the frozen
-- label means the flood survives its own fix, and every one of those nine
-- costs a person two seconds and some doubt before they answer.
--
-- THE DISTINCTION, written down because it is the whole point:
--
--   match_decisions.band     a LOG. What we believed then. Never rewritten.
--   dedup_near_misses        a LOG over the same column. Also never
--                            rewritten — the 253 stale `related` rows are a
--                            cleanup for a human to approve, not something
--                            a view should quietly redefine away.
--   review_queue()           a WORK QUEUE. What we believe NOW. It must
--                            band against live dedup_config or "thresholds
--                            are data, so a recalibration is an UPDATE and
--                            not a deploy" is not true of the one surface
--                            where it matters most.
--
-- Nothing is rewritten by this migration. No row changes. The queue simply
-- stops reading a historical label and starts asking the current question.
--
-- Joined on algo_version, not a scalar subquery: a fingerprint from a
-- different chromaprint build is not comparable and its thresholds are not
-- transferable. A decision whose algo_version has no config row drops out
-- of the queue rather than being judged by another version's numbers.

create or replace function public.review_queue(
  p_limit int default 50, p_status text default 'pending',
  p_decision_id bigint default null
) returns table (
  decision_id       bigint,
  score             real,
  band              text,
  layer             text,
  shared_items      int,
  overlap_frames    int,
  duration_delta_ms int,
  per_second_ber    real[],
  decided_at        timestamptz,
  probe_file_id     uuid,
  probe_artist      text,
  probe_title       text,
  probe_filename    text,
  probe_uploader    text,
  probe_tier        smallint,
  probe_container   text,
  probe_duration_ms int,
  probe_kbps        int,
  probe_preview_key text,
  cand_file_id      uuid,
  cand_artist       text,
  cand_title        text,
  cand_filename     text,
  cand_uploader     text,
  cand_tier         smallint,
  cand_container    text,
  cand_duration_ms  int,
  cand_kbps         int,
  cand_preview_key  text,
  verdict           text,
  reviewed_at       timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select public.is_owner()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with live as (
    select distinct on (least(d.probe_file_id, d.candidate_file_id),
                        greatest(d.probe_file_id, d.candidate_file_id))
           d.*
      from public.match_decisions d
      -- THE CHANGE. Live thresholds, not the frozen label.
      join public.dedup_config g on g.algo_version = d.algo_version
     where d.superseded_at is null
       and d.score >= g.t_probable
       and d.score <  g.t_same
     order by least(d.probe_file_id, d.candidate_file_id),
              greatest(d.probe_file_id, d.candidate_file_id),
              d.score desc, d.id desc
  ), answered as (
    select least(d2.probe_file_id, d2.candidate_file_id)    as lo,
           greatest(d2.probe_file_id, d2.candidate_file_id) as hi,
           r.verdict, r.decided_at
      from public.review_actions r
      join public.match_decisions d2 on d2.id = r.decision_id
  )
  select l.id, l.score,
         -- The band the row is being shown under NOW, so the page never
         -- displays a label that contradicts why the row is in front of you.
         'probable'::text,
         l.layer, l.shared_items, l.overlap_frames,
         l.duration_delta_ms, l.per_second_ber, l.decided_at,
         p.file_id, p.display_artist, p.display_title, p.original_filename,
         p.uploader_name, p.quality_tier, p.container, p.duration_ms,
         case when coalesce(p.duration_ms, 0) > 0
              then (p.byte_size * 8 / p.duration_ms)::int end,
         p.preview_key,
         c.file_id, c.display_artist, c.display_title, c.original_filename,
         c.uploader_name, c.quality_tier, c.container, c.duration_ms,
         case when coalesce(c.duration_ms, 0) > 0
              then (c.byte_size * 8 / c.duration_ms)::int end,
         c.preview_key,
         a.verdict, a.decided_at
    from live l
    join public.pool_tracks p on p.file_id = l.probe_file_id
    join public.pool_tracks c on c.file_id = l.candidate_file_id
    left join answered a
      on a.lo = least(l.probe_file_id, l.candidate_file_id)
     and a.hi = greatest(l.probe_file_id, l.candidate_file_id)
   where case coalesce(p_status, 'pending')
           when 'pending'  then a.verdict is null
           when 'resolved' then a.verdict is not null
           else true
         end
     and (a.verdict is not null
          or public.canonical_track_id(p.track_id)
               is distinct from public.canonical_track_id(c.track_id))
     and (p_decision_id is null or l.id = p_decision_id)
   order by l.score desc, l.id desc
   limit greatest(least(coalesce(p_limit, 50), 200), 1);
end $$;
revoke execute on function public.review_queue(int, text, bigint)
  from public, anon, service_role;
grant  execute on function public.review_queue(int, text, bigint) to authenticated;

comment on function public.review_queue(int, text, bigint) is
  'The review WORK QUEUE, banded against LIVE dedup_config rather than
   match_decisions.band. The stored band is a log of what the scorer
   believed when it ran and is never rewritten; the queue has to ask the
   current question, or a recalibration would not reach the one surface a
   person actually works from. A pair leaves the queue for good once any
   decision on the same ORDERED FILE PAIR carries a review_actions row.';

notify pgrst, 'reload schema';
