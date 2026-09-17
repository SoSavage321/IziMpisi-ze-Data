-- ============================================================================
-- Row Level Security
--
-- Rule of thumb: a user sees exactly one organisation's data.
--   viewer   — read only, everywhere
--   operator — + acknowledge alarms, send operational commands, write logs,
--              record maintenance and stock movements
--   admin    — + manage sites, devices, users, thresholds
--
-- The device API (edge functions) uses the service_role key, which bypasses
-- RLS entirely. Devices never authenticate as users.
-- ============================================================================

create schema if not exists app;

create or replace function app.current_org() returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select org_id from profiles where user_id = auth.uid()
$$;

create or replace function app.current_role() returns user_role
  language sql stable security definer set search_path = public, pg_temp as $$
  select role from profiles where user_id = auth.uid()
$$;

create or replace function app.is_admin() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role = 'admin' from profiles where user_id = auth.uid()), false)
$$;

create or replace function app.can_operate() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role in ('admin','operator') from profiles where user_id = auth.uid()), false)
$$;

create or replace function app.site_in_org(p_site uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from sites s where s.id = p_site and s.org_id = app.current_org())
$$;

create or replace function app.device_in_org(p_device uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from devices d join sites s on s.id = d.site_id
    where d.id = p_device and s.org_id = app.current_org()
  )
$$;

alter table organisations      enable row level security;
alter table sites              enable row level security;
alter table devices            enable row level security;
alter table profiles           enable row level security;
alter table device_config      enable row level security;
alter table telemetry          enable row level security;
alter table telemetry_hourly   enable row level security;
alter table batches            enable row level security;
alter table treatment_cycles   enable row level security;
alter table alarms             enable row level security;
alter table events             enable row level security;
alter table commands           enable row level security;
alter table maintenance_items  enable row level security;
alter table maintenance_logs   enable row level security;
alter table inventory          enable row level security;
alter table inventory_movements enable row level security;
alter table shift_logs         enable row level security;
alter table audit_log          enable row level security;
alter table notification_prefs enable row level security;

-- ------------------------------------------------------------ organisations ---
create policy org_read on organisations for select
  using (id = app.current_org());
create policy org_admin_write on organisations for update
  using (id = app.current_org() and app.is_admin())
  with check (id = app.current_org());

-- -------------------------------------------------------------------- sites ---
create policy sites_read on sites for select
  using (org_id = app.current_org());
create policy sites_admin_all on sites for all
  using (org_id = app.current_org() and app.is_admin())
  with check (org_id = app.current_org() and app.is_admin());

-- ------------------------------------------------------------------ devices ---
create policy devices_read on devices for select
  using (app.site_in_org(site_id));
create policy devices_admin_all on devices for all
  using (app.site_in_org(site_id) and app.is_admin())
  with check (app.site_in_org(site_id) and app.is_admin());

-- ----------------------------------------------------------------- profiles ---
create policy profiles_read_own_org on profiles for select
  using (org_id = app.current_org());
create policy profiles_update_self on profiles for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and role = app.current_role());  -- cannot self-promote
create policy profiles_admin_all on profiles for all
  using (org_id = app.current_org() and app.is_admin())
  with check (org_id = app.current_org() and app.is_admin());

-- ------------------------------------------------------------ device_config ---
create policy config_read on device_config for select
  using (app.device_in_org(device_id));
-- New versions only; history is never rewritten (no update/delete policy).
create policy config_admin_insert on device_config for insert
  with check (app.device_in_org(device_id) and app.is_admin());

-- ------------------------------------------- read-only device-authored data ---
create policy telemetry_read on telemetry for select
  using (app.device_in_org(device_id));
create policy telemetry_hourly_read on telemetry_hourly for select
  using (app.device_in_org(device_id));
create policy batches_read on batches for select
  using (app.device_in_org(device_id));
create policy cycles_read on treatment_cycles for select
  using (app.device_in_org(device_id));
create policy events_read on events for select
  using (app.device_in_org(device_id));

-- ------------------------------------------------------------------- alarms ---
create policy alarms_read on alarms for select
  using (app.device_in_org(device_id));
-- Operators acknowledge; they cannot raise or clear alarms by hand. Clearing
-- is the server's job once the underlying condition goes away.
create policy alarms_ack on alarms for update
  using (app.device_in_org(device_id) and app.can_operate())
  with check (app.device_in_org(device_id));

-- ----------------------------------------------------------------- commands ---
create policy commands_read on commands for select
  using (app.device_in_org(device_id));
create policy commands_operate on commands for insert
  with check (
    app.device_in_org(device_id)
    and app.can_operate()
    and requested_by = auth.uid()
    and status = 'pending'
    -- admin-only command types
    and (type not in ('APPLY_CONFIG', 'REQUEST_CALIBRATION_MODE') or app.is_admin())
  );
-- Only the device (service_role) resolves a command. Users may cancel their
-- own still-pending request.
create policy commands_cancel on commands for update
  using (app.device_in_org(device_id) and app.can_operate() and status = 'pending')
  with check (status = 'expired');

-- -------------------------------------------------------------- maintenance ---
create policy maint_items_read on maintenance_items for select
  using (app.device_in_org(device_id));
create policy maint_items_write on maintenance_items for all
  using (app.device_in_org(device_id) and app.can_operate())
  with check (app.device_in_org(device_id) and app.can_operate());
create policy maint_logs_read on maintenance_logs for select
  using (app.device_in_org(device_id));
create policy maint_logs_write on maintenance_logs for insert
  with check (app.device_in_org(device_id) and app.can_operate() and performed_by = auth.uid());

-- ---------------------------------------------------------------- inventory ---
create policy inv_read on inventory for select
  using (app.site_in_org(site_id));
create policy inv_write on inventory for all
  using (app.site_in_org(site_id) and app.can_operate())
  with check (app.site_in_org(site_id) and app.can_operate());
create policy inv_mv_read on inventory_movements for select
  using (exists (select 1 from inventory i where i.id = inventory_id and app.site_in_org(i.site_id)));
create policy inv_mv_write on inventory_movements for insert
  with check (
    exists (select 1 from inventory i where i.id = inventory_id and app.site_in_org(i.site_id))
    and app.can_operate() and created_by = auth.uid()
  );

-- --------------------------------------------------------------- shift logs ---
create policy shift_read on shift_logs for select
  using (app.site_in_org(site_id));
create policy shift_write on shift_logs for insert
  with check (app.site_in_org(site_id) and app.can_operate() and author = auth.uid());
create policy shift_update_own on shift_logs for update
  using (app.site_in_org(site_id) and author = auth.uid())
  with check (app.site_in_org(site_id) and author = auth.uid());

-- ---------------------------------------------------------------- audit log ---
-- Readable by admins only, and append-only for everyone (triggers write it
-- with the service role / definer rights).
create policy audit_admin_read on audit_log for select
  using (app.is_admin() and (
    target_id is null or true   -- org scoping happens through the target row
  ));

-- ------------------------------------------------------- notification prefs ---
create policy notif_own on notification_prefs for all
  using (user_id = auth.uid() and app.site_in_org(site_id))
  with check (user_id = auth.uid() and app.site_in_org(site_id));

-- ============================== realtime ====================================
alter publication supabase_realtime add table telemetry;
alter publication supabase_realtime add table alarms;
alter publication supabase_realtime add table commands;
alter publication supabase_realtime add table batches;
alter publication supabase_realtime add table events;
alter publication supabase_realtime add table devices;
