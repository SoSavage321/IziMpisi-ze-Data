import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { auth, type Session } from '../lib/api.ts';
import type { Role } from '../lib/types.ts';

interface AuthValue {
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Role checks used all over the UI to hide what a user may not do. */
  can: (action: 'operate' | 'administer') => boolean;
  role: Role | null;
}

const Ctx = createContext<AuthValue>(null as unknown as AuthValue);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    auth.current()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setSession(await auth.signIn(email, password));
  }, []);

  const signOut = useCallback(async () => {
    await auth.signOut();
    setSession(null);
  }, []);

  const role = session?.profile.role ?? null;

  const value = useMemo<AuthValue>(() => ({
    session,
    loading,
    signIn,
    signOut,
    role,
    // Viewers are strictly read-only; operators run the plant; admins also
    // manage people, devices and thresholds.
    can: (action) =>
      action === 'administer' ? role === 'admin' : role === 'admin' || role === 'operator',
  }), [session, loading, signIn, signOut, role]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}
