import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";
import { HeadBox, StatusPill } from "@/components/erp";
import { MoneyField, QtyField, UomSelect } from "@/components/fields";
import { SearchSelect, asOpts } from "@/components/search-select";
import { convertCustomerPO, createCustomerPO, listCustomerPOs } from "@/lib/erp/cpo";
import { listInventory } from "@/lib/azagro";
import { exportCsv } from "@/lib/export-csv";
import { money, num, todayISO } from "@/lib/utils";

export const Route = createFileRoute("/cpo")({ component: Page });

type Line = { productId: number; qty: number; unitPrice: number; uom: string };

function Page() {
  const [data, setData] = useState<Awaited<ReturnType<typeof listCustomerPOs>> | null>(null);
  const [locs, setLocs] = useState<Array<{ id: number }>>([]);
  const [partnerId, setPartnerId] = useState(0);
  const [customerPo, setCustomerPo] = useState("");
  const [poDate, setPoDate] = useState(todayISO);
  const [currency, setCurrency] = useState<"USD" | "MXN">("USD");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const d = await listCustomerPOs();
    setData(d);
    setPartnerId((p) => p || d.customers[0]?.id || 0);
    const inv = await listInventory();
    setLocs(inv.locations.filter((l) => l.loc_type === "internal" || l.loc_type === "supplier"));
    if (lines.length === 0 && d.products[0]) {
      const p = d.products[0];
      setLines([{ productId: p.id, qty: 1, unitPrice: Number(p.list_price), uom: p.uom || "TM" }]);
    }
  }
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!customerPo.trim()) {
      setError("Captura el número de OC del cliente");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createCustomerPO({
        data: {
          partnerId,
          customerPoNumber: customerPo.trim(),
          poDate,
          currency,
          notes,
          lines: lines.filter((l) => l.productId && l.qty > 0),
        },
      });
      setCustomerPo("");
      setNotes("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  }

  const total = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);

  return (
    <AppShell>
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">OC del cliente</h1>
          <p className="text-sm text-muted">La orden que nos mandan. Se relaciona al pedido de venta de Azagro.</p>
        </div>
        <button
          type="button"
          className="erp-btn"
          onClick={() =>
            exportCsv(
              "oc-cliente-azagro",
              ["Folio", "OC cliente", "Cliente", "Fecha", "Estado", "Pedido", "Total"],
              (data?.pos ?? []).map((p) => [p.name, p.customer_po_number, p.partner, p.po_date, p.status, p.so_name ?? "", p.total]),
            )
          }
        >
          Exportar Excel
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      <form onSubmit={submit} className="mb-6">
        <div className="grid gap-3 lg:grid-cols-5">
          <HeadBox label="Cliente">
            <SearchSelect
              bare
              value={partnerId ? String(partnerId) : ""}
              options={asOpts(data?.customers, (c) => c.id, (c) => c.name)}
              onChange={(v) => setPartnerId(Number(v))}
              placeholder="Buscar cliente…"
            />
          </HeadBox>
          <HeadBox label="OC del cliente">
            <input className="erp-input w-full border-0 bg-transparent px-0" value={customerPo} onChange={(e) => setCustomerPo(e.target.value)} placeholder="Número de su orden" />
          </HeadBox>
          <HeadBox label="Fecha">
            <input className="erp-input w-full border-0 bg-transparent px-0" type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} />
          </HeadBox>
          <HeadBox label="Moneda">
            <select className="erp-input w-full border-0 bg-transparent px-0" value={currency} onChange={(e) => setCurrency(e.target.value as "USD" | "MXN")}>
              <option value="USD">USD</option>
              <option value="MXN">MXN</option>
            </select>
          </HeadBox>
          <HeadBox label="Total">
            <p className="text-xl font-semibold tabular-nums">{money(total)}</p>
          </HeadBox>
        </div>

        <button
          type="button"
          className="erp-btn-primary mt-3"
          onClick={() => {
            const p = data?.products[0];
            setLines((ls) => [...ls, { productId: p?.id ?? 0, qty: 1, unitPrice: num(p?.list_price), uom: p?.uom || "TM" }]);
          }}
        >
          <Plus className="mr-1 inline size-3.5" />
          Agregar partida
        </button>

        <div className="mt-3 overflow-x-auto erp-card">
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
              {lines.map((line, i) => {
                const p = data?.products.find((x) => x.id === line.productId);
                return (
                  <tr key={i} className="border-t border-line">
                    <td className="px-3 py-2">
                      <SearchSelect
                        value={line.productId ? String(line.productId) : ""}
                        options={asOpts(data?.products, (prod) => prod.id, (prod) => `${prod.code} — ${prod.name}`)}
                        placeholder="Buscar producto…"
                        onChange={(v) => {
                          const id = Number(v);
                          const prod = data?.products.find((x) => x.id === id);
                          setLines((ls) => ls.map((x, j) => (j === i ? { ...x, productId: id, uom: prod?.uom || x.uom, unitPrice: Number(prod?.list_price ?? x.unitPrice) } : x)));
                        }}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <UomSelect value={line.uom || p?.uom || "TM"} extra={p?.uom} onChange={(uom) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, uom } : x)))} />
                    </td>
                    <td className="px-3 py-2">
                      <QtyField value={line.qty} onChange={(qty) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty } : x)))} />
                    </td>
                    <td className="px-3 py-2">
                      <MoneyField value={line.unitPrice} onChange={(unitPrice) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, unitPrice } : x)))} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(line.qty * line.unitPrice)}</td>
                    <td className="px-2 py-2">
                      {lines.length > 1 && (
                        <button type="button" className="grid size-8 place-items-center text-muted hover:text-danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
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
        <div className="mt-3 flex justify-end">
          <button className="erp-btn-primary" disabled={busy}>Registrar OC</button>
        </div>
      </form>

      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[800px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Folio</th>
              <th className="px-3 py-3 font-medium">OC cliente</th>
              <th className="px-3 py-3 font-medium">Cliente</th>
              <th className="px-3 py-3 font-medium">Estado</th>
              <th className="px-3 py-3 font-medium">Pedido Azagro</th>
              <th className="px-3 py-3 text-right font-medium">Total</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {data?.pos.map((row) => (
              <tr key={row.id} className="border-t border-line">
                <td className="px-4 py-3 font-medium">{row.name}</td>
                <td className="px-3 py-3">{row.customer_po_number}</td>
                <td className="px-3 py-3">{row.partner}</td>
                <td className="px-3 py-3">
                  <StatusPill tone={row.status === "converted" ? "ok" : "warn"}>{row.status === "converted" ? "En pedido" : "Abierta"}</StatusPill>
                </td>
                <td className="px-3 py-3">
                  {row.so_id ? (
                    <Link to="/sales/$orderId" params={{ orderId: String(row.so_id) }} className="text-accent">
                      {row.so_name}
                    </Link>
                  ) : "—"}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{money(row.total)}</td>
                <td className="px-4 py-3 text-right">
                  {row.status !== "converted" && locs[0] && (
                    <button
                      type="button"
                      className="erp-btn h-8 text-[12px]"
                      onClick={() =>
                        convertCustomerPO({ data: { cpoId: row.id, locationId: locs[0]!.id } })
                          .then(load)
                          .catch((e) => setError(e instanceof Error ? e.message : "Error"))
                      }
                    >
                      Convertir a pedido
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data && data.pos.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted">Aún no hay OC de clientes.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
