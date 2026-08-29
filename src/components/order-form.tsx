import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { DestinoForm } from "@/components/destino-form";
import { HeadBox, Field } from "@/components/erp";
import { MoneyField, QtyField, UomSelect } from "@/components/fields";
import { SearchSelect, asOpts } from "@/components/search-select";
import { computeDues, type TermKind } from "@/lib/erp/order-terms";
import { validateDueDates } from "@/lib/erp/credit";
import { cn, fmtDate, moneyIn, num } from "@/lib/utils";

export type RouteKind = "own" | "supplier" | "asr";
export type PriceMode = "cash" | "financed" | "custom";

export type OrderLine = { productId: number; qty: number; unitPrice: number; uom: string };

export type OrderDraft = {
  name: string;
  partnerId: number;
  date: string;
  ocCliente: string;
  termKind: TermKind;
  invoiceDays: number;
  creditDays: number;
  invoiceDue: string;
  creditDue: string;
  currency: "MXN" | "USD";
  fxRate: number;
  routeKind: RouteKind;
  asrPartnerId: number | null;
  locationId: number;
  policyCode: string;
  priceMode: PriceMode;
  deliveryTo: string;
  notes: string;
  lines: OrderLine[];
};

export type OrderLookups = {
  customers: Array<{ id: number; code: string; name: string; group_name: string; payment_days: number; credit_limit: string }>;
  asr: Array<{ id: number; name: string }>;
  products: Array<{ id: number; code: string; name: string; uom: string; list_price: string; product_type: string }>;
  locations: Array<{ id: number; name: string; loc_type: string }>;
  policies: Array<{ code: string; name: string }>;
  fxRate: number;
  nextName: string;
};

const TERMS: Array<{ id: TermKind; label: string }> = [
  { id: "contado", label: "Contado" },
  { id: "credit_days", label: "Crédito" },
  { id: "date", label: "Fecha" },
  { id: "harvest", label: "Cosecha" },
];

const ROUTES: Array<{ id: RouteKind; label: string }> = [
  { id: "own", label: "Bodega Azagro" },
  { id: "supplier", label: "Entrega proveedor" },
  { id: "asr", label: "Circuito ASR" },
];

export function applyPartnerDefaults(form: OrderDraft, partner: OrderLookups["customers"][number]): OrderDraft {
  const days = partner.payment_days ?? 0;
  if (days === 0) {
    return {
      ...form,
      partnerId: partner.id,
      termKind: "contado",
      invoiceDays: 0,
      creditDays: 0,
      invoiceDue: form.date,
      creditDue: form.date,
      priceMode: "cash",
      policyCode: partner.group_name === "Grupo SL" ? "GRUPO_SL" : form.policyCode,
    };
  }
  return {
    ...form,
    partnerId: partner.id,
    termKind: "credit_days",
    invoiceDays: days,
    creditDays: days,
    priceMode: "financed",
    policyCode: partner.group_name === "Grupo SL" ? "GRUPO_SL" : form.policyCode,
  };
}

export function duesPreview(form: OrderDraft) {
  try {
    return computeDues({
      date: form.date,
      termKind: form.termKind,
      invoiceDays: form.invoiceDays,
      creditDays: form.creditDays,
      invoiceDue: form.invoiceDue,
      creditDue: form.creditDue,
    });
  } catch {
    return null;
  }
}

