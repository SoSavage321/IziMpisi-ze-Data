/**
 * Query hooks.
 *
 * Everything the dashboard shows comes through here. A single live
 * subscription invalidates the queries that can change, so the plant view
 * updates without every component opening its own socket.
 */

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, subscribeLive } from '../lib/api.ts';

export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    let frame = 0;
    const unsubscribe = subscribeLive(() => {
      // Coalesce a burst of changes into one invalidation per frame.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        qc.invalidateQueries({ queryKey: ['live'] });
      });
    });
    return () => { unsubscribe(); if (frame) cancelAnimationFrame(frame); };
  }, [qc]);
}

export const useFleet = () =>
  useQuery({ queryKey: ['live', 'fleet'], queryFn: api.fleet, refetchInterval: 5000 });

export const useDevice = (deviceId: string | undefined) =>
  useQuery({
    queryKey: ['live', 'device', deviceId],
    queryFn: () => api.device(deviceId as string),
    enabled: Boolean(deviceId),
    refetchInterval: 3000,
  });

export const useTelemetry = (deviceId: string | undefined, minutes = 30) =>
  useQuery({
    queryKey: ['live', 'telemetry', deviceId, minutes],
    queryFn: () => api.telemetry(deviceId as string, minutes),
    enabled: Boolean(deviceId),
    refetchInterval: 2000,
  });

export const useV3Lock = (deviceId: string | undefined) =>
  useQuery({
    queryKey: ['live', 'v3lock', deviceId],
    queryFn: () => api.v3Lock(deviceId as string),
    enabled: Boolean(deviceId),
    refetchInterval: 2000,
  });

export const useBatches = (opts: Parameters<typeof api.batches>[0] = {}) =>
  useQuery({ queryKey: ['live', 'batches', opts], queryFn: () => api.batches(opts), refetchInterval: 10_000 });

export const useCycles = (opts: Parameters<typeof api.cycles>[0] = {}) =>
  useQuery({ queryKey: ['live', 'cycles', opts], queryFn: () => api.cycles(opts), refetchInterval: 15_000 });

export const useAlarms = (opts: Parameters<typeof api.alarms>[0] = {}) =>
  useQuery({ queryKey: ['live', 'alarms', opts], queryFn: () => api.alarms(opts), refetchInterval: 5000 });

export const useCommands = (deviceId: string | undefined) =>
  useQuery({
    queryKey: ['live', 'commands', deviceId],
    queryFn: () => api.commands(deviceId as string),
    enabled: Boolean(deviceId),
    refetchInterval: 1500,
  });

export const useEvents = (deviceId: string | undefined, limit = 60) =>
  useQuery({
    queryKey: ['live', 'events', deviceId, limit],
    queryFn: () => api.events(deviceId as string, limit),
    enabled: Boolean(deviceId),
    refetchInterval: 4000,
  });

export const useConfigs = (deviceId: string | undefined) =>
  useQuery({
    queryKey: ['configs', deviceId],
    queryFn: () => api.configs(deviceId as string),
    enabled: Boolean(deviceId),
  });

export const useSites = () => useQuery({ queryKey: ['sites'], queryFn: api.sites });
export const useProfiles = () => useQuery({ queryKey: ['profiles'], queryFn: api.profiles });
export const useMaintenance = (deviceId?: string) =>
  useQuery({ queryKey: ['maintenance', deviceId], queryFn: () => api.maintenance(deviceId) });
export const useMaintenanceLogs = (deviceId?: string) =>
  useQuery({ queryKey: ['maintenance-logs', deviceId], queryFn: () => api.maintenanceLogs(deviceId) });
export const useDuty = (deviceId: string | undefined) =>
  useQuery({
    queryKey: ['duty', deviceId],
    queryFn: () => api.duty(deviceId as string),
    enabled: Boolean(deviceId),
  });
export const useInventory = () => useQuery({ queryKey: ['inventory'], queryFn: api.inventory });
export const useMovements = (inventoryId?: string) =>
  useQuery({ queryKey: ['movements', inventoryId], queryFn: () => api.movements(inventoryId) });
export const useShifts = (siteId?: string) =>
  useQuery({ queryKey: ['shifts', siteId], queryFn: () => api.shifts(siteId) });
export const useAudit = (opts: Parameters<typeof api.audit>[0] = {}) =>
  useQuery({ queryKey: ['audit', opts], queryFn: () => api.audit(opts) });
