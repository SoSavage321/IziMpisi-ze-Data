import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PackagePlus, TriangleAlert } from 'lucide-react';
import { useCycles, useFleet, useInventory, useMovements } from '../hooks/data.ts';
import { useAuth } from '../hooks/auth.tsx';
import { api } from '../lib/api.ts';
import { daysOfStockLeft } from '@shared/reports.ts';
import { num, siteDateTime } from '../lib/format.ts';
import {
  Badge, Button, Card, CardHead, Dialog, Empty, Field, Input, Select, Spinner,
  Table, Td, Textarea, useToast,
} from '../components/ui.tsx';
import type { InventoryItem } from '../lib/types.ts';

/** The prototype doses from 20 L drums. TODO: make this a site setting. */
const RESERVOIR_L = 20;

export default function Inventory() {
  const { data: items, isLoading } = useInventory();
  const { data: movements } = useMovements();
  const { data: fleet } = useFleet();
  const { data: cycles } = useCycles({ from: new Date(Date.now() - 7 * 86400_000).toISOString() });
  const { session, can } = useAuth();
  const { push } = useToast();
  const qc = useQueryClient();

  const [receiving, setReceiving] = useState<InventoryItem | null>(null);
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState('delivery');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  /** Litres of neutraliser burned per day at each site, from treatment cycles. */
  const burnRate = useMemo(() => {
    const perSite = new Map<string, number>();
    for (const c of cycles ?? []) {
      const site = fleet?.find((f) => f.device_id === c.device_id)?.site_id;
      if (!site) continue;
      const litres = ((c.neutraliser_used_pct ?? 0) / 100) * RESERVOIR_L;
      perSite.set(site, (perSite.get(site) ?? 0) + litres);
    }
    // seven days of cycles -> a per-day figure
    return new Map([...perSite].map(([site, litres]) => [site, litres / 7]));
  }, [cycles, fleet]);

  async function record() {
    if (!receiving || !session) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value === 0) {
      push({ tone: 'warn', title: 'Enter an amount', body: 'How many litres moved?' });
      return;
    }
    setBusy(true);
    try {
      const delta = kind === 'delivery' ? Math.abs(value) : -Math.abs(value);
      await api.addMovement(receiving.id, delta, kind, note, session.user_id);
      push({ tone: 'good', title: 'Stock updated', body: `${kind === 'delivery' ? 'Received' : 'Issued'} ${Math.abs(value)} ${receiving.unit}.` });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['movements'] });
      setReceiving(null);
      setAmount('');
      setNote('');
    } catch (e) {
      push({ tone: 'crit', title: 'Could not record it', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Spinner label="Loading stock" />;

  const siteName = (id: string) => fleet?.find((f) => f.site_id === id)?.site_name ?? id;
  const low = (items ?? []).filter((i) => i.stock <= i.reorder_level);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-display text-lg font-semibold text-ink">Neutraliser stock</h1>
        <p className="text-sm text-muted">
          What is in the store, how fast it is going, and when to order more
        </p>
      </header>

      {low.length ? (
        <div className="flex items-start gap-3 rounded-xl border border-warn bg-warn/10 p-4">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
          <div className="text-sm">
            <p className="font-medium text-warn">
              {low.length} item{low.length === 1 ? ' is' : 's are'} at or below the reorder level
            </p>
            <p className="mt-0.5 text-ink-2">
              If the neutraliser runs out, the plant locks V3 and holds treated water rather than releasing it
              untreated. Nothing unsafe is discharged, but the tank backs up and batches start being held.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {(items ?? []).map((i) => {
          const perDay = burnRate.get(i.site_id) ?? 0;
          const days = daysOfStockLeft(Number(i.stock), perDay);
          const frac = Math.min(1, Number(i.stock) / Math.max(1, Number(i.reorder_level) * 3));
          const lowStock = Number(i.stock) <= Number(i.reorder_level);
          return (
            <Card key={i.id}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-ink">{siteName(i.site_id)}</p>
                  <p className="text-xs text-muted">{i.item}</p>
                </div>
                {lowStock ? <Badge tone="warn">reorder</Badge> : <Badge tone="good">in stock</Badge>}
              </div>

              <div className="flex items-end gap-2">
                <span className="font-mono text-3xl font-semibold tabular text-ink">{num(i.stock)}</span>
                <span className="pb-1 text-sm text-muted">{i.unit}</span>
              </div>

              <div className="mt-2 h-2 overflow-hidden rounded-full bg-raised">
                <div className={`h-full rounded-full ${lowStock ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${frac * 100}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted">Reorder level {num(i.reorder_level)} {i.unit}</p>

              <dl className="mt-4 space-y-2 border-t border-line pt-3 text-sm">
                <Row k="Usage rate" v={perDay > 0 ? `${num(perDay, 2)} ${i.unit}/day` : 'no recent treatment'} />
                <Row k="Estimated days left" v={days === null ? '—' : `${days} days`}
                  tone={days !== null && days < 7 ? 'crit' : undefined} />
                <Row k="Supplier" v={i.supplier ?? '—'} />
                <Row k="Cost" v={i.cost_per_unit ? `R ${num(i.cost_per_unit, 2)} / ${i.unit}` : '—'} />
                <Row k="Cost per day" v={i.cost_per_unit ? `R ${num(perDay * Number(i.cost_per_unit), 2)}` : '—'} />
              </dl>

              <Button className="mt-4 w-full" disabled={!can('operate')}
                onClick={() => { setReceiving(i); setKind('delivery'); }}>
                <PackagePlus className="h-4 w-4" /> Record a movement
              </Button>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHead title="Stock movements" hint="Deliveries in, drum refills out" />
        {movements?.length ? (
          <Table head={['When', 'Site', 'Change', 'Kind', 'Note', 'By']}>
            {movements.map((m) => {
              const item = items?.find((i) => i.id === m.inventory_id);
              return (
                <tr key={m.id} className="hover:bg-raised">
                  <Td className="font-mono text-xs">{siteDateTime(m.created_at)}</Td>
                  <Td className="text-xs">{item ? siteName(item.site_id) : '—'}</Td>
                  <Td className={`font-mono tabular ${m.delta > 0 ? 'text-good' : 'text-ink'}`}>
                    {m.delta > 0 ? '+' : ''}{num(m.delta)} {item?.unit ?? 'L'}
                  </Td>
                  <Td className="capitalize text-xs">{m.kind}</Td>
                  <Td className="text-xs">{m.note ?? '—'}</Td>
                  <Td className="text-xs">{m.created_by_name ?? '—'}</Td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <Empty title="No movements recorded" />
        )}
      </Card>

      <Dialog
        open={Boolean(receiving)}
        onClose={() => setReceiving(null)}
        title="Record a stock movement"
        description={`${receiving?.item ?? ''} at ${receiving ? siteName(receiving.site_id) : ''}`}
        footer={
          <>
            <Button onClick={() => setReceiving(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={record}>Save</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="delivery">Delivery received</option>
              <option value="usage">Issued to a device</option>
              <option value="adjustment">Stock take adjustment</option>
            </Select>
          </Field>
          <Field label={`Amount (${receiving?.unit ?? 'L'})`} hint="Always a positive number; the type decides the direction">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="200" />
          </Field>
          <Field label="Note">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="PO 4471, delivered to the store" />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: 'crit' }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-2">{k}</dt>
      <dd className={`font-mono tabular ${tone === 'crit' ? 'font-medium text-crit' : 'text-ink'}`}>{v}</dd>
    </div>
  );
}
