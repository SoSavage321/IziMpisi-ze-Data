import { useEffect, useState } from 'react';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { Logo } from '../components/shell.tsx';
import { useAuth } from '../hooks/auth.tsx';
import { isDemo } from '../lib/api.ts';
import { isFirebase } from '../lib/firebase.ts';
import { firebaseAuthReadiness, type AuthReadiness } from '../lib/backend-firebase.ts';
import { DEMO_USERS } from '../lib/demo.ts';
import { Button, Card, Field, Input } from '../components/ui.tsx';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A fresh Firebase project has no Authentication config until somebody
   *  opens the console once, so check before the operator wastes a login. */
  const [readiness, setReadiness] = useState<AuthReadiness | null>(null);

  useEffect(() => {
    if (!isFirebase) return;
    firebaseAuthReadiness().then(setReadiness).catch(() => setReadiness({ ready: true }));
  }, []);

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
        {readiness && !readiness.ready ? (
          <div className="mb-5 rounded-xl border border-warn/40 bg-warn/5 p-4">
            <div className="flex gap-3">
              <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-warn-ink" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">
                  {readiness.reason === 'not-provisioned'
                    ? 'Authentication is not switched on yet'
                    : 'Email sign-in is switched off'}
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                  {readiness.reason === 'not-provisioned'
                    ? 'This Firebase project has never had its Authentication service started, so no one can sign in yet. It is a one-time click and there is no API for it on the free plan.'
                    : 'The project has Authentication, but the Email/Password provider is disabled.'}
                </p>
                <ol className="mt-2.5 space-y-1 text-[13px] text-ink-2">
                  <li>1. Open the Authentication page below</li>
                  <li>2. Click <strong className="font-medium text-ink">Get started</strong> if it appears</li>
                  <li>3. Choose <strong className="font-medium text-ink">Email/Password</strong>, turn on the first toggle, and save</li>
                  <li>4. Come back here and reload</li>
                </ol>
                <a
                  href={`https://console.firebase.google.com/project/${readiness.projectId}/authentication/providers`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] font-medium text-ink shadow-xs hover:bg-raised"
                >
                  Open Firebase Authentication
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </div>
            </div>
          </div>
        ) : null}

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
