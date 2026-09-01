import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";
import { Field, FinanceNav, StatusPill } from "@/components/erp";
import { MoneyField } from "@/components/fields";
import { SearchSelect, asOpts } from "@/components/search-select";
import { addExpenseCategory, createExpense, listExpenses } from "@/lib/erp/expenses";
import { exportCsv } from "@/lib/export-csv";
import { cn, money, todayMx } from "@/lib/utils";

export const Route = createFileRoute("/gastos")({
  component: Page,
});

const CLASSES = [
  { id: "operativo", label: "Operativo" },
  { id: "pedido", label: "Sobre pedido" },
  { id: "financiero", label: "Financiero" },
] as const;
type Cls = (typeof CLASSES)[number]["id"];

function classLabel(c: string) {
  if (c === "pedido") return "Sobre pedido";
  if (c === "financiero") return "Financiero";
  return "Operativo";
}

function Page() {
  const [data, setData] = useState<Awaited<ReturnType<typeof listExpenses>> | null>(null);
  const [cls, setCls] = useState<Cls>("operativo");
  const [categoryId, setCategoryId] = useState("");
  const [date, setDate] = useState(todayMx);
  const [amount, setAmount] = useState(0);
  const [partnerId, setPartnerId] = useState("");
  const [soId, setSoId] = useState("");
  const [poId, setPoId] = useState("");
  const [payKind, setPayKind] = useState<"cash" | "credit">("cash");
  const [bankId, setBankId] = useState("");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const d = await listExpenses();
    setData(d);
    setBankId((id) => id || String(d.banks[0]?.id ?? ""));
  }
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, []);

  const cats = useMemo(() => (data?.categories ?? []).filter((c) => c.class === cls), [data, cls]);

  useEffect(() => {
    if (!cats.some((c) => String(c.id) === categoryId)) setCategoryId(cats[0] ? String(cats[0].id) : "");
  }, [cls, cats, categoryId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!amount) {
      setError("Captura el importe");
      return;
    }
    if (!categoryId) {
      setError("Elige o agrega una categoría");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await createExpense({
        data: {
          date,
          class: cls,
          categoryId: Number(categoryId),
          amount,
          partnerId: Number(partnerId) || undefined,
          soId: Number(soId) || undefined,
          poId: Number(poId) || undefined,
          payKind,
          bankId: payKind === "cash" ? Number(bankId) || undefined : undefined,
          invoiceRef,
          notes,
        },
      });
      setAmount(0);
      setNotes("");
      setInvoiceRef("");
      setSoId("");
      setPoId("");
      await load();
      setError(null);
      setNotes(`Registrado ${r.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo registrar");
    } finally {
      setBusy(false);
    }
  }

  const kpis = useMemo(() => {
    const rows = data?.expenses ?? [];
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    const op = rows.filter((r) => r.class === "operativo").reduce((s, r) => s + Number(r.amount), 0);
    const ped = rows.filter((r) => r.class === "pedido").reduce((s, r) => s + Number(r.amount), 0);
    const fin = rows.filter((r) => r.class === "financiero").reduce((s, r) => s + Number(r.amount), 0);
    return { total, op, ped, fin };
  }, [data]);

  return (
    <AppShell>
      <FinanceNav current="gastos" />
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Gastos</h1>
        <p className="text-sm text-muted">
          Operativos (gasolina, oficina, sueldos), sobre un pedido concreto, o financieros. El catálogo se busca; si falta, se agrega.
        </p>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <Kpi label="Total" value={money(kpis.total)} />
        <Kpi label="Operativo" value={money(kpis.op)} />
        <Kpi label="Sobre pedido" value={money(kpis.ped)} />
        <Kpi label="Financiero" value={money(kpis.fin)} />
      </div>

      <form onSubmit={submit} className="mb-5 erp-card p-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Clase</p>
          <div className="mb-4 flex flex-wrap gap-1">
            {CLASSES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={cn(
                  "h-8 rounded-md px-3 text-[12px] font-semibold",
                  cls === c.id ? "bg-brand text-white" : "border border-line bg-cream text-ink-soft hover:bg-paper",
                )}
                onClick={() => setCls(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Categoría">
              <SearchSelect
                value={categoryId}
                options={asOpts(cats, (c) => c.id, (c) => c.name)}
                onChange={setCategoryId}
                placeholder="Buscar o agregar…"
                onCreate={async (name) => {
                  const r = await addExpenseCategory({ data: { name, class: cls } });
                  await load();
                  setCategoryId(String(r.id));
                }}
              />
            </Field>
            <Field label="Fecha">
              <input className="erp-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Importe">
              <MoneyField className="w-full" value={amount} onChange={setAmount} />
            </Field>
            <Field label="Proveedor / tercero">
              <SearchSelect
                value={partnerId}
                options={asOpts(data?.partners, (p) => p.id, (p) => p.name, (p) => (p.is_supplier ? "proveedor" : p.is_customer ? "cliente" : undefined))}
                onChange={setPartnerId}
                allowEmpty
                emptyLabel="Sin tercero (ej. sueldos)"
                placeholder="Buscar…"
              />
            </Field>
            {cls === "pedido" && (
              <>
                <Field label="Pedido de venta">
                  <SearchSelect
                    value={soId}
                    options={asOpts(data?.sales, (s) => s.id, (s) => s.name, (s) => s.partner)}
                    onChange={(v) => {
                      setSoId(v);
                      if (v) setPoId("");
                    }}
                    allowEmpty
                    emptyLabel="—"
                    placeholder="Buscar PV…"
                  />
                </Field>
                <Field label="Pedido de compra">
                  <SearchSelect
                    value={poId}
                    options={asOpts(data?.purchases, (p) => p.id, (p) => p.name, (p) => p.partner)}
                    onChange={(v) => {
                      setPoId(v);
                      if (v) setSoId("");
                    }}
                    allowEmpty
                    emptyLabel="—"
                    placeholder="Buscar OC…"
                  />
                </Field>
              </>
            )}
            <Field label="Forma de pago">
              <div className="flex gap-1">
                <button type="button" className={cn("h-9 flex-1 rounded-md text-[12px] font-semibold", payKind === "cash" ? "bg-brand text-white" : "border border-line")} onClick={() => setPayKind("cash")}>
                  Contado
                </button>
                <button type="button" className={cn("h-9 flex-1 rounded-md text-[12px] font-semibold", payKind === "credit" ? "bg-brand text-white" : "border border-line")} onClick={() => setPayKind("credit")}>
                  Crédito
                </button>
              </div>
            </Field>
            {payKind === "cash" && (
              <Field label="Sale de la cuenta">
                <SearchSelect
                  value={bankId}
                  options={asOpts(data?.banks, (b) => b.id, (b) => b.name, (b) => b.currency)}
                  onChange={setBankId}
                  placeholder="Cuenta…"
                />
              </Field>
            )}
            <Field label="Factura / ref">
              <input className="erp-input" value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} />
            </Field>
            <Field label="Nota" className="md:col-span-2">
              <input className="erp-input" value={notes.startsWith("Registrado") ? "" : notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
            </Field>
          </div>
          <div className="mt-4 flex justify-end">
            <button className="erp-btn-primary" disabled={busy}>
              Registrar gasto
            </button>
          </div>
        </form>

      {!data?.expenses.length ? (
        <div className="erp-card px-6 py-14 text-center">
          <p className="font-medium">Aún no hay gastos</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">Gasolina, oficina, sueldos, flete de un pedido, intereses. Cada uno con su categoría y, si aplica, el pedido al que pertenece.</p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              className="erp-btn"
              onClick={() =>
                exportCsv(
                  "gastos-azagro",
                  ["Folio", "Fecha", "Clase", "Categoría", "Tercero", "Pedido", "Pago", "Importe"],
                  data.expenses.map((e) => [e.name, e.date, classLabel(e.class), e.category ?? "", e.partner ?? "", e.so_name || e.po_name || "", e.pay_kind === "cash" ? "Contado" : "Crédito", e.amount]),
                )
              }
            >
              Exportar Excel
            </button>
          </div>
          <div className="overflow-x-auto erp-card">
            <table className="w-full min-w-[800px] text-left text-[13px]">
              <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Folio</th>
                  <th className="px-3 py-3 font-medium">Fecha</th>
                  <th className="px-3 py-3 font-medium">Clase</th>
                  <th className="px-3 py-3 font-medium">Categoría</th>
                  <th className="px-3 py-3 font-medium">Tercero</th>
                  <th className="px-3 py-3 font-medium">Pedido</th>
                  <th className="px-3 py-3 text-right font-medium">Importe</th>
                </tr>
              </thead>
              <tbody>
                {data.expenses.map((e) => (
                  <tr key={e.id} className="border-t border-line">
                    <td className="px-4 py-3 font-medium">{e.name}</td>
                    <td className="px-3 py-3 tabular-nums">{e.date}</td>
                    <td className="px-3 py-3">
                      <StatusPill tone={e.class === "financiero" ? "warn" : e.class === "pedido" ? "ok" : "muted"}>{classLabel(e.class)}</StatusPill>
                    </td>
                    <td className="px-3 py-3">{e.category ?? "—"}</td>
                    <td className="px-3 py-3">{e.partner ?? "—"}</td>
                    <td className="px-3 py-3 text-muted">{e.so_name || e.po_name || "—"}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AppShell>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <article className="erp-card p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </article>
  );
}
