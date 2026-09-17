/**
 * Control panel.
 *
 * Everything here is a REQUEST. The dashboard has no authority over the plant:
 * it writes a row, the firmware validates it against its interlocks and its
 * own sensor readings, and answers accepted or rejected with a reason. That
 * answer is shown verbatim, including the rejections — an operator needs to
 * know that the plant refused, and why, far more than they need a green tick.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle, BellOff, CheckCircle2, ChevronLeft, OctagonX, PauseCircle,
  PlayCircle, RotateCcw, Wrench, XCircle,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCommands, useDevice, useV3Lock } from '../hooks/data.ts';
import { useAuth } from '../hooks/auth.tsx';
import { api } from '../lib/api.ts';
import { ago, siteTime } from '../lib/format.ts';
import {
  Badge, Button, Card, CardHead, Dialog, Empty, Field, Spinner, Textarea, cn, stateTone, useToast,
} from '../components/ui.tsx';
import type { Command } from '../lib/types.ts';

interface PendingAction {
  type: string;
  payload: Record<string, unknown>;
  title: string;
  effect: string;
  danger?: boolean;
}

export default function Control() {
  const { deviceId } = useParams();
  const { data: device, isLoading } = useDevice(deviceId);
  const { data: commands } = useCommands(deviceId);
  const { data: v3Lock } = useV3Lock(deviceId);
  const { session, can } = useAuth();
  const { push } = useToast();
  const qc = useQueryClient();

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (isLoading) return <Spinner label="Loading controls" />;
  if (!device) return <p className="text-muted">That device does not exist, or you cannot see it.</p>;

  const readOnly = !can('operate');
  const mode = device.mode ?? 'AUTO';
  const manual = mode === 'MANUAL';
  const state = stateTone(device.state, device.offline);

  async function send(action: PendingAction) {
    if (!session) return;
    setBusy(true);
    try {
      const cmd = await api.sendCommand(device!.device_id, action.type, action.payload, session.user_id);
      push({
        tone: 'info',
        title: `${action.title} sent to the device`,
        body: 'Waiting for the controller to accept or reject it.',
      });
      qc.invalidateQueries({ queryKey: ['live', 'commands'] });
      // Watch for the verdict so the operator sees the outcome, not just the send.
      watchVerdict(cmd.id);
    } catch (e) {
      push({ tone: 'crit', title: 'Could not send the command', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setPending(null);
      setNote('');
    }
  }

  function watchVerdict(id: string) {
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      const rows = await api.commands(device!.device_id);
      const row = rows.find((c) => c.id === id);
      qc.invalidateQueries({ queryKey: ['live', 'commands'] });
      if (row && row.status !== 'pending') {
        clearInterval(timer);
        push({
          tone: row.status === 'accepted' ? 'good' : row.status === 'rejected' ? 'crit' : 'warn',
          title: `${row.type} ${row.status}`,
          body: row.reason ?? undefined,
          sound: row.status === 'rejected',
        });
      }
      if (tries > 20) clearInterval(timer);
    }, 1200);
  }

  const ask = (action: PendingAction) => setPending(action);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to={`/device/${deviceId}`} className="mb-1 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
            <ChevronLeft className="h-3.5 w-3.5" /> Back to the live view
          </Link>
          <h1 className="text-[22px] font-semibold leading-tight text-ink">Controls · {device.device_name}</h1>
          <p className="text-sm text-muted">{device.site_name}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={state.tone}>{state.label}</Badge>
          <Badge tone={mode === 'AUTO' ? 'neutral' : 'warn'}>{mode}</Badge>
        </div>
      </header>

      {readOnly ? (
        <div className="rounded-xl border border-line bg-raised p-4 text-sm text-ink-2">
          You have view-only access. Ask an operator or an administrator to make changes.
        </div>
      ) : null}

      {device.offline ? (
        <div className="rounded-xl border border-crit/50 bg-crit/5 p-4 text-sm">
          <p className="font-medium text-crit-ink">This device is offline — last seen {ago(device.last_seen)}</p>
          <p className="mt-1 text-ink-2">
            Commands will queue, but they expire after 30 seconds, so anything sent now will almost certainly
            expire before the device reconnects. The plant keeps running its own logic while it is offline.
          </p>
        </div>
      ) : null}

      {/* -------------------------------------------------- emergency stop --- */}
      <Card className="border-crit/40">
        <CardHead title="Emergency stop" hint="Shuts every valve and stops every pump, immediately" />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {device.estop ? (
            <Button
              variant="primary" size="lg" disabled={readOnly}
              onClick={() => ask({
                type: 'RESET_ESTOP', payload: {}, title: 'Reset the emergency stop',
                effect: 'The plant returns to AUTO and resumes filling. The device will refuse this if the physical E-stop button at the panel is still engaged.',
              })}
            >
              <RotateCcw className="h-5 w-5" /> Reset emergency stop
            </Button>
          ) : (
            <button
              disabled={readOnly}
              onClick={() => ask({
                type: 'EMERGENCY_STOP', payload: {}, title: 'Emergency stop', danger: true,
                effect: 'Every valve shuts and every pump stops at once. Water already in the chamber stays there. The plant will not restart until the E-stop is reset.',
              })}
              className={cn(
                'flex h-28 w-full items-center justify-center gap-3 rounded-xl border-4 border-crit bg-crit text-lg font-bold uppercase tracking-wider text-white sm:w-72',
                'hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-crit',
                'disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              <OctagonX className="h-8 w-8" /> Emergency stop
            </button>
          )}
          <p className="text-sm text-ink-2">
            {device.estop
              ? 'The emergency stop is currently engaged.'
              : 'Use this if water is reaching the river that should not be, or if anyone is working on the plant.'}
          </p>
        </div>
      </Card>

      {/* ------------------------------------------------------------ mode --- */}
      <Card>
        <CardHead title="Operating mode" hint="Manual and maintenance both stop the automatic batch sequence" />
        <div className="flex flex-wrap gap-2">
          {(['AUTO', 'MANUAL', 'MAINTENANCE'] as const).map((m) => (
            <Button
              key={m}
              variant={mode === m ? 'primary' : 'default'}
              disabled={readOnly || mode === m}
              onClick={() => ask({
                type: 'SET_MODE', payload: { mode: m }, title: `Switch to ${m}`,
                effect: m === 'AUTO'
                  ? 'The plant resumes the automatic fill, test, decide sequence.'
                  : m === 'MANUAL'
                    ? 'The automatic sequence stops. You can drive individual valves and pumps, but every interlock still applies — the device will refuse anything unsafe.'
                    : 'The plant stops, valves shut and pumps stop, so probes can be removed for calibration.',
              })}
            >
              {m}
            </Button>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          The device refuses a mode change while it is actually releasing water, so a batch in progress is never
          abandoned half-discharged.
        </p>
      </Card>

      {/* --------------------------------------------------- manual valves --- */}
      <Card className={cn(!manual && 'opacity-60')}>
        <CardHead
          title="Manual valves and pumps"
          hint={manual ? 'Interlocks still apply to every one of these' : 'Switch to MANUAL mode to use these'}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          {(['V1', 'V2', 'V3'] as const).map((valve) => {
            const open = valve === 'V1' ? device.v1 : valve === 'V2' ? device.v2 : device.v3;
            const locked = valve === 'V3' ? v3Lock : null;
            return (
              <div key={valve} className="rounded-lg border border-line p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-sm font-medium text-ink">{valve}</span>
                  <Badge tone={open ? 'good' : locked ? 'crit' : 'neutral'}>
                    {open ? 'Open' : locked ? 'Locked' : 'Shut'}
                  </Badge>
                </div>
                <p className="mb-2 text-xs text-muted">
                  {valve === 'V1' ? 'Chamber → river' : valve === 'V2' ? 'Chamber → treatment tank' : 'Tank → river'}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" disabled={readOnly || !manual || Boolean(open)}
                    onClick={() => ask({
                      type: 'MANUAL_VALVE', payload: { valve, open: true }, title: `Open ${valve}`,
                      effect: valve === 'V1'
                        ? 'Sends whatever is in the chamber to the river. The device refuses this if the water has not passed the test.'
                        : valve === 'V2'
                          ? 'Sends the chamber contents to the treatment tank.'
                          : 'Releases the treatment tank to the river. The device refuses this while V2 is open, while the tank is out of band, or when the neutraliser is empty.',
                    })}>
                    Open
                  </Button>
                  <Button size="sm" disabled={readOnly || !manual || !open}
                    onClick={() => ask({
                      type: 'MANUAL_VALVE', payload: { valve, open: false }, title: `Close ${valve}`,
                      effect: 'Closing a valve is always allowed.',
                    })}>
                    Close
                  </Button>
                </div>
                {locked && valve === 'V3' ? <p className="mt-2 text-xs text-crit-ink">{locked}</p> : null}
              </div>
            );
          })}
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {(['sump', 'dosing'] as const).map((pump) => (
            <div key={pump} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
              <span className="text-sm capitalize text-ink">{pump} pump</span>
              <div className="flex gap-2">
                <Button size="sm" disabled={readOnly || !manual}
                  onClick={() => ask({
                    type: 'MANUAL_PUMP', payload: { pump, on: true }, title: `Start the ${pump} pump`,
                    effect: pump === 'dosing'
                      ? 'Runs the dosing pump. The device refuses this when the neutraliser reservoir is empty.'
                      : 'Runs the sump pump, filling the check chamber.',
                  })}>Start</Button>
                <Button size="sm" disabled={readOnly || !manual}
                  onClick={() => ask({
                    type: 'MANUAL_PUMP', payload: { pump, on: false }, title: `Stop the ${pump} pump`,
                    effect: 'Stops the pump.',
                  })}>Stop</Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ------------------------------------------------------ operations --- */}
      <Card>
        <CardHead title="Operations" />
        <div className="flex flex-wrap gap-2">
          <Button disabled={readOnly}
            onClick={() => ask({
              type: 'PAUSE_INTAKE', payload: {}, title: 'Pause intake',
              effect: 'Stops the sump pump. Water already in the chamber is untouched and will still be tested.',
            })}>
            <PauseCircle className="h-4 w-4" /> Pause intake
          </Button>
          <Button disabled={readOnly}
            onClick={() => ask({
              type: 'RESUME_INTAKE', payload: {}, title: 'Resume intake',
              effect: 'The sump pump starts filling the chamber again.',
            })}>
            <PlayCircle className="h-4 w-4" /> Resume intake
          </Button>
          <Button disabled={readOnly}
            onClick={() => ask({
              type: 'START_BATCH', payload: {}, title: 'Start a batch',
              effect: 'Requires AUTO mode and an idle plant. Fills the chamber to the batch volume and tests it.',
            })}>
            Start a batch
          </Button>
          <Button disabled={readOnly}
            onClick={() => ask({
              type: 'SILENCE_SIREN', payload: {}, title: 'Silence the siren',
              effect: 'Silences the siren for five minutes. The alarm itself stays active and the cause is unchanged.',
            })}>
            <BellOff className="h-4 w-4" /> Silence siren
          </Button>
          <Button disabled={!can('administer')}
            onClick={() => ask({
              type: 'REQUEST_CALIBRATION_MODE', payload: {}, title: 'Enter calibration mode',
              effect: 'Stops the plant and shuts every valve so the probes can be lifted into buffer solutions. Admins only.',
            })}>
            <Wrench className="h-4 w-4" /> Calibration mode
          </Button>
        </div>
      </Card>

      {/* --------------------------------------------------------- history --- */}
      <Card>
        <CardHead title="Recent requests" hint="What the device did with each one" />
        {commands?.length ? (
          <ul className="space-y-2">
            {commands.map((c) => <CommandRow key={c.id} c={c} tz={device.timezone} />)}
          </ul>
        ) : (
          <Empty title="No commands yet" body="Anything you send from this page will appear here with the device's answer." />
        )}
      </Card>

      <Dialog
        open={Boolean(pending)}
        onClose={() => { setPending(null); setNote(''); }}
        title={pending?.title ?? ''}
        description={
          <div className="space-y-2">
            <p>{pending?.effect}</p>
            <p className="text-xs text-muted">
              This is a request. {device.device_name} checks it against its own interlocks and may refuse it.
            </p>
          </div>
        }
        footer={
          <>
            <Button onClick={() => { setPending(null); setNote(''); }}>Cancel</Button>
            <Button
              variant={pending?.danger ? 'danger' : 'primary'}
              loading={busy}
              onClick={() => pending && send(pending)}
            >
              {pending?.danger ? 'Yes, stop the plant' : 'Send the request'}
            </Button>
          </>
        }
      >
        <Field label="Note (optional)" hint="Recorded with the request in the audit trail">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why are you doing this?" />
        </Field>
      </Dialog>
    </div>
  );
}

function CommandRow({ c, tz }: { c: Command; tz: string }) {
  const icon = c.status === 'accepted' ? CheckCircle2 : c.status === 'rejected' ? XCircle : c.status === 'expired' ? AlertTriangle : null;
  const Icon = icon;
  const tone = c.status === 'accepted' ? 'good' : c.status === 'rejected' ? 'crit' : c.status === 'expired' ? 'warn' : 'info';

  return (
    <li className={cn(
      'rounded-lg border p-3',
      c.status === 'rejected' ? 'border-crit/50 bg-crit/5' : 'border-line',
    )}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm text-ink">{c.type}</span>
        <Badge tone={tone as 'good'}>
          {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
          {c.status}
        </Badge>
      </div>
      {Object.keys(c.payload ?? {}).length ? (
        <p className="mt-1 font-mono text-xs text-muted">{JSON.stringify(c.payload)}</p>
      ) : null}
      {c.reason ? (
        <p className={cn('mt-1.5 text-sm', c.status === 'rejected' ? 'text-crit' : 'text-ink-2')}>
          {c.reason}
        </p>
      ) : (
        <p className="mt-1.5 text-sm text-muted">Waiting for the device…</p>
      )}
      <p className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">
        {siteTime(c.created_at, tz)} · {c.requested_by_name ?? 'operator'}
      </p>
    </li>
  );
}
