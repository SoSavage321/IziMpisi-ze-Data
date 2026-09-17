-- ============================================================================
-- Views the dashboard reads. security_invoker keeps RLS on the base tables,
-- so a view can never widen what a user is allowed to see.
-- ============================================================================

-- Latest telemetry row per device.
create or replace view v_device_latest with (security_invoker = on) as
select distinct on (t.device_id)
  t.device_id, t.ts, t.state, t.mode, t.estop, t.ph, t.tds,
  t.chamber_l, t.tank_l, t.tank_cap_l, t.tank_ph, t.tank_tds,
  t.neutraliser_pct, t.v1, t.v2, t.v3, t.sump_pump, t.dosing_pump,
  t.siren, t.led, t.wifi_rssi, t.uptime_s
from telemetry t
order by t.device_id, t.ts desc;

-- One row per device with everything the fleet overview needs.
create or replace view v_fleet with (security_invoker = on) as
select
  d.id                as device_id,
  d.name              as device_name,
  d.status,
  d.last_seen,
  d.firmware_version,
  d.flow_sensor,
  d.config_version,
  s.id                as site_id,
  s.name              as site_name,
  s.location,
  s.latitude,
  s.longitude,
  s.timezone,
  s.org_id,
  l.state, l.mode, l.estop, l.ph, l.tds, l.neutraliser_pct, l.tank_l, l.tank_cap_l,
  l.v1, l.v2, l.v3, l.siren, l.led,
  (d.last_seen is null or d.last_seen < now() - interval '60 seconds') as offline,
  coalesce(a.active_alarms, 0)      as active_alarms,
  coalesce(a.critical_alarms, 0)    as critical_alarms,
  coalesce(b.litres_to_river, 0)    as litres_to_river_today,
  coalesce(b.litres_blocked, 0)     as litres_blocked_today,
  coalesce(b.batches_today, 0)      as batches_today,
  coalesce(b.passed_today, 0)       as passed_today
from devices d
join sites s on s.id = d.site_id
left join v_device_latest l on l.device_id = d.id
left join lateral (
  select count(*) filter (where cleared_at is null)                          as active_alarms,
         count(*) filter (where cleared_at is null and severity = 'critical') as critical_alarms
  from alarms where device_id = d.id
) a on true
left join lateral (
  select
    count(*)                                                   as batches_today,
    count(*) filter (where result = 'PASS')                    as passed_today,
    coalesce(sum(volume_l) filter (where destination = 'RIVER'), 0) as litres_to_river,
    coalesce(sum(volume_l) filter (where destination <> 'RIVER'), 0) as litres_blocked
  from batches
  where device_id = d.id
    and started_at >= date_trunc('day', now() at time zone s.timezone) at time zone s.timezone
) b on true;

-- Batch counts by local day — drives the analytics page.
create or replace view v_batch_daily with (security_invoker = on) as
select
  b.device_id,
  (b.started_at at time zone s.timezone)::date as day,
  count(*)                                         as batches,
  count(*) filter (where b.result = 'PASS')        as passed,
  count(*) filter (where b.result = 'FAIL')        as failed,
  count(*) filter (where b.result = 'HELD')        as held,
  count(*) filter (where b.fail_reason = 'ACID')     as acid_rejects,
  count(*) filter (where b.fail_reason = 'ALKALINE') as alkaline_rejects,
  count(*) filter (where b.fail_reason = 'TDS')      as tds_rejects,
  coalesce(sum(b.volume_l) filter (where b.destination = 'RIVER'), 0) as litres_to_river,
  coalesce(sum(b.volume_l) filter (where b.destination <> 'RIVER'), 0) as litres_blocked,
  round(avg(b.avg_ph)::numeric, 2)  as ph_avg,
  min(b.avg_ph)                     as ph_min,
  max(b.avg_ph)                     as ph_max,
  round(avg(b.avg_tds)::numeric, 0) as tds_avg,
  max(b.avg_tds)                    as tds_max
from batches b
join devices d on d.id = b.device_id
join sites   s on s.id = d.site_id
group by b.device_id, (b.started_at at time zone s.timezone)::date;

-- Pump run-hours and valve cycle counts, derived from telemetry rather than
-- stored, so they cannot drift from what the device actually did.
-- Each sample stands for the interval since the previous sample (capped at
-- 30 s so an offline gap does not count as run-time).
create or replace view v_duty_counters with (security_invoker = on) as
with stepped as (
  select
    device_id, ts, v1, v2, v3, sump_pump, dosing_pump,
    least(extract(epoch from ts - lag(ts) over (partition by device_id order by ts)), 30) as dt,
    lag(v1) over (partition by device_id order by ts) as p_v1,
    lag(v2) over (partition by device_id order by ts) as p_v2,
    lag(v3) over (partition by device_id order by ts) as p_v3
  from telemetry
)
select
  device_id,
  round((sum(dt) filter (where sump_pump)   / 3600.0)::numeric, 2) as sump_run_hours,
  round((sum(dt) filter (where dosing_pump) / 3600.0)::numeric, 2) as dosing_run_hours,
  count(*) filter (where v1 and not p_v1) as v1_cycles,
  count(*) filter (where v2 and not p_v2) as v2_cycles,
  count(*) filter (where v3 and not p_v3) as v3_cycles
from stepped
group by device_id;

-- Neutraliser consumption per litre treated, for inventory forecasting.
create or replace view v_treatment_efficiency with (security_invoker = on) as
select
  device_id,
  date_trunc('day', started_at) as day,
  count(*)                                        as cycles,
  round(avg(extract(epoch from released_at - started_at))::numeric, 0) as avg_treat_seconds,
  round(sum(neutraliser_used_pct)::numeric, 2)    as neutraliser_pct_used,
  round(sum(volume_released_l)::numeric, 1)       as litres_released,
  case when sum(volume_released_l) > 0
       then round((sum(neutraliser_used_pct) / sum(volume_released_l))::numeric, 4)
  end as pct_per_litre
from treatment_cycles
where released_at is not null
group by device_id, date_trunc('day', started_at);
