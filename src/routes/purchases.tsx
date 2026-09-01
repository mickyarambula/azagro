import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { HeadBox, StatusPill } from "@/components/erp";
import { MoneyField, QtyField, UomSelect } from "@/components/fields";
import { SearchSelect, asOpts } from "@/components/search-select";
import { SendButton } from "@/components/send-doc";
import { letterhead, logoSrc, printHtml } from "@/lib/print-doc";
import { createPurchase, listPurchases, receivePurchase } from "@/lib/azagro";
import { exportCsv } from "@/lib/export-csv";
import { moneyIn, num, todayMx } from "@/lib/utils";

export const Route = createFileRoute("/purchases")({
  validateSearch: (s: Record<string, unknown>): { tab: "all" | "new" } => ({
    tab: s.tab === "new" ? "new" : "all",
  }),
  component: Page,
});

function Page() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: "/purchases" });
  const [data, setData] = useState<Awaited<ReturnType<typeof listPurchases>> | null>(null);
  const [partnerId, setPartnerId] = useState(0);
  const [locationId, setLocationId] = useState(0);
  const [date, setDate] = useState(todayMx);
  const [notes, setNotes] = useState("");
  const [currency, setCurrency] = useState<"MXN" | "USD">("MXN");
  const [fulfillKind, setFulfillKind] = useState<"inventory" | "direct">("inventory");
  const [lines, setLines] = useState([{ productId: 0, qty: 1, unitPrice: 0, uom: "TM", deliverTo: "" }]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const d = await listPurchases();
    setData(d);
    setPartnerId((p) => p || d.suppliers[0]?.id || 0);
    setLocationId((l) => l || d.locations[0]?.id || 0);
    setLines((ls) =>
      ls[0]?.productId
        ? ls
        : [{ productId: d.products[0]?.id ?? 0, qty: 1, unitPrice: num(d.products[0]?.cost), uom: d.products[0]?.uom || "TM", deliverTo: d.locations[0]?.name || "" }],
    );
  }
  useEffect(() => {
    void load();
  }, []);

  const total = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const loc = data?.locations.find((l) => l.id === locationId);

  return (
    <AppShell flush>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-8">
        {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}

        {tab === "new" ? (
          <>
          <p className="mb-4 text-sm text-muted">
            Si ya tienes el precio, arma la OC aquí. Si todavía no,{" "}
            <Link to="/rfq/nuevo" className="font-medium text-accent hover:underline">
              pide cotización para inventario
            </Link>{" "}
            y al elegir ganador se genera sola.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setMsg(null);
              try {
                const r = await createPurchase({
                  data: {
                    partnerId,
                    locationId,
                    notes,
                    currency,
                    fulfillKind,
                    lines: lines.filter((l) => l.productId && l.qty > 0),
                  },
                });
                setMsg(`Orden ${r.name} confirmada`);
                setNotes("");
                await load();
                await navigate({ search: { tab: "all" } });
              } catch (err) {
                setMsg(err instanceof Error ? err.message : "Error");
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="grid gap-3 lg:grid-cols-5">
              <HeadBox
                label="Proveedor"
                action={
                  <Link to="/partners/nuevo" search={{ tipo: "proveedor", tab: "proveedores", q: "" }} className="text-[11px] font-semibold text-accent">
                    Alta
                  </Link>
                }
              >
                <SearchSelect
                  bare
                  value={partnerId ? String(partnerId) : ""}
                  options={asOpts(data?.suppliers, (s) => s.id, (s) => s.name)}
                  onChange={(v) => setPartnerId(Number(v))}
                  placeholder="Buscar proveedor…"
                />
              </HeadBox>
              <HeadBox label="Operación">
                <div className="flex gap-1">
                  <button type="button" className={fulfillKind === "inventory" ? "erp-btn-primary h-8 text-[12px]" : "erp-btn h-8 text-[12px]"} onClick={() => setFulfillKind("inventory")}>
                    Inventario
                  </button>
                  <button type="button" className={fulfillKind === "direct" ? "erp-btn-primary h-8 text-[12px]" : "erp-btn h-8 text-[12px]"} onClick={() => setFulfillKind("direct")}>
                    Directo
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  {fulfillKind === "direct" ? "Brokeraje: no entra a bodega Azagro." : "Se recibe en bodega propia o del productor."}
                </p>
              </HeadBox>
              <HeadBox label={fulfillKind === "direct" ? "Referencia de origen" : "Dónde se recibe"}>
                <SearchSelect
                  bare
                  value={locationId ? String(locationId) : ""}
                  options={asOpts(data?.locations, (l) => l.id, (l) => l.name, (l) => (l.loc_type === "supplier" ? "bodega productor" : "bodega Azagro"))}
                  onChange={(v) => setLocationId(Number(v))}
                  placeholder="Buscar ubicación…"
                />
              </HeadBox>
              <HeadBox label="Fecha">
                <input className="erp-input w-full border-0 bg-transparent px-0" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </HeadBox>
              <HeadBox label="Moneda">
                <select className="erp-input w-full border-0 bg-transparent px-0" value={currency} onChange={(e) => setCurrency(e.target.value as "MXN" | "USD")}>
                  <option value="MXN">MXN</option>
                  <option value="USD">USD</option>
                </select>
              </HeadBox>
              <HeadBox label="Total">
                <p className="text-xl font-semibold tabular-nums">{moneyIn(total, currency)}</p>
                <p className="text-[11px] text-muted">{lines.length} partidas</p>
              </HeadBox>
            </div>

            <button
              type="button"
              className="erp-btn-primary mt-3"
              onClick={() =>
                setLines((ls) => [
                  ...ls,
                  {
                    productId: data?.products[0]?.id ?? 0,
                    qty: 1,
                    unitPrice: num(data?.products[0]?.cost),
                    uom: data?.products[0]?.uom || "TM",
                    deliverTo: loc?.name || "",
                  },
                ])
              }
            >
              <Plus className="mr-1 inline size-3.5" />
              Agregar partida
            </button>

            <div className="mt-3 overflow-x-auto erp-card">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2.5 font-medium">Producto</th>
                    <th className="px-3 py-2.5 font-medium">UoM</th>
                    <th className="px-3 py-2.5 text-right font-medium">Cant.</th>
                    <th className="px-3 py-2.5 text-right font-medium">Costo / UoM</th>
                    <th className="px-3 py-2.5 font-medium">Entregar en</th>
                    <th className="px-3 py-2.5 text-right font-medium">Importe</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-3 py-2">
                        <SearchSelect
                          value={line.productId ? String(line.productId) : ""}
                          options={asOpts(data?.products, (p) => p.id, (p) => `${p.code} — ${p.name}`)}
                          placeholder="Buscar producto…"
                          onChange={(v) => {
                            const id = Number(v);
                            const p = data?.products.find((x) => x.id === id);
                            setLines((ls) => ls.map((x, j) => (j === i ? { ...x, productId: id, unitPrice: num(p?.cost), uom: p?.uom || x.uom } : x)));
                          }}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <UomSelect value={line.uom} extra={data?.products.find((x) => x.id === line.productId)?.uom} onChange={(uom) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, uom } : x)))} />
                      </td>
                      <td className="px-3 py-2">
                        <QtyField value={line.qty} onChange={(qty) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty } : x)))} />
                      </td>
                      <td className="px-3 py-2">
                        <MoneyField value={line.unitPrice} onChange={(unitPrice) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, unitPrice } : x)))} />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className="erp-input w-full min-w-[140px]"
                          list="po-destinos"
                          value={line.deliverTo}
                          placeholder="Bodega, campo…"
                          onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, deliverTo: e.target.value } : x)))}
                        />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{moneyIn(line.qty * line.unitPrice, currency)}</td>
                      <td className="px-2 py-2">
                        {lines.length > 1 && (
                          <button type="button" className="grid size-8 place-items-center text-muted hover:text-danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <datalist id="po-destinos">
              {(data?.locations ?? []).map((l) => (
                <option key={l.id} value={l.name} />
              ))}
            </datalist>

            <div className="mt-3 erp-card flex flex-wrap items-end justify-between gap-3 p-3">
              <label className="grid min-w-[240px] flex-1 gap-1 text-[12px] font-medium uppercase tracking-wide text-muted">
                Nota al proveedor
                <textarea className="erp-input h-16 py-2" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              <div className="text-right">
                <p className="text-[12px] text-muted">{loc?.loc_type === "supplier" ? "Queda en bodega del proveedor" : "Entra a bodega Azagro"}</p>
                <p className="text-lg font-semibold tabular-nums">{moneyIn(total, currency)}</p>
                <button className="erp-btn-primary mt-2" disabled={busy}>
                  Colocar orden
                </button>
              </div>
            </div>
          </form>
          </>
        ) : !data || data.orders.length === 0 ? (
          <div className="erp-card px-6 py-16 text-center">
            <p className="font-medium">No hay órdenes de compra</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">
              Aquí ves las compras. Si ya tienes precio, crea la OC. Si no, pide cotización para inventario y al elegir ganador se genera sola.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Link to="/rfq/nuevo" className="erp-btn grid place-items-center">Pedir para inventario</Link>
              <button type="button" className="erp-btn-primary" onClick={() => navigate({ search: { tab: "new" } })}>
                Nueva orden
              </button>
            </div>
          </div>
        ) : (
          <>
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              className="erp-btn"
              onClick={() =>
                exportCsv(
                  "compras-azagro",
                  ["OC", "Proveedor", "Entrega", "Estado", "Total"],
                  data.orders.map((o) => {
                    const dest = [...new Set((data.lines ?? []).filter((l) => l.po_id === o.id).map((l) => l.deliver_to).filter(Boolean))];
                    return [o.name, o.partner, dest.join(" · ") || o.location, o.state, o.total];
                  }),
                )
              }
            >
              Exportar Excel
            </button>
          </div>
          <div className="overflow-x-auto erp-card">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">OC</th>
                  <th className="px-3 py-3 font-medium">Proveedor</th>
                  <th className="px-3 py-3 font-medium">Entregar en</th>
                  <th className="px-3 py-3 font-medium">Tipo</th>
                  <th className="px-3 py-3 font-medium">Estado</th>
                  <th className="px-3 py-3 text-right font-medium">Total</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => {
                  const qlines = (data.lines ?? []).filter((l) => l.po_id === o.id);
                  const dest = [...new Set(qlines.map((l) => l.deliver_to).filter(Boolean))];
                  const destLabel = dest.length ? dest.join(" · ") : o.location;
                  return (
                  <tr key={o.id} className="border-t border-line">
                    <td className="px-4 py-3 font-medium">
                      <p>{o.name}</p>
                      {(o.so_name || o.rfq_name) && (
                        <p className="mt-0.5 text-[11px] text-muted">
                          {o.rfq_name ? (
                            <Link to="/rfq/$rfqId" params={{ rfqId: String(o.rfq_id) }} className="text-accent hover:underline">
                              {o.rfq_name}
                            </Link>
                          ) : null}
                          {o.rfq_name && o.so_name ? " → " : null}
                          {o.so_name ? (
                            <Link to="/sales/$orderId" params={{ orderId: String(o.so_id) }} className="text-accent hover:underline">
                              {o.so_name}
                            </Link>
                          ) : null}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-3">{o.partner}</td>
                    <td className="px-3 py-3 text-muted">{destLabel}</td>
                    <td className="px-3 py-3">{o.fulfill_kind === "direct" ? "Directo" : "Inventario"}</td>
                    <td className="px-3 py-3">
                      <StatusPill tone={o.state === "done" ? "ok" : "warn"}>
                        {o.fulfill_kind === "direct" ? "En camino" : o.state === "done" ? "Recibida" : "Por recibir"}
                      </StatusPill>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{moneyIn(o.total, o.currency)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className="erp-btn h-8 text-[12px]"
                          onClick={() => {
                            printHtml(
                              o.name,
                              letterhead({
                                logoSrc: logoSrc(),
                                legalName: "AZ INSUMOS AGRICOLAS SA DE CV",
                                title: "Orden de compra",
                                number: o.name,
                                partyLabel: "Proveedor",
                                party: o.partner,
                                meta: [
                                  o.currency === "USD" ? "USD" : "MXN",
                                  dest.length > 1 ? "Varias entregas" : destLabel,
                                  o.so_name || o.rfq_name ? `Expediente ${[o.rfq_name, o.so_name, o.name].filter(Boolean).join(" → ")}` : "",
                                ],
                                headers: ["Producto", "Cantidad", "P. unitario", "Importe", "Entregar en"],
                                rows: qlines.map((l) => ({
                                  cells: [
                                    l.product,
                                    `${l.qty} ${l.uom || ""}`.trim(),
                                    moneyIn(l.unit_price, o.currency),
                                    moneyIn(Number(l.qty) * Number(l.unit_price), o.currency),
                                    l.deliver_to || o.location,
                                  ],
                                })),
                                total: moneyIn(o.total, o.currency),
                                notes: "Documento al proveedor. Entregar en las ubicaciones de cada partida.",
                              }),
                              {
                                title: "Orden de compra",
                                number: o.name,
                                party: o.partner,
                                partnerId: o.partner_id,
                                email: data.suppliers.find((s) => s.name === o.partner)?.email,
                                phone: data.suppliers.find((s) => s.name === o.partner)?.phone,
                              },
                            );
                          }}
                        >
                          Documento
                        </button>
                        <SendButton
                          title="Orden de compra"
                          number={o.name}
                          party={o.partner}
                          partnerId={o.partner_id}
                          email={data.suppliers.find((s) => s.name === o.partner)?.email}
                          phone={data.suppliers.find((s) => s.name === o.partner)?.phone}
                          total={Number(o.total)}
                          currency={o.currency}
                          extra={destLabel ? `Entregar en: ${destLabel}` : ""}
                          lines={qlines.map((l) => ({ qty: Number(l.qty), uom: l.uom, name: `${l.product}${l.deliver_to ? ` → ${l.deliver_to}` : ""}`, unitPrice: Number(l.unit_price) }))}
                        />
                        {o.state !== "done" && o.fulfill_kind !== "direct" && (
                          <button
                            type="button"
                            className="erp-btn h-8 text-[12px]"
                            onClick={async () => {
                              try {
                                await receivePurchase({ data: { poId: o.id } });
                                await load();
                              } catch (err) {
                                setMsg(err instanceof Error ? err.message : "Error");
                              }
                            }}
                          >
                            Recibir
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
