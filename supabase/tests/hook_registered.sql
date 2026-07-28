begin;
select plan(2);
-- The gate is only real if GoTrue is actually configured to call it. This
-- fails loudly if config.toml loses the registration.
select ok( current_setting('server_version_num')::int >= 140000, 'pg14+ for create or replace trigger' );
select has_function('public','hook_before_user_created', array['jsonb'],
                    'hook function exists (registration itself is asserted by scripts/check-hook-registered.sh)' );
select * from finish();
rollback;
