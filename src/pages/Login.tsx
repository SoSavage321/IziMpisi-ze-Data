import { useState } from 'react';
import { Logo } from '../components/shell.tsx';
import { useAuth } from '../hooks/auth.tsx';
import { isDemo } from '../lib/supabase.ts';
import { DEMO_USERS } from '../lib/demo.ts';
import { Button, Card, Field, Input } from '../components/ui.tsx';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Logo className="mx-auto mb-3 h-12 w-12" />
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">
            WaterGuard
          </h1>
          <p className="mt-1 text-sm text-muted">
            Acid mine drainage — test before release
          </p>
        </div>

        <Card>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email" htmlFor="email">
              <Input id="email" type="email" autoComplete="username" required
                value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@mine.co.za" />
            </Field>
            <Field label="Password" htmlFor="password" error={error}>
              <Input id="password" type="password" autoComplete="current-password" required
                value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
              Sign in
            </Button>
          </form>

          {isDemo ? (
            <div className="mt-5 border-t border-line pt-4">
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                Demo accounts — no backend configured
              </p>
              <div className="space-y-1.5">
                {DEMO_USERS.map((u) => (
                  <button
                    key={u.user_id}
                    type="button"
                    onClick={() => { setEmail(u.email as string); setPassword(u.password); }}
                    className="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-xs hover:border-accent"
                  >
                    <span className="text-ink">{u.full_name}</span>
                    <span className="font-mono uppercase tracking-[0.1em] text-muted">{u.role}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">Tap one to fill the form. Password: demo1234</p>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
