begin;
select plan(1);

-- Migration 21: the never-written column is gone. Whoever re-adds it owes
-- a writer, a reader and a backfill — see the migration header.
select hasnt_column('public', 'files', 'bitrate_kbps',
                    'files.bitrate_kbps was dropped by migration 21');

select * from finish();
rollback;
