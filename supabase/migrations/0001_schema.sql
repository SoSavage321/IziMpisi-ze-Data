-- ============================================================================
-- WaterGuard — core schema
-- AMD test-before-release water system (MICTSETA Digital-to-Physical)
--
-- Safety note: the ESP32 is the authority on safety. Nothing in this schema
-- can open a valve. The dashboard writes REQUESTS into `commands`; the device
-- validates them against its own interlocks and writes back accepted/rejected.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- tenancy ---
create table organisations (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  created_at   timestamptz not null default now()
);

create table sites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id) on delete cascade,
  name         text not null,
  location     text,
  latitude     double precision,
  longitude    double precision,
  mine_owner   text,
  timezone     text not null default 'Africa/Johannesburg',
  created_at   timestamptz not null default now()
);
create index on sites (org_id);

create type device_status as enum ('online', 'offline', 'never_seen');

create table devices (
  id                uuid primary key default gen_random_uuid(),
  site_id           uuid not null references sites(id) on delete cascade,
  name              text not null,
  -- sha256 hex of the per-device API key. The key itself is shown once, at
  -- registration, and never stored.
  api_key_hash      text unique,
  firmware_version  text,
  hardware_revision text,
  -- true only when the device reports a real flow meter; otherwise every
  -- volume in the UI is labelled "estimated" because litres are counted in code
  flow_sensor       boolean not null default false,
  last_seen         timestamptz,
  status            device_status not null default 'never_seen',
  config_version    integer not null default 1,   -- version the device SHOULD run
  created_at        timestamptz not null default now()
);
create index on devices (site_id);
create index on devices (api_key_hash);

-- ---------------------------------------------------------------- people ---
create type user_role as enum ('admin', 'operator', 'viewer');

create table profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references organisations(id) on delete cascade,
  full_name   text not null,
  phone       text,
  role        user_role not null default 'viewer',
  created_at  timestamptz not null default now()
);
create index on profiles (org_id);

-- ----------------------------------------------------------- device config ---
-- Versioned history: one row per version, never updated in place. The device
-- polls the desired version and confirms by setting applied_at.
create table device_config (
  id                  uuid primary key default gen_random_uuid(),
  device_id           uuid not null references devices(id) on delete cascade,
  version             integer not null,
  ph_min              numeric(4,2) not null default 6.50,
  ph_max              numeric(4,2) not null default 8.50,   -- hard ceiling, enforced in firmware
  tds_max             integer      not null default 1200,
  treat_target_ph     numeric(4,2) not null default 6.80,
  test_window_s       integer      not null default 3,
  stable_window_s     integer      not null default 3,
  batch_l             integer      not null default 100,
  tank_cap_l          integer      not null default 300,
  ph_warn_max         numeric(4,2) not null default 8.50,   -- dashboard warning threshold
  neutraliser_low_pct integer      not null default 20,
  reason              text,
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  applied_at          timestamptz,                          -- set when the device confirms
  unique (device_id, version),

  -- Validation layer. Loosening these is an environmental decision, so the
  -- database refuses values outside a defensible range regardless of the UI.
  constraint ph_min_range        check (ph_min between 6.0 and 7.0),
  constraint ph_max_range        check (ph_max between 8.0 and 9.5),
  constraint ph_band_ordered     check (ph_max > ph_min),
  constraint tds_max_range       check (tds_max between 500 and 2000),
  constraint target_in_band      check (treat_target_ph > ph_min and treat_target_ph < ph_max),
  constraint test_window_range   check (test_window_s between 1 and 60),
  constraint stable_window_range check (stable_window_s between 1 and 60),
  constraint batch_l_range       check (batch_l between 10 and 10000),
  constraint tank_cap_range      check (tank_cap_l between 50 and 100000),
  constraint warn_max_range      check (ph_warn_max between 7.0 and 10.0),
  constraint low_pct_range       check (neutraliser_low_pct between 1 and 90)
);
create index on device_config (device_id, version desc);

