import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Field, HeadBox, StatusPill } from "@/components/erp";
import { QtyField } from "@/components/fields";
import { SearchSelect, asOpts } from "@/components/search-select";
import { adjustStock, listInventory, listPartners, listProducts, transferStock } from "@/lib/azagro";
import { deleteLocation, saveLocation } from "@/lib/erp/locations";
import { exportCsv } from "@/lib/export-csv";
import { OriginFolio } from "@/components/origin-folio";
import { money, num, qty } from "@/lib/utils";

export const Route = createFileRoute("/inventory")({ component: Page });

const TYPE_LABEL: Record<string, string> = {
  internal: "Bodega Azagro",
  supplier: "En proveedor",
  transit: "Tránsito",
  customer: "Punto de entrega",
};

const MOVE_LABEL: Record<string, string> = {
  receipt: "Recibo",
  delivery: "Entrega",
  internal: "Traslado",
  adjust: "Ajuste",
  opening: "Saldo inicial",
  return: "Devolución",
};

function isStock(t: string) {
  return t === "internal" || t === "supplier" || t === "transit";
}

function Page() {
  const [data, setData] = useState<Awaited<ReturnType<typeof listInventory>> | null>(null);
  const [products, setProducts] = useState<Awaited<ReturnType<typeof listProducts>>>([]);
  const [partners, setPartners] = useState<Awaited<ReturnType<typeof listPartners>>>([]);
  const [form, setForm] = useState({ productId: 0, fromId: 0, toId: 0, quantity: 0 });
  const [adj, setAdj] = useState({ productId: 0, locationId: 0, quantity: 0, note: "" });
  const [find, setFind] = useState("");
  const [kardexProduct, setKardexProduct] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locFilter, setLocFilter] = useState(0);
  const [kindFilter, setKindFilter] = useState<"all" | "internal" | "supplier" | "transit">("all");
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [locForm, setLocForm] = useState({ name: "", locType: "internal" as "internal" | "supplier" | "transit" | "customer", partnerId: 0, address: "" });

  async function load() {
    const [inv, prods, pts] = await Promise.all([listInventory(), listProducts(), listPartners()]);
    setData(inv);
    setProducts(prods);
    setPartners(pts);
    const stock = inv.locations.filter((l) => isStock(l.loc_type));
    setForm((f) => ({
      ...f,
      productId: f.productId || prods[0]?.id || 0,
      fromId: f.fromId && stock.some((l) => l.id === f.fromId) ? f.fromId : (stock.find((l) => l.loc_type === "internal")?.id ?? stock[0]?.id ?? 0),
      toId: f.toId && stock.some((l) => l.id === f.toId) ? f.toId : (stock.find((l) => l.loc_type === "transit")?.id ?? stock[1]?.id ?? stock[0]?.id ?? 0),
    }));
    setAdj((a) => ({
      ...a,
      productId: a.productId || prods[0]?.id || 0,
      locationId: a.locationId && stock.some((l) => l.id === a.locationId) ? a.locationId : (stock.find((l) => l.loc_type === "internal")?.id ?? stock[0]?.id ?? 0),
    }));
  }
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, []);

  const stockLocs = (data?.locations ?? []).filter((l) => isStock(l.loc_type));
  const shownLocs = kindFilter === "all" ? stockLocs : stockLocs.filter((l) => l.loc_type === kindFilter);
  const deliveryLocs = (data?.locations ?? []).filter((l) => l.loc_type === "customer");

  const quants = useMemo(() => {
    const q = find.trim().toLowerCase();
    let rows = data?.quants ?? [];
    if (locFilter) rows = rows.filter((r) => r.location_id === locFilter);
    if (kindFilter !== "all") rows = rows.filter((r) => r.loc_type === kindFilter);
    if (q) rows = rows.filter((r) => `${r.product_code} ${r.product_name}`.toLowerCase().includes(q));
    return rows;
  }, [data, locFilter, kindFilter, find]);

  const kardex = useMemo(() => {
    let rows = data?.moves ?? [];
    if (kardexProduct) rows = rows.filter((m) => m.product_id === kardexProduct);
    else if (find.trim()) {
      const q = find.trim().toLowerCase();
      rows = rows.filter((m) => m.product.toLowerCase().includes(q) || (m.origin ?? "").toLowerCase().includes(q));
    }
    const chrono = [...rows].reverse();
    let bal = 0;
    const tagged = chrono.map((mv) => {
      const inn = mv.to_name ? num(mv.quantity) : 0;
      const out = mv.from_name ? num(mv.quantity) : 0;
      bal += inn - out;
      return { ...mv, inQty: inn, outQty: out, saldo: bal };
    });
    return tagged.reverse();
  }, [data, kardexProduct, find]);

  const stockValue = (type: string) =>
    (data?.quants ?? []).filter((q) => q.loc_type === type).reduce((s, q) => s + num(q.quantity) * num(q.cost), 0);

  const locValue = (id: number) =>
    (data?.quants ?? []).filter((q) => q.location_id === id).reduce((s, q) => s + num(q.quantity) * num(q.cost), 0);

  const onHandFrom = (data?.quants ?? [])
    .filter((q) => q.product_id === form.productId && q.location_id === form.fromId)
    .reduce((s, q) => s + num(q.quantity), 0);

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Inventario</h1>
          <p className="mt-0.5 text-sm text-muted">
            El kardex es el libro: cada recibo, entrega, traslado o ajuste deja un renglón. La existencia es la suma de esos movimientos, no un número que se pisa. Al recibir una OC, el costo promedio de esa bodega se recalcula.
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/rfq/nuevo" className="erp-btn grid place-items-center">
            Pedir para inventario
          </Link>
          <button type="button" className="erp-btn" onClick={() => { setEditing("new"); setLocForm({ name: "", locType: "internal", partnerId: 0, address: "" }); }}>
            Nueva bodega
          </button>
          <Link to="/products" search={{ tab: "catalogo", tipo: "", q: "" }} className="erp-btn grid place-items-center">
            Catálogo
          </Link>
        </div>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}
      {(data?.mismatches?.length ?? 0) > 0 && (
        <div className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger">
          El kardex y la existencia no cuadran en {data!.mismatches.length} partida{data!.mismatches.length === 1 ? "" : "s"}.
          La cifra buena es el kardex.{" "}
          {data!.mismatches.slice(0, 4).map((r) => `${r.product_code} en ${r.location_name}`).join(" · ")}
          {data!.mismatches.length > 4 ? "…" : ""}
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {(
          [
            ["all", "Todas", null],
            ["internal", "Azagro", stockValue("internal")],
            ["supplier", "En proveedor", stockValue("supplier")],
            ["transit", "Tránsito", stockValue("transit")],
          ] as const
        ).map(([id, label, val]) => (
          <button
            key={id}
            type="button"
            className={kindFilter === id ? "erp-btn-primary h-8 text-[12px]" : "erp-btn h-8 text-[12px]"}
            onClick={() => {
              setKindFilter(id);
              setLocFilter(0);
            }}
          >
            {label}
            {val != null ? ` · ${money(val)}` : ""}
          </button>
        ))}
        <input
          className="erp-input h-8 w-56"
          placeholder="Buscar producto…"
          value={find}
          onChange={(e) => {
            setFind(e.target.value);
            setKardexProduct(0);
          }}
        />
      </div>

      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Bodegas</p>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {shownLocs.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => setLocFilter((cur) => (cur === l.id ? 0 : l.id))}
            className={`erp-card p-4 text-left ${locFilter === l.id ? "border-accent" : ""}`}
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{TYPE_LABEL[l.loc_type]}</p>
            <p className="mt-1 font-semibold">{l.name}</p>
            {l.partner_name ? <p className="text-[12px] text-muted">{l.partner_name}</p> : null}
            <p className="mt-2 text-lg tabular-nums">{money(locValue(l.id))}</p>
          </button>
        ))}
      </div>

      {deliveryLocs.length > 0 && (
        <>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Puntos de entrega (no son bodega)</p>
          <div className="mb-5 flex flex-wrap gap-2">
            {deliveryLocs.map((l) => (
              <span key={l.id} className="erp-chip">{l.name}</span>
            ))}
          </div>
        </>
      )}

      <form
        className="mb-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setMsg(null);
          setError(null);
          try {
            if (form.fromId === form.toId) throw new Error("Origen y destino no pueden ser la misma bodega");
            await transferStock({ data: form });
            setMsg("Traslado aplicado");
            await load();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Error");
          }
        }}
      >
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Traslado entre bodegas</h2>
            <p className="text-[12px] text-muted">Mueve mercancía de una bodega a otra (propia ↔ proveedor ↔ tránsito). Para surtir a un cliente, usa el pedido.</p>
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-5">
          <HeadBox label="Producto" className="lg:col-span-2">
            <SearchSelect
              bare
              value={form.productId ? String(form.productId) : ""}
              options={asOpts(products, (p) => p.id, (p) => `${p.code} — ${p.name}`)}
              placeholder="Buscar producto…"
              onChange={(v) => setForm({ ...form, productId: Number(v) })}
            />
          </HeadBox>
          <HeadBox label="Sale de">
            <SearchSelect
              bare
              value={form.fromId ? String(form.fromId) : ""}
              options={asOpts(stockLocs, (l) => l.id, (l) => l.name, (l) => TYPE_LABEL[l.loc_type])}
              placeholder="Bodega origen…"
              onChange={(v) => setForm({ ...form, fromId: Number(v) })}
            />
            <p className="mt-1 text-[11px] text-muted">Disponible {qty(onHandFrom)}</p>
          </HeadBox>
          <HeadBox label="Entra a">
            <SearchSelect
              bare
              value={form.toId ? String(form.toId) : ""}
              options={asOpts(stockLocs, (l) => l.id, (l) => l.name, (l) => TYPE_LABEL[l.loc_type])}
              placeholder="Bodega destino…"
              onChange={(v) => setForm({ ...form, toId: Number(v) })}
            />
          </HeadBox>
          <HeadBox label="Cantidad">
            <div className="flex gap-2">
              <QtyField className="flex-1 border-0 bg-transparent px-0" value={form.quantity} onChange={(quantity) => setForm({ ...form, quantity })} />
              <button className="erp-btn-primary shrink-0">Mover</button>
            </div>
          </HeadBox>
        </div>
      </form>

      <form
        className="mb-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setMsg(null);
          setError(null);
          try {
            await adjustStock({ data: adj });
            setMsg("Ajuste aplicado");
            setAdj((a) => ({ ...a, quantity: 0, note: "" }));
            await load();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Error");
          }
        }}
      >
        <h2 className="text-sm font-semibold">Ajuste de existencia</h2>
        <p className="mb-2 text-[12px] text-muted">También es un movimiento del kardex (conteo, merma). Positivo entra, negativo sale. No pisa la existencia.</p>
        <div className="grid gap-3 lg:grid-cols-5">
          <HeadBox label="Producto" className="lg:col-span-2">
            <SearchSelect
              bare
              value={adj.productId ? String(adj.productId) : ""}
              options={asOpts(products, (p) => p.id, (p) => `${p.code} — ${p.name}`)}
              placeholder="Buscar producto…"
              onChange={(v) => setAdj({ ...adj, productId: Number(v) })}
            />
          </HeadBox>
          <HeadBox label="Bodega">
            <SearchSelect
              bare
              value={adj.locationId ? String(adj.locationId) : ""}
              options={asOpts(stockLocs, (l) => l.id, (l) => l.name, (l) => TYPE_LABEL[l.loc_type])}
              onChange={(v) => setAdj({ ...adj, locationId: Number(v) })}
              placeholder="Bodega…"
            />
          </HeadBox>
          <HeadBox label="Cantidad (+ entra / − sale)">
            <input
              className="erp-input w-full border-0 bg-transparent px-0 text-right tabular-nums"
              type="number"
              step="any"
              value={adj.quantity || ""}
              onChange={(e) => setAdj({ ...adj, quantity: Number(e.target.value) })}
            />
          </HeadBox>
          <HeadBox label="Motivo">
            <div className="flex gap-2">
              <input className="erp-input flex-1 border-0 bg-transparent px-0" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder="Conteo, merma…" />
              <button className="erp-btn-primary shrink-0">Ajustar</button>
            </div>
          </HeadBox>
        </div>
      </form>

      <div className="mb-6 erp-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Catálogo de bodegas y puntos</h2>
          <button type="button" className="text-[12px] font-semibold text-accent" onClick={() => { setEditing("new"); setLocForm({ name: "", locType: "internal", partnerId: 0, address: "" }); }}>
            + Alta
          </button>
        </div>
        {editing !== null && (
          <form
            className="mb-4 grid gap-3 md:grid-cols-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                await saveLocation({
                  data: {
                    id: editing === "new" ? undefined : editing,
                    name: locForm.name,
                    locType: locForm.locType,
                    partnerId: locForm.partnerId || undefined,
                    address: locForm.address,
                  },
                });
                setEditing(null);
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : "No se pudo guardar");
              }
            }}
          >
            <Field label="Nombre">
              <input className="erp-input" value={locForm.name} onChange={(e) => setLocForm({ ...locForm, name: e.target.value })} placeholder="Bodega Central, Greenhow…" />
            </Field>
            <Field label="Tipo">
              <select className="erp-input" value={locForm.locType} onChange={(e) => setLocForm({ ...locForm, locType: e.target.value as typeof locForm.locType })}>
                <option value="internal">Bodega Azagro</option>
                <option value="supplier">Bodega de proveedor</option>
                <option value="transit">En tránsito</option>
                <option value="customer">Punto de entrega</option>
              </select>
            </Field>
            {(locForm.locType === "supplier" || locForm.locType === "customer") && (
              <Field label={locForm.locType === "supplier" ? "Proveedor" : "Cliente"}>
                <SearchSelect
                  value={locForm.partnerId ? String(locForm.partnerId) : ""}
                  options={asOpts(
                    partners.filter((p) => (locForm.locType === "supplier" ? p.is_supplier : p.is_customer)),
                    (p) => p.id,
                    (p) => p.name,
                  )}
                  onChange={(v) => setLocForm({ ...locForm, partnerId: Number(v) })}
                  placeholder="Vincular…"
                />
              </Field>
            )}
            <Field label="Dirección">
              <input className="erp-input" value={locForm.address} onChange={(e) => setLocForm({ ...locForm, address: e.target.value })} />
            </Field>
            <div className="flex items-end gap-2 md:col-span-4">
              <button className="erp-btn-primary">{editing === "new" ? "Crear" : "Guardar"}</button>
              <button type="button" className="erp-btn" onClick={() => setEditing(null)}>Cancelar</button>
            </div>
          </form>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-2 py-2 font-medium">Clave</th>
                <th className="px-2 py-2 font-medium">Nombre</th>
                <th className="px-2 py-2 font-medium">Tipo</th>
                <th className="px-2 py-2 font-medium">Vinculado</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {(data?.locations ?? []).map((l) => (
                <tr key={l.id} className="border-t border-line">
                  <td className="px-2 py-2 font-mono text-xs">{l.code}</td>
                  <td className="px-2 py-2 font-medium">{l.name}</td>
                  <td className="px-2 py-2">
                    <StatusPill tone={l.loc_type === "customer" ? "muted" : l.loc_type === "supplier" ? "warn" : "ok"}>{TYPE_LABEL[l.loc_type]}</StatusPill>
                  </td>
                  <td className="px-2 py-2 text-muted">{l.partner_name ?? "—"}</td>
                  <td className="px-2 py-2 text-right">
                    <button
                      type="button"
                      className="mr-2 text-[12px] font-semibold text-accent"
                      onClick={() => {
                        setEditing(l.id);
                        setLocForm({ name: l.name, locType: l.loc_type as typeof locForm.locType, partnerId: l.partner_id ?? 0, address: l.address ?? "" });
                      }}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      className="text-[12px] font-semibold text-danger"
                      onClick={async () => {
                        if (!confirm(`¿Eliminar ${l.name}?`)) return;
                        try {
                          await deleteLocation({ data: { id: l.id } });
                          await load();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "No se pudo borrar");
                        }
                      }}
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(data?.incoming.length || data?.outgoing.length) ? (
        <div className="mb-5 grid gap-3 lg:grid-cols-2">
          <div className="erp-card p-4">
            <h2 className="text-sm font-semibold">Por recibir (OC inventario)</h2>
            <ul className="mt-2 text-[13px]">
              {(data?.incoming ?? []).map((r, i) => (
                <li key={`${r.po_name}-${r.product_id}-${i}`} className="flex justify-between gap-2 border-t border-line py-1.5 first:border-0">
                  <span>
                    <button type="button" className="font-medium hover:underline" onClick={() => setFind(r.product_code)}>{r.product_code}</button>
                    {" "}{r.product_name} · {r.po_name}
                  </span>
                  <span className="tabular-nums">{qty(r.pending)} {r.uom}</span>
                </li>
              ))}
              {data?.incoming.length === 0 && <li className="text-muted">Nada pendiente de recibir.</li>}
            </ul>
          </div>
          <div className="erp-card p-4">
            <h2 className="text-sm font-semibold">Reservado a pedidos (por entregar)</h2>
            <ul className="mt-2 text-[13px]">
              {(data?.outgoing ?? []).map((r, i) => (
                <li key={`${r.so_name}-${r.product_id}-${i}`} className="flex justify-between gap-2 border-t border-line py-1.5 first:border-0">
                  <span>
                    <button type="button" className="font-medium hover:underline" onClick={() => setFind(r.product_code)}>{r.product_code}</button>
                    {" "}{r.product_name} · {r.so_name}
                  </span>
                  <span className="tabular-nums">{qty(r.pending)} {r.uom}</span>
                </li>
              ))}
              {data?.outgoing.length === 0 && <li className="text-muted">Nada reservado.</li>}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="mb-2 flex justify-end">
        <button
          type="button"
          className="erp-btn"
          onClick={() =>
            exportCsv(
              "inventario-azagro",
              ["Producto", "Código", "Bodega", "Tipo", "Cantidad", "UoM", "Costo prom.", "Valor"],
              quants.map((q) => [q.product_name, q.product_code, q.location_name, q.loc_type, q.quantity, q.uom, q.cost, num(q.quantity) * num(q.cost)]),
            )
          }
        >
          Exportar Excel
        </button>
      </div>
      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[700px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Producto</th>
              <th className="px-3 py-3 font-medium">Ubicación</th>
              <th className="px-3 py-3 text-right font-medium">Cantidad</th>
              <th className="px-3 py-3 text-right font-medium">Costo prom.</th>
              <th className="px-4 py-3 text-right font-medium">Valor</th>
            </tr>
          </thead>
          <tbody>
            {quants.map((q) => (
              <tr key={q.id} className="border-t border-line">
                <td className="px-4 py-3">
                  <button type="button" className="text-left" onClick={() => { setFind(q.product_code); setKardexProduct(q.product_id); }}>
                    <span className="font-medium">{q.product_name}</span>
                    <span className="ml-2 font-mono text-[11px] text-muted">{q.product_code}</span>
                  </button>
                </td>
                <td className="px-3 py-3">
                  {q.location_name}
                  {q.loc_type === "supplier" && <span className="ml-2"><StatusPill tone="muted">proveedor</StatusPill></span>}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {qty(q.quantity)} {q.uom}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{money(num(q.cost))}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(num(q.quantity) * num(q.cost))}</td>
              </tr>
            ))}
            {quants.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted">
                  Sin existencias en esta bodega.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-6 mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Kardex</h2>
          <p className="text-[12px] text-muted">
            {kardexProduct
              ? "Movimientos de este producto. Clic en el folio (OC, PV) para abrir el expediente. El saldo es la existencia acumulada."
              : "Últimos movimientos. Clic en un producto de la tabla para ver su kardex y de dónde vino / a dónde salió."}
          </p>
        </div>
        {kardexProduct ? (
          <button type="button" className="text-[12px] font-semibold text-accent" onClick={() => setKardexProduct(0)}>
            Ver todos
          </button>
        ) : null}
      </div>
      {kardexProduct ? (
        <div className="mb-3 grid gap-3 md:grid-cols-2">
          <div className="erp-card p-3 text-[13px]">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Entró por</p>
            <ul className="mt-1">
              {kardex
                .filter((m) => m.inQty && (m.move_type === "receipt" || m.move_type === "return" || m.move_type === "opening" || m.move_type === "internal"))
                .slice(0, 8)
                .map((m) => (
                  <li key={`in-${m.id}`} className="flex justify-between gap-2 border-t border-line py-1 first:border-0">
                    <span>
                      <OriginFolio origin={m.origin} />
                      <span className="text-muted"> · {MOVE_LABEL[m.move_type] ?? m.move_type}</span>
                    </span>
                    <span className="tabular-nums">{qty(m.inQty)}</span>
                  </li>
                ))}
              {kardex.filter((m) => m.inQty && (m.move_type === "receipt" || m.move_type === "return" || m.move_type === "opening" || m.move_type === "internal")).length === 0 && (
                <li className="text-muted">Sin entradas en este kardex.</li>
              )}
            </ul>
          </div>
          <div className="erp-card p-3 text-[13px]">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Salió a</p>
            <ul className="mt-1">
              {kardex
                .filter((m) => m.outQty && (m.move_type === "delivery" || m.move_type === "internal" || m.move_type === "adjust"))
                .slice(0, 8)
                .map((m) => (
                  <li key={`out-${m.id}`} className="flex justify-between gap-2 border-t border-line py-1 first:border-0">
                    <span>
                      <OriginFolio origin={m.origin} />
                      <span className="text-muted"> · {MOVE_LABEL[m.move_type] ?? m.move_type}</span>
                    </span>
                    <span className="tabular-nums">{qty(m.outQty)}</span>
                  </li>
                ))}
              {kardex.filter((m) => m.outQty && (m.move_type === "delivery" || m.move_type === "internal" || m.move_type === "adjust")).length === 0 && (
                <li className="text-muted">Sin salidas en este kardex.</li>
              )}
            </ul>
          </div>
        </div>
      ) : null}
      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[860px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Fecha</th>
              <th className="px-3 py-3 font-medium">Ref</th>
              <th className="px-3 py-3 font-medium">Tipo</th>
              <th className="px-3 py-3 font-medium">Producto</th>
              <th className="px-3 py-3 font-medium">Origen → Destino</th>
              <th className="px-3 py-3 text-right font-medium">Entra</th>
              <th className="px-3 py-3 text-right font-medium">Sale</th>
              <th className="px-3 py-3 text-right font-medium">Costo</th>
              {kardexProduct ? <th className="px-4 py-3 text-right font-medium">Saldo</th> : null}
            </tr>
          </thead>
          <tbody>
            {kardex.map((mv) => (
              <tr key={mv.id} className="border-t border-line">
                <td className="px-4 py-3 tabular-nums text-muted">{mv.date}</td>
                <td className="px-3 py-3 font-mono text-xs">{mv.ref}</td>
                <td className="px-3 py-3">{MOVE_LABEL[mv.move_type] ?? mv.move_type}</td>
                <td className="px-3 py-3">{mv.product}</td>
                <td className="px-3 py-3 text-muted">
                  {mv.from_name ?? "—"} → {mv.to_name ?? "—"}
                  {mv.origin && mv.origin !== "Traslado" ? (
                    <span className="ml-1">
                      · <OriginFolio origin={mv.origin} />
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{mv.inQty ? qty(mv.inQty) : "—"}</td>
                <td className="px-3 py-3 text-right tabular-nums">{mv.outQty ? qty(mv.outQty) : "—"}</td>
                <td className="px-3 py-3 text-right tabular-nums">{num(mv.unit_cost) ? money(num(mv.unit_cost)) : "—"}</td>
                {kardexProduct ? <td className="px-4 py-3 text-right tabular-nums">{qty(mv.saldo)}</td> : null}
              </tr>
            ))}
            {kardex.length === 0 && (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-muted" colSpan={kardexProduct ? 9 : 8}>
                  Aún no hay movimientos.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
