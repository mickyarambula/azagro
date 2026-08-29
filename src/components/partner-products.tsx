import { useEffect, useState } from "react";
import { Field } from "@/components/erp";
import { MoneyField } from "@/components/fields";
import { SearchSelect, asOpts } from "@/components/search-select";
import { deletePartnerProduct, listPartnerProducts, savePartnerProduct } from "@/lib/erp/links";
import { money } from "@/lib/utils";

export function PartnerProducts({
  partnerId,
  productId,
  canEdit,
  defaultKind = "sell",
}: {
  partnerId?: number;
  productId?: number;
  canEdit?: boolean;
  defaultKind?: "sell" | "buy";
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof listPartnerProducts>> | null>(null);
  const [pickPartner, setPickPartner] = useState("");
  const [pickProduct, setPickProduct] = useState("");
  const [kind, setKind] = useState<"sell" | "buy">(defaultKind);
  const [price, setPrice] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setData(await listPartnerProducts({ data: { partnerId, productId } }));
  }
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, [partnerId, productId]);

  return (
    <section className="mt-8">
      <h2 className="text-[13px] font-semibold">Productos vinculados</h2>
      <p className="mt-0.5 text-sm text-muted">
        Qué le vendemos al cliente o qué le compramos al proveedor. Se llena solo al registrar solicitud, cotización, pedido u OC. El precio es el último pactado, no el de lista. Aquí se puede ajustar o quitar.
      </p>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {canEdit && (
        <div className="mt-3 grid gap-2 md:grid-cols-5">
          {!partnerId && (
            <Field label="Partner">
              <SearchSelect
                value={pickPartner}
                options={asOpts(data?.partners, (p) => p.id, (p) => p.name)}
                onChange={setPickPartner}
                placeholder="Buscar…"
              />
            </Field>
          )}
          {!productId && (
            <Field label="Producto">
              <SearchSelect
                value={pickProduct}
                options={asOpts(data?.products, (p) => p.id, (p) => `${p.code} — ${p.name}`)}
                onChange={(v) => {
                  setPickProduct(v);
                  const p = data?.products.find((x) => x.id === Number(v));
                  if (p) setPrice(Number(p.list_price) || Number(p.cost) || 0);
                }}
                placeholder="Buscar producto…"
              />
            </Field>
          )}
          <Field label="Relación">
            <select className="erp-input" value={kind} onChange={(e) => setKind(e.target.value as "sell" | "buy")}>
              <option value="sell">Le vendemos</option>
              <option value="buy">Le compramos</option>
            </select>
          </Field>
          <Field label="Precio pactado">
            <MoneyField className="w-full" value={price} onChange={setPrice} />
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              className="erp-btn-primary w-full"
              onClick={async () => {
                const pid = partnerId || Number(pickPartner);
                const prid = productId || Number(pickProduct);
                if (!pid || !prid) return;
                try {
                  await savePartnerProduct({ data: { partnerId: pid, productId: prid, kind, unitPrice: price } });
                  setPickProduct("");
                  await load();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Error");
                }
              }}
            >
              Vincular
            </button>
          </div>
        </div>
      )}
      <ul className="mt-3">
        {(data?.rows ?? []).map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-3 text-sm">
            <div>
              <p className="font-medium">{productId ? r.partner : `${r.code} — ${r.product}`}</p>
              <p className="text-muted">{r.kind === "buy" ? "Compra" : "Venta"} · {money(r.unit_price)}</p>
            </div>
            {canEdit && (
              <button type="button" className="text-[12px] font-semibold text-danger" onClick={() => deletePartnerProduct({ data: { id: r.id } }).then(load)}>
                Quitar
              </button>
            )}
          </li>
        ))}
        {(data?.rows ?? []).length === 0 && <li className="py-4 text-sm text-muted">Sin productos vinculados.</li>}
      </ul>
    </section>
  );
}
