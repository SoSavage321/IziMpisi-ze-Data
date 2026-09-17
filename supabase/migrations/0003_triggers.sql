-- ============================================================================
-- Triggers: audit trail, config versioning, maintenance scheduling
-- ============================================================================

-- --------------------------------------------------------------- audit log ---
create or replace function app.write_audit() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_before jsonb;
  v_after  jsonb;
  v_id     text;
begin
  if tg_op = 'INSERT' then
    v_before := null; v_after := to_jsonb(new); v_id := new.id::text;
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old); v_after := to_jsonb(new); v_id := new.id::text;
  else
    v_before := to_jsonb(old); v_after := null; v_id := old.id::text;
  end if;

  insert into audit_log (actor, action, target_table, target_id, before, after)
  values (auth.uid(), tg_op, tg_table_name, v_id, v_before, v_after);

  return coalesce(new, old);
end $$;

create trigger audit_device_config after insert or update or delete on device_config
  for each row execute function app.write_audit();
create trigger audit_commands      after insert or update on commands
  for each row execute function app.write_audit();
create trigger audit_devices       after insert or update or delete on devices
  for each row execute function app.write_audit();
create trigger audit_sites         after insert or update or delete on sites
  for each row execute function app.write_audit();
create trigger audit_profiles      after insert or update or delete on profiles
  for each row execute function app.write_audit();
create trigger audit_inventory     after update on inventory
  for each row execute function app.write_audit();

-- Alarms are noisy; only acknowledgement is interesting for the audit trail.
create or replace function app.audit_alarm_ack() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.acknowledged_at is distinct from old.acknowledged_at and new.acknowledged_at is not null then
    insert into audit_log (actor, action, target_table, target_id, before, after)
    values (new.acknowledged_by, 'ACK', 'alarms', new.id::text,
            jsonb_build_object('acknowledged_at', old.acknowledged_at),
            jsonb_build_object('acknowledged_at', new.acknowledged_at, 'note', new.ack_note));
  end if;
  return new;
end $$;

create trigger audit_alarms after update on alarms
  for each row execute function app.audit_alarm_ack();

-- --------------------------------------------------------- config versions ---
-- A new config row is the new desired version for the device. The device
-- confirms by setting applied_at (through the ingest function).
create or replace function app.bump_config_version() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.version is null or new.version = 0 then
    select coalesce(max(version), 0) + 1 into new.version
      from device_config where device_id = new.device_id;
  end if;
  return new;
end $$;

create trigger config_version_before before insert on device_config
  for each row execute function app.bump_config_version();

create or replace function app.point_device_at_config() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update devices set config_version = new.version where id = new.device_id;
  return new;
end $$;

create trigger config_version_after after insert on device_config
  for each row execute function app.point_device_at_config();

-- ------------------------------------------------------ maintenance due date ---
create or replace function app.compute_next_due() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.interval_days is not null and new.last_done_at is not null then
    new.next_due_at := new.last_done_at + (new.interval_days || ' days')::interval;
  end if;
  return new;
end $$;

create trigger maintenance_due before insert or update on maintenance_items
  for each row execute function app.compute_next_due();

-- Recording a maintenance log closes out the item it belongs to.
create or replace function app.close_maintenance_item() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.item_id is not null then
    update maintenance_items
       set last_done_at = new.performed_at
     where id = new.item_id;
  end if;
  return new;
end $$;

create trigger maintenance_log_closes after insert on maintenance_logs
  for each row execute function app.close_maintenance_item();

-- ------------------------------------------------------------ inventory ---
create or replace function app.apply_inventory_movement() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update inventory
     set stock = greatest(0, stock + new.delta), updated_at = now()
   where id = new.inventory_id;
  return new;
end $$;

create trigger inventory_movement_applies after insert on inventory_movements
  for each row execute function app.apply_inventory_movement();

-- ------------------------------------------------- new user gets a profile ---
-- Supabase auth writes to auth.users; mirror the signup into profiles using
-- the metadata the invite carried. Role defaults to viewer — admins promote.
create or replace function app.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into profiles (user_id, org_id, full_name, phone, role)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'org_id', '')::uuid,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    new.raw_user_meta_data ->> 'phone',
    coalesce((new.raw_user_meta_data ->> 'role')::user_role, 'viewer')
  )
  on conflict (user_id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();