-- --------------------------------------------------------------- telemetry ---
create table telemetry (
  id              bigserial primary key,
  device_id       uuid not null references devices(id) on delete cascade,
  ts              timestamptz not null,
  state           text not null,
  mode            text not null default 'AUTO',
  estop           boolean not null default false,
  ph              numeric(5,2),
  tds             integer,
  chamber_l       numeric(8,2),
  tank_l          numeric(8,2),
  tank_cap_l      integer,
  tank_ph         numeric(5,2),
  tank_tds        integer,
  neutraliser_pct numeric(5,2),
  v1              boolean not null default false,
  v2              boolean not null default false,
  v3              boolean not null default false,
  sump_pump       boolean not null default false,
  dosing_pump     boolean not null default false,
  siren           boolean not null default false,
  led             text,                       -- green | red | yellow | off
  wifi_rssi       integer,
  uptime_s        bigint,
  -- the device buffers offline and replays its backlog, so ingest must be
  -- idempotent on (device_id, ts)
  unique (device_id, ts)
);
create index on telemetry (device_id, ts desc);

-- ----------------------------------------------------------------- batches ---
create type batch_result      as enum ('PASS', 'FAIL', 'HELD');
create type batch_destination as enum ('RIVER', 'TANK', 'HELD');

create table batches (
  id           uuid primary key default gen_random_uuid(),
  device_id    uuid not null references devices(id) on delete cascade,
  batch_no     integer not null,
  started_at   timestamptz not null,
  ended_at     timestamptz,
  avg_ph       numeric(5,2),
  avg_tds      integer,
  result       batch_result not null,
  destination  batch_destination not null,
  volume_l     numeric(8,2) not null default 100,
  fail_reason  text,                           -- ACID | ALKALINE | TDS | null
  unique (device_id, batch_no)
);
create index on batches (device_id, started_at desc);

create table treatment_cycles (
  id                   uuid primary key default gen_random_uuid(),
  device_id            uuid not null references devices(id) on delete cascade,
  cycle_no             integer not null,
  started_at           timestamptz not null,
  released_at          timestamptz,
  start_ph             numeric(5,2),
  end_ph               numeric(5,2),
  end_tds              integer,
  neutraliser_used_pct numeric(5,2),
  volume_released_l    numeric(8,2),
  unique (device_id, cycle_no)
);
create index on treatment_cycles (device_id, started_at desc);

-- ------------------------------------------------------------------ alarms ---
create type alarm_severity as enum ('info', 'warning', 'critical');

create table alarms (
  id               uuid primary key default gen_random_uuid(),
  device_id        uuid not null references devices(id) on delete cascade,
  type             text not null,
  severity         alarm_severity not null,
  message          text not null,
  details          jsonb not null default '{}'::jsonb,
  raised_at        timestamptz not null default now(),
  acknowledged_by  uuid references auth.users(id),
  acknowledged_at  timestamptz,
  ack_note         text,
  cleared_at       timestamptz,
  escalated        boolean not null default false,
  escalated_at     timestamptz
);
create index on alarms (device_id, raised_at desc);
create index on alarms (severity) where cleared_at is null;
-- Duplicate suppression: one uncleared alarm of a type per device. Info-level
-- entries are notifications of something that already happened (a batch was
-- diverted), not conditions, so they are exempt and may repeat.
create unique index alarms_one_active_per_type
  on alarms (device_id, type) where cleared_at is null and severity <> 'info';

-- ------------------------------------------------------------------ events ---
create table events (
  id         bigserial primary key,
  device_id  uuid not null references devices(id) on delete cascade,
  ts         timestamptz not null,
  type       text not null,          -- STATE_CHANGE | VALVE | INTERLOCK_BLOCK | BOOT | ...
  details    jsonb not null default '{}'::jsonb
);
create index on events (device_id, ts desc);

-- ---------------------------------------------------------------- commands ---
create type command_status as enum ('pending', 'accepted', 'rejected', 'expired');

