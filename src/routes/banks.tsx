import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";
import { Field, FinanceNav, StatusPill } from "@/components/erp";
import { MoneyField } from "@/components/fields";
import { SearchSelect, asOpts } from "@/components/search-select";
import { addBankMove, listBanks, reconcileMove, saveBankOpening } from "@/lib/erp/ops";
import { exportCsv } from "@/lib/export-csv";
import { cn, money, todayISO } from "@/lib/utils";

export const Route = createFileRoute("/banks")({ component: Page });

const KINDS = [
  { id: "cobro", label: "Cobro" },
  { id: "pago", label: "Pago" },
  { id: "transferencia", label: "Transferencia" },
  { id: "ajuste", label: "Ajuste" },
] as const;

type Kind = (typeof KINDS)[number]["id"];

function kindTone(k: string) {
  if (k === "cobro") return "ok" as const;
  if (k === "pago" || k === "gasto") return "danger" as const;
  return "muted" as const;
}

function kindLabel(k: string) {
  if (k === "cobro") return "Cobro";
  if (k === "pago") return "Pago";
  if (k === "gasto") return "Gasto";
  if (k === "transferencia") return "Transferencia";
  return "Ajuste";
}

function Page() {
  const [data, setData] = useState<Awaited<ReturnType<typeof listBanks>> | null>(null);
  const [kind, setKind] = useState<Kind>("cobro");
  const [bankId, setBankId] = useState("");
  const [bankToId, setBankToId] = useState("");
  const [date, setDate] = useState(todayISO);
  const [amount, setAmount] = useState(0);
  const [memo, setMemo] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [soId, setSoId] = useState("");
  const [fxPaid, setFxPaid] = useState(0);
  const [fxTreatment, setFxTreatment] = useState<"utilidad" | "ajuste">("utilidad");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const d = await listBanks();
    setData(d);
    setBankId((id) => id || String(d.banks[0]?.id ?? ""));
  }
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, []);

  const partners = useMemo(() => {
    const rows = data?.partners ?? [];
    if (kind === "cobro") return rows.filter((p) => p.is_customer);
    if (kind === "pago") return rows.filter((p) => p.is_supplier);
    return rows;
  }, [data, kind]);

  const invoices = useMemo(() => {
    const pid = Number(partnerId) || 0;
    return (data?.invoices ?? []).filter((i) => {
      if (pid && i.partner_id !== pid) return false;
      if (kind === "cobro") return i.kind === "customer";
      if (kind === "pago") return i.kind === "supplier";
      return true;
    });
  }, [data, partnerId, kind]);

  const sales = useMemo(() => {
    const pid = Number(partnerId) || 0;
    return (data?.sales ?? []).filter((s) => !pid || s.partner_id === pid);
  }, [data, partnerId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!amount) {
      setError("Captura el importe");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await addBankMove({
        data: {
          bankId: Number(bankId),
          date,
          amount,
          kind,
          memo,
          partnerId: Number(partnerId) || undefined,
          invoiceId: Number(invoiceId) || undefined,
          soId: Number(soId) || undefined,
          bankToId: Number(bankToId) || undefined,
          fxPaid: fxPaid || undefined,
          fxTreatment: fxPaid ? fxTreatment : undefined,
        },
      });
      setAmount(0);
      setMemo("");
      setInvoiceId("");
      setSoId("");
      setFxPaid(0);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo registrar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <FinanceNav current="banks" />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Bancos</h1>
          <p className="text-sm text-muted">Cobros, pagos y transferencias. Los gastos operativos van en Gastos y aquí se reflejan si salieron de la cuenta.</p>
        </div>
        <Link to="/gastos" className="erp-btn">
          Ir a gastos
        </Link>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {data?.banks.map((b) => (
          <article key={b.id} className="erp-card p-4">
            <p className="text-[11px] uppercase tracking-wide text-muted">{b.currency}</p>
            <p className="font-semibold">{b.name}</p>
            <p className="mt-2 text-lg tabular-nums">{money(Number(b.opening) + Number(b.movement))}</p>
            <p className="text-xs text-muted">{b.account || "Sin CLABE capturada"}</p>
            <label className="mt-2 grid gap-1 text-[11px] uppercase tracking-wide text-muted">
              Saldo inicial
              <input
                className="erp-input h-8"
                type="number"
                step="0.01"
                defaultValue={Number(b.opening)}
                onBlur={async (e) => {
                  const opening = Number(e.target.value);
                  if (Number.isNaN(opening) || opening === Number(b.opening)) return;
                  try {
                    await saveBankOpening({ data: { bankId: b.id, opening } });
                    await load();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "No se pudo guardar el saldo");
                  }
                }}
              />
            </label>
          </article>
        ))}
      </div>

      <form onSubmit={submit} className="mb-5 erp-card p-4">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Tipo de movimiento</p>
        <div className="mb-4 flex flex-wrap gap-1">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={cn(
                "h-8 rounded-md px-3 text-[12px] font-semibold",
                kind === k.id ? "bg-brand text-white" : "border border-line bg-cream text-ink-soft hover:bg-paper",
              )}
              onClick={() => {
                setKind(k.id);
                setPartnerId("");
                setInvoiceId("");
                setSoId("");
              }}
            >
              {k.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Cuenta">
            <SearchSelect
              value={bankId}
              options={asOpts(data?.banks, (b) => b.id, (b) => b.name, (b) => b.currency)}
              onChange={setBankId}
              placeholder="Buscar cuenta…"
            />
          </Field>
          <Field label="Fecha">
            <input className="erp-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={kind === "cobro" ? "Importe que entra" : kind === "pago" ? "Importe que sale" : "Importe"}>
            <MoneyField className="w-full" value={amount} onChange={setAmount} />
          </Field>
          {kind === "transferencia" ? (
            <Field label="Cuenta destino">
              <SearchSelect
                value={bankToId}
                options={asOpts(
                  data?.banks.filter((b) => String(b.id) !== bankId),
                  (b) => b.id,
                  (b) => b.name,
                )}
                onChange={setBankToId}
                placeholder="Destino…"
              />
            </Field>
          ) : (
            <Field label={kind === "cobro" ? "Cliente" : kind === "pago" ? "Proveedor" : "Contraparte"}>
              <SearchSelect
                value={partnerId}
                options={asOpts(partners, (p) => p.id, (p) => p.name)}
                onChange={(v) => {
                  setPartnerId(v);
                  setInvoiceId("");
                  setSoId("");
                }}
                allowEmpty
                emptyLabel="Sin contraparte"
                placeholder="Buscar…"
              />
            </Field>
          )}
          {kind !== "transferencia" && (
            <Field label="Aplicar a factura">
              <SearchSelect
                value={invoiceId}
                options={asOpts(invoices, (i) => i.id, (i) => i.name, (i) => `saldo ${money(Number(i.residual))}`)}
                onChange={setInvoiceId}
                allowEmpty
                emptyLabel="Sin aplicar"
                placeholder="Buscar factura…"
              />
            </Field>
          )}
          {invoices.find((i) => String(i.id) === invoiceId)?.currency === "USD" && (
            <>
              <Field label="TC del pago (factura en dólares)">
                <input
                  className="erp-input"
                  type="number"
                  min={0.0001}
                  step="0.0001"
                  value={fxPaid || ""}
                  onChange={(e) => setFxPaid(Number(e.target.value))}
                  placeholder="p. ej. 18.60"
                />
              </Field>
              <Field label="Diferencial contra el pactado">
                <select className="erp-input" value={fxTreatment} onChange={(e) => setFxTreatment(e.target.value as "utilidad" | "ajuste")}>
                  <option value="utilidad">Dejarlo como utilidad/pérdida</option>
                  <option value="ajuste">Ajustar al pactado (por cobrar / devolver)</option>
                </select>
              </Field>
            </>
          )}
          {kind === "cobro" && (
            <Field label="Pedido relacionado">
              <SearchSelect
                value={soId}
                options={asOpts(sales, (s) => s.id, (s) => s.name)}
                onChange={setSoId}
                allowEmpty
                emptyLabel="Sin pedido"
                placeholder="Buscar pedido…"
              />
            </Field>
          )}
          <Field label="Concepto" className="md:col-span-2">
            <input className="erp-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Referencia, depósito, SPEI…" />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button className="erp-btn-primary" disabled={busy}>
            Registrar {kindLabel(kind).toLowerCase()}
          </button>
        </div>
      </form>

      {!data?.moves.length ? (
        <div className="erp-card px-6 py-14 text-center">
          <p className="font-medium">Sin movimientos en cuenta</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            Un cobro entra, un pago sale. Si es gasolina, flete o nómina, regístralo en Gastos — aquí solo se ve el dinero de la cuenta.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              className="erp-btn"
              onClick={() =>
                exportCsv(
                  "bancos-azagro",
                  ["Fecha", "Tipo", "Banco", "Contraparte", "Concepto", "Importe", "Conciliación"],
                  data.moves.map((m) => [m.date, kindLabel(m.kind), m.bank, m.partner ?? "", m.memo, m.amount, m.reconciled ? "Sí" : "No"]),
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
                  <th className="px-4 py-3 font-medium">Fecha</th>
                  <th className="px-3 py-3 font-medium">Tipo</th>
                  <th className="px-3 py-3 font-medium">Banco</th>
                  <th className="px-3 py-3 font-medium">Contraparte</th>
                  <th className="px-3 py-3 font-medium">Concepto</th>
                  <th className="px-3 py-3 text-right font-medium">Importe</th>
                  <th className="px-4 py-3 font-medium">Conciliación</th>
                </tr>
              </thead>
              <tbody>
                {data.moves.map((m) => (
                  <tr key={m.id} className="border-t border-line">
                    <td className="px-4 py-3 tabular-nums">{m.date}</td>
                    <td className="px-3 py-3">
                      <StatusPill tone={kindTone(m.kind)}>{kindLabel(m.kind)}</StatusPill>
                    </td>
                    <td className="px-3 py-3">{m.bank}</td>
                    <td className="px-3 py-3">
                      {m.partner ?? "—"}
                      {m.invoice || m.so_name || m.po_name ? (
                        <p className="text-[11px] text-muted">{m.invoice || m.so_name || m.po_name}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-muted">{m.memo || "—"}</td>
                    <td className={cn("px-3 py-3 text-right tabular-nums", Number(m.amount) < 0 ? "text-danger" : "text-ok")}>
                      {money(m.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="text-[13px] font-semibold text-forest"
                        onClick={() => reconcileMove({ data: { moveId: m.id } }).then(load)}
                      >
                        {m.reconciled ? "Conciliado" : "Marcar"}
                      </button>
                    </td>
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
