-- ============================================================================
-- Telemetry retention and downsampling
--
-- Each device sends a sample every 5 s plus one on every state change:
-- roughly 17 000 rows per device per day. Three devices for a year is ~19 M
-- rows, which is fine for Postgres but wasteful to keep at full resolution.
--
-- Policy: 30 days raw, then hourly aggregates forever. Batches, treatment
-- cycles, alarms, events and the audit log are compliance records and are
-- never downsampled or deleted.
-- ============================================================================

create or replace function downsample_telemetry(p_older_than interval default interval '30 days')
returns table (hours_written bigint, rows_deleted bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_hours bigint;
  v_rows  bigint;
begin
  with rolled as (
    select
      device_id,
      date_trunc('hour', ts) as hour,
      count(*)               as samples,
      round(avg(ph)::numeric, 2)  as ph_avg,
      min(ph)                     as ph_min,
      max(ph)                     as ph_max,
      round(avg(tds)::numeric)::int as tds_avg,
      min(tds)                    as tds_min,
      max(tds)                    as tds_max,
      round(avg(tank_ph)::numeric, 2) as tank_ph_avg,
      round(avg(neutraliser_pct)::numeric, 2) as neutraliser_pct,
      -- 720 samples/hour at 5 s is full uptime
      round(least(count(*) / 720.0, 1)::numeric, 4) as uptime_ratio
    from telemetry
    where ts < now() - p_older_than
    group by device_id, date_trunc('hour', ts)
  )
  insert into telemetry_hourly
  select device_id, hour, samples, ph_avg, ph_min, ph_max,
         tds_avg, tds_min, tds_max, tank_ph_avg, neutraliser_pct, uptime_ratio
  from rolled
  on conflict (device_id, hour) do update
    set samples = excluded.samples, ph_avg = excluded.ph_avg,
        ph_min = excluded.ph_min, ph_max = excluded.ph_max,
        tds_avg = excluded.tds_avg, tds_min = excluded.tds_min,
        tds_max = excluded.tds_max, tank_ph_avg = excluded.tank_ph_avg,
        neutraliser_pct = excluded.neutraliser_pct, uptime_ratio = excluded.uptime_ratio;

  get diagnostics v_hours = row_count;

  delete from telemetry where ts < now() - p_older_than;
  get diagnostics v_rows = row_count;

  return query select v_hours, v_rows;
end $$;

-- Expire commands the device never picked up. The device also refuses stale
-- commands on its own side; this is the server's matching half.
create or replace function expire_stale_commands()
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n bigint;
begin
  update commands
     set status = 'expired',
         reason = coalesce(reason, 'No acknowledgement from the device within 30 s'),
         resolved_at = now()
   where status = 'pending' and expires_at < now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Mark devices offline when they stop reporting. Run this often; the offline
-- alarm itself is raised by the alarm engine in the edge function.
create or replace function mark_stale_devices()
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n bigint;
begin
  update devices
     set status = 'offline'
   where status = 'online'
     and (last_seen is null or last_seen < now() - interval '60 seconds');
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------- schedule ---
-- pg_cron is available on Supabase (Database → Extensions → pg_cron).
-- Enable the extension, then run this block once.
--
--   select cron.schedule('expire-commands',  '* * * * *',  $$select expire_stale_commands()$$);
--   select cron.schedule('mark-stale',       '* * * * *',  $$select mark_stale_devices()$$);
--   select cron.schedule('downsample',       '17 2 * * *', $$select downsample_telemetry()$$);
--
-- Alarm escalation runs as an edge function on a schedule instead, because it
-- has to send notifications: see supabase/functions/escalate/index.ts.
