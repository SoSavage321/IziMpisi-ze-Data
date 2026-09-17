import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Demo mode.
 *
 * With no Supabase project configured the whole dashboard runs against an
 * in-browser simulation (see lib/demo.ts) that uses the same controller and
 * alarm rules as the real system. That means `npm run dev` shows a full,
 * moving dashboard on a laptop with no backend, which is what a hackathon
 * table actually needs. Set the two VITE_ variables and it switches to the
 * real backend with no code change.
 */
/**
 * True when Supabase itself is not configured. `api.ts` combines this with the
 * Firebase check to decide the actual backend — do not import this directly to
 * mean "demo mode".
 */
export const isDemo = !url || !anon;

export const supabase: SupabaseClient | null = isDemo
  ? null
  : createClient(url as string, anon as string, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 5 } },
    });

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error('Supabase is not configured; the app is in demo mode');
  return supabase;
}