create table commands (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid not null references devices(id) on delete cascade,
  requested_by  uuid references auth.users(id),
  type          text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        command_status not null default 'pending',
  reason        text,                                   -- the firmware's own words
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '30 seconds',
  resolved_at   timestamptz
);
create index on commands (device_id, status, created_at desc);

-- ------------------------------------------------------------- maintenance ---
create table maintenance_items (
  id              uuid primary key default gen_random_uuid(),
  device_id       uuid not null references devices(id) on delete cascade,
  component       text not null,          -- pH probe | TDS probe | dosing pump | V1 ...
  task            text not null,          -- calibrate | service | replace
  interval_days   integer,
  interval_hours  integer,
  interval_cycles integer,
  last_done_at    timestamptz,
  next_due_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index on maintenance_items (device_id, next_due_at);

create table maintenance_logs (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid references maintenance_items(id) on delete set null,
  device_id     uuid not null references devices(id) on delete cascade,
  performed_by  uuid references auth.users(id),
  performed_at  timestamptz not null default now(),
  notes         text,
  before_values jsonb not null default '{}'::jsonb,   -- e.g. {"ph_4":4.12,"ph_7":7.09}
  after_values  jsonb not null default '{}'::jsonb
);
create index on maintenance_logs (device_id, performed_at desc);

-- --------------------------------------------------------------- inventory ---
create table inventory (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references sites(id) on delete cascade,
  item           text not null default 'neutraliser',
  unit           text not null default 'L',
  stock          numeric(10,2) not null default 0,
  reorder_level  numeric(10,2) not null default 0,
  supplier       text,
  cost_per_unit  numeric(10,2),
  updated_at     timestamptz not null default now()
);
create index on inventory (site_id);

create table inventory_movements (
  id           uuid primary key default gen_random_uuid(),
  inventory_id uuid not null references inventory(id) on delete cascade,
  delta        numeric(10,2) not null,          -- + delivery, - usage
  kind         text not null,                   -- delivery | usage | adjustment
  note         text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);
create index on inventory_movements (inventory_id, created_at desc);

-- -------------------------------------------------------------- shift logs ---
create table shift_logs (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references sites(id) on delete cascade,
  author       uuid references auth.users(id),
  shift_start  timestamptz not null,
  shift_end    timestamptz,
  notes        text,
  handover_to  uuid references auth.users(id),
  created_at   timestamptz not null default now()
);
create index on shift_logs (site_id, shift_start desc);

-- --------------------------------------------------------------- audit log ---
create table audit_log (
  id           bigserial primary key,
  actor        uuid references auth.users(id),
  action       text not null,            -- INSERT | UPDATE | DELETE | ACK | COMMAND
  target_table text not null,
  target_id    text,
  before       jsonb,
  after        jsonb,
  ts           timestamptz not null default now()
);
create index on audit_log (ts desc);
create index on audit_log (target_table, target_id);

-- --------------------------------------------------- notification settings ---
create table notification_prefs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  site_id       uuid not null references sites(id) on delete cascade,
  email         boolean not null default true,
  sms           boolean not null default false,
  whatsapp      boolean not null default false,
  min_severity  alarm_severity not null default 'warning',
  unique (user_id, site_id)
);

-- ================================ retention ================================
-- Raw telemetry arrives every 5 s per device: ~17k rows/device/day. Keep 30
-- days raw, then roll up to hourly means and drop the raw rows. Schedule
-- downsample_telemetry() nightly with pg_cron (see 0005_retention.sql).
create table telemetry_hourly (
  device_id       uuid not null references devices(id) on delete cascade,
  hour            timestamptz not null,
  samples         integer not null,
  ph_avg          numeric(5,2), ph_min numeric(5,2), ph_max numeric(5,2),
  tds_avg         integer,      tds_min integer,     tds_max integer,
  tank_ph_avg     numeric(5,2),
  neutraliser_pct numeric(5,2),
  uptime_ratio    numeric(5,4),
  primary key (device_id, hour)
);
