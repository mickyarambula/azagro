import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { BackBar, HeadBox } from "@/components/erp";
import { QtyField, UomSelect } from "@/components/fields";
import { OpsPipeline } from "@/components/pipeline";
import { SearchSelect, asOpts } from "@/components/search-select";
import { createRfq, listRfqs } from "@/lib/erp/rfq";
import { humanError } from "@/lib/utils";

export const Route = createFileRoute("/rfq/nuevo")({ component: Page });

function Page() {
  const navigate = useNavigate();
  const [data, setData] = useState<Awaited<ReturnType<typeof listRfqs>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locationId, setLocationId] = useState(0);
  const [currency, setCurrency] = useState<"MXN" | "USD">("MXN");
  const [notes, setNotes] = useState("");
  const [supplierIds, setSupplierIds] = useState<number[]>([]);
  const [lines, setLines] = useState([{ productId: 0, qty: 1, uom: "KGS" }]);

  useEffect(() => {
    void listRfqs()
      .then((d) => {
        setData(d);
        const bodega = d.locations.find((l) => l.loc_type === "internal") ?? d.locations[0];
        setLocationId((id) => id || bodega?.id || 0);
        setLines((ls) =>
          ls[0]?.productId
            ? ls
            : [{ productId: d.products[0]?.id ?? 0, qty: 1, uom: d.products[0]?.uom || "KGS" }],
        );
      })
      .catch((e) => setError(humanError(e)));
  }, []);

  function toggleSup(id: number) {
    setSupplierIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  return (
    <>
      <OpsPipeline current="compra" />
      <BackBar to="/rfq" label="Cotizar proveedores" />
      <h1 className="text-xl font-semibold">Pedir para inventario</h1>
      <p className="mt-0.5 text-sm text-muted">
        Sin pedido de cliente. Cotizas a uno o varios proveedores, eliges ganador y se arma la OC para recibir en bodega.
      </p>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <form
        className="mt-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const take = lines.filter((l) => l.productId && l.qty > 0);
            if (!take.length) throw new Error("Agrega al menos un producto");
            if (!supplierIds.length) throw new Error("Elige a quién le pides precio");
            if (!locationId) throw new Error("Elige la bodega donde vas a recibir");
            const r = await createRfq({
              data: {
                purpose: "stock",
                locationId,
                currency,
                notes: notes || "Compra para inventario",
                supplierIds,
                lines: take,
              },
            });
            await navigate({ to: "/rfq/$rfqId", params: { rfqId: String(r.id) } });
          } catch (err) {
            setError(humanError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid gap-3 lg:grid-cols-3">
          <HeadBox label="Bodega de recibo">
            <SearchSelect
              bare
              value={locationId ? String(locationId) : ""}
              options={asOpts(data?.locations, (l) => l.id, (l) => l.name, (l) => (l.loc_type === "internal" ? "Azagro" : l.loc_type === "supplier" ? "Proveedor" : "Tránsito"))}
              onChange={(v) => setLocationId(Number(v) || 0)}
              placeholder="Bodega…"
            />
          </HeadBox>
          <HeadBox label="Moneda">
            <select className="erp-input border-0 bg-transparent px-0" value={currency} onChange={(e) => setCurrency(e.target.value as "MXN" | "USD")}>
              <option value="MXN">MXN</option>
              <option value="USD">USD</option>
            </select>
          </HeadBox>
          <HeadBox label="Nota">
            <input className="erp-input border-0 bg-transparent px-0" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reposición, temporada…" />
          </HeadBox>
        </div>

        <h2 className="mt-6 text-sm font-semibold">Proveedores a cotizar</h2>
        <p className="mb-2 text-[12px] text-muted">Marca uno o varios. Luego les mandas correo o WhatsApp desde la comparativa.</p>
        <div className="flex flex-wrap gap-2">
          {(data?.suppliers ?? []).map((s) => {
            const on = supplierIds.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                className={on ? "erp-btn-primary h-8 text-[12px]" : "erp-btn h-8 text-[12px]"}
                onClick={() => toggleSup(s.id)}
              >
                {s.name}
              </button>
            );
          })}
          {(data?.suppliers ?? []).length === 0 && <p className="text-sm text-muted">No hay proveedores en el catálogo.</p>}
        </div>

        <h2 className="mt-6 text-sm font-semibold">Qué necesitas</h2>
        <div className="mt-2 overflow-x-auto erp-card">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Producto</th>
                <th className="px-3 py-2 font-medium">Cant.</th>
                <th className="px-3 py-2 font-medium">UoM</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="px-3 py-2">
                    <SearchSelect
                      value={line.productId ? String(line.productId) : ""}
                      options={asOpts(data?.products, (p) => p.id, (p) => `${p.code} — ${p.name}`)}
                      onChange={(v) => {
                        const p = data?.products.find((x) => x.id === Number(v));
                        setLines((ls) => ls.map((l, j) => (j === i ? { ...l, productId: Number(v) || 0, uom: p?.uom || l.uom } : l)));
                      }}
                      placeholder="Buscar producto…"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <QtyField value={line.qty} onChange={(qty) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, qty } : l)))} />
                  </td>
                  <td className="px-3 py-2">
                    <UomSelect value={line.uom} onChange={(uom) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, uom } : l)))} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {lines.length > 1 && (
                      <button type="button" className="text-danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="erp-btn mt-2"
          onClick={() => setLines((ls) => [...ls, { productId: data?.products[0]?.id ?? 0, qty: 1, uom: data?.products[0]?.uom || "KGS" }])}
        >
          <Plus className="size-4" /> Producto
        </button>

        <div className="mt-6 flex gap-2">
          <button className="erp-btn-primary" disabled={busy}>
            {busy ? "Creando…" : "Crear y comparar precios"}
          </button>
        </div>
      </form>
    </>
  );
}