function ChipRow<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ id: T; label: string }>;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={disabled}
          className={cn(
            "h-8 rounded-md px-2.5 text-[12px] font-semibold",
            value === o.id ? "bg-brand text-white" : "border border-line bg-cream text-ink-soft hover:bg-paper",
            disabled && "opacity-70",
          )}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function OrderFields({
  form,
  setForm,
  lookups,
  locked,
}: {
  form: OrderDraft;
  setForm: (f: OrderDraft) => void;
  lookups: OrderLookups;
  locked?: boolean;
}) {
  const partner = lookups.customers.find((c) => c.id === form.partnerId);
  const preview = duesPreview(form);
  const [addDest, setAddDest] = useState(false);
  const [extraDest, setExtraDest] = useState<Array<{ id: number; name: string; loc_type: string }>>([]);
  const total = form.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const units = form.lines.reduce((s, l) => s + l.qty, 0);
  const locOptions = lookups.locations.filter((l) => {
    if (form.routeKind === "supplier") return l.loc_type === "supplier" || l.loc_type === "internal";
    return true;
  });

  function setLine(i: number, patch: Partial<OrderLine>) {
    setForm({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  }

  function addLine() {
    const p = lookups.products[0];
    setForm({
      ...form,
      lines: [...form.lines, { productId: p?.id ?? 0, qty: 1, unitPrice: num(p?.list_price), uom: p?.uom ?? "TM" }],
    });
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 lg:grid-cols-5">
        <HeadBox
          label="Cliente"
          action={
            <Link to="/partners/nuevo" search={{ tipo: "cliente", tab: "clientes", q: "" }} className="text-[11px] font-semibold text-accent">
              Alta
            </Link>
          }
        >
          <SearchSelect
            bare
            disabled={locked}
            value={form.partnerId ? String(form.partnerId) : ""}
            options={asOpts(lookups.customers, (c) => c.id, (c) => c.name, (c) => c.group_name)}
            placeholder="Buscar cliente…"
            onChange={(v) => {
              const p = lookups.customers.find((c) => c.id === Number(v));
              if (p) setForm(applyPartnerDefaults(form, p));
            }}
          />
        </HeadBox>
        <HeadBox label="Tipo de entrega">
          <select
            className="erp-input w-full border-0 bg-transparent px-0"
            disabled={locked}
            value={form.routeKind}
            onChange={(e) => setForm({ ...form, routeKind: e.target.value as RouteKind })}
          >
            {ROUTES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </HeadBox>
        <HeadBox label="Fecha">
          <input
            className="erp-input w-full border-0 bg-transparent px-0"
            type="date"
            value={form.date}
            disabled={locked}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
        </HeadBox>
        <HeadBox label="Folio">
          <input
            className="erp-input w-full border-0 bg-transparent px-0 font-mono"
            value={form.name}
            disabled={locked}
            onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })}
          />
        </HeadBox>
        <HeadBox label="Total">
          <p className="text-xl font-semibold tabular-nums">{moneyIn(total, form.currency)}</p>
          <p className="text-[11px] text-muted">
            {form.lines.length} partidas · {units} uds
          </p>
        </HeadBox>
      </div>

      <div className="erp-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Plazo de este pedido</p>
            <ChipRow
              value={form.termKind}
              disabled={locked}
              onChange={(termKind) => {
                if (termKind === "contado") {
                  setForm({
                    ...form,
                    termKind,
                    invoiceDays: 0,
                    creditDays: 0,
                    invoiceDue: form.date,
                    creditDue: form.date,
                    priceMode: "cash",
                  });
                } else if (termKind === "credit_days") {
                  const days = form.invoiceDays || partner?.payment_days || 30;
                  setForm({ ...form, termKind, invoiceDays: days, creditDays: form.creditDays || days, priceMode: "financed" });
                } else {
                  setForm({ ...form, termKind, priceMode: "financed" });
                }
              }}
              options={TERMS}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              className="erp-input w-36"
              disabled={locked}
              placeholder="OC cliente"
              value={form.ocCliente}
              onChange={(e) => setForm({ ...form, ocCliente: e.target.value })}
            />
            <select
              className="erp-input w-24"
              disabled={locked}
              value={form.currency}
              onChange={(e) => {
                const currency = e.target.value as "MXN" | "USD";
                setForm({ ...form, currency, fxRate: currency === "MXN" ? 1 : form.fxRate || lookups.fxRate });
              }}
            >
              <option value="USD">USD</option>
              <option value="MXN">MXN</option>
            </select>
            {form.currency === "USD" ? (
            <input
              className="erp-input w-24"
              type="number"
              step="0.0001"
              disabled={locked}
              value={form.fxRate}
              onChange={(e) => setForm({ ...form, fxRate: Number(e.target.value) })}
              title="Dólar pactado"
            />
            ) : null}
          </div>
        </div>

        {form.termKind === "credit_days" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Días factura (exactos)">
              <input
                className="erp-input"
                type="number"
                min={0}
                disabled={locked}
                value={form.invoiceDays}
                onChange={(e) => setForm({ ...form, invoiceDays: Number(e.target.value) })}
              />
            </Field>
            <Field label="Días crédito / mora (exactos)">
              <input
                className="erp-input"
                type="number"
                min={0}
                disabled={locked}
                value={form.creditDays}
                onChange={(e) => setForm({ ...form, creditDays: Number(e.target.value) })}
              />
            </Field>
          </div>
        )}
        {(form.termKind === "date" || form.termKind === "harvest") && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Vence factura">
              <input className="erp-input" type="date" disabled={locked} value={form.invoiceDue} onChange={(e) => setForm({ ...form, invoiceDue: e.target.value })} />
            </Field>
            <Field label={form.termKind === "harvest" ? "Fecha cosecha / mora" : "Vence crédito"}>
              <input className="erp-input" type="date" disabled={locked} value={form.creditDue} onChange={(e) => setForm({ ...form, creditDue: e.target.value })} />
            </Field>
          </div>
        )}

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Política de mora">
            <select className="erp-input" disabled={locked} value={form.policyCode} onChange={(e) => setForm({ ...form, policyCode: e.target.value })}>
              {lookups.policies.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Despachar desde">
            <SearchSelect
              disabled={locked}
              value={form.locationId ? String(form.locationId) : ""}
              options={asOpts(locOptions, (l) => l.id, (l) => l.name, (l) => (l.loc_type === "supplier" ? "proveedor" : undefined))}
              onChange={(v) => setForm({ ...form, locationId: Number(v) })}
              placeholder="Buscar bodega…"
            />
          </Field>
          {form.routeKind === "asr" && (
            <Field label="Contraparte ASR">
              <SearchSelect
                disabled={locked}
                value={form.asrPartnerId ? String(form.asrPartnerId) : ""}
                options={asOpts(lookups.asr, (a) => a.id, (a) => a.name)}
                onChange={(v) => setForm({ ...form, asrPartnerId: Number(v) || null })}
                placeholder="Buscar ASR…"
              />
            </Field>
          )}
          <Field label="Entregar en">
            <SearchSelect
              disabled={locked}
              value={form.deliveryTo}
              options={asOpts(
                [
                  ...lookups.locations.filter((l) => l.loc_type === "customer"),
                  ...extraDest,
                ],
                (l) => l.name,
                (l) => l.name,
              )}
              onChange={(v) => setForm({ ...form, deliveryTo: v })}
              placeholder="Punto de entrega…"
              allowEmpty
              emptyLabel="—"
              onCreate={(name) => {
                setAddDest(true);
                setForm({ ...form, deliveryTo: name });
              }}
            />
            {!locked && (
              <div className="mt-1 flex gap-3 text-[12px]">
                <button type="button" className="font-medium text-accent hover:underline" onClick={() => setAddDest(true)}>
                  + Nuevo destino
                </button>
                <Link to="/bodegas" search={{ tab: "destinos" }} className="text-muted hover:underline">
                  Catálogo
                </Link>
              </div>
            )}
          </Field>
        </div>
        {addDest && !locked && (
          <DestinoForm
            customers={lookups.customers}
            defaultPartnerId={form.partnerId || undefined}
            initialName={form.deliveryTo}
            onCancel={() => setAddDest(false)}
            onSaved={(row) => {
              setExtraDest((x) => [...x, { id: row.id, name: row.name, loc_type: "customer" }]);
              setForm({ ...form, deliveryTo: row.name });
              setAddDest(false);
            }}
          />
        )}

        {preview && (
          <div className="mt-3">
            <p className="text-[12px] text-muted">
              Factura vence <strong className="text-ink">{fmtDate(preview.invoiceDue)}</strong>
              {preview.invoiceDays ? ` · ${preview.invoiceDays} d` : " · contado"}
              {" · "}
              Mora desde <strong className="text-ink">{fmtDate(preview.creditDue)}</strong>
              {form.invoiceDays !== form.creditDays && form.termKind === "credit_days" ? ` (${form.invoiceDays}/${form.creditDays} d)` : ""}
            </p>
            {(() => {
              const chk = validateDueDates({
                issue: form.date,
                due: preview.creditDue,
                invoiceDue: preview.invoiceDue,
                days: form.termKind === "credit_days" ? preview.creditDays : undefined,
                allowPast: true,
              });
              return (
                <>
                  {chk.errors.map((e) => (
                    <p key={e} className="mt-1 text-[12px] text-danger">{e}</p>
                  ))}
                  {chk.warnings.map((e) => (
                    <p key={e} className="mt-1 text-[12px] text-warn">{e}</p>
                  ))}
                </>
              );
            })()}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!locked && (
          <button type="button" className="erp-btn-primary" onClick={addLine}>
            <Plus className="mr-1 inline size-3.5" />
            Agregar partida
          </button>
        )}
      </div>

      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2.5 font-medium">Producto</th>
              <th className="px-3 py-2.5 font-medium">UoM</th>
              <th className="px-3 py-2.5 text-right font-medium">Cant.</th>
              <th className="px-3 py-2.5 text-right font-medium">Precio / UoM</th>
              <th className="px-3 py-2.5 text-right font-medium">Importe</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {form.lines.map((line, i) => {
              const p = lookups.products.find((x) => x.id === line.productId);
              return (
                <tr key={i} className="border-t border-line">
                  <td className="px-3 py-2">
                    <SearchSelect
                      disabled={locked}
                      value={line.productId ? String(line.productId) : ""}
                      options={asOpts(lookups.products, (prod) => prod.id, (prod) => `${prod.code} — ${prod.name}`)}
                      placeholder="Buscar producto…"
                      onChange={(v) => {
                        const id = Number(v);
                        const prod = lookups.products.find((x) => x.id === id);
                        setLine(i, { productId: id, uom: prod?.uom ?? line.uom, unitPrice: num(prod?.list_price) || line.unitPrice });
                      }}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <UomSelect disabled={locked} value={line.uom || p?.uom || "TM"} extra={p?.uom} onChange={(uom) => setLine(i, { uom })} />
                  </td>
                  <td className="px-3 py-2">
                    <QtyField disabled={locked} value={line.qty} onChange={(qty) => setLine(i, { qty })} />
                  </td>
                  <td className="px-3 py-2">
                    <MoneyField disabled={locked} value={line.unitPrice} onChange={(unitPrice) => setLine(i, { unitPrice })} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{moneyIn(line.qty * line.unitPrice, form.currency)}</td>
                  <td className="px-2 py-2">
                    {!locked && form.lines.length > 1 && (
                      <button type="button" className="grid size-8 place-items-center text-muted hover:text-danger" onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })}>
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="erp-card flex flex-wrap items-end justify-between gap-3 p-3">
        <Field label="Nota al pedido" className="min-w-[240px] flex-1">
          <textarea className="erp-input h-16 py-2" disabled={locked} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        <div className="text-right">
          <p className="text-[12px] text-muted">
            {form.lines.length} partidas · {units} uds
          </p>
          <p className="text-lg font-semibold tabular-nums">{moneyIn(total, form.currency)}</p>
        </div>
      </div>
    </div>
  );
}

export function termLabel(kind: string, invoiceDays: number, creditDays: number) {
  if (kind === "contado") return "Contado";
  if (kind === "harvest") return "Cosecha";
  if (kind === "date") return "Fecha fija";
  if (invoiceDays === creditDays) return `${invoiceDays} días`;
  return `${invoiceDays} / ${creditDays} d`;
}

export function stateLabel(state: string) {
  if (state === "draft") return "Borrador";
  if (state === "confirmed") return "Confirmado";
  if (state === "done") return "Entregado";
  return state;
}

export function routeLabel(kind: string) {
  if (kind === "asr") return "ASR";
  if (kind === "supplier") return "Proveedor";
  return "Directo";
}
