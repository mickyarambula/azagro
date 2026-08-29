import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { BackBar } from "@/components/erp";
import { ProductFields } from "@/components/product-form";
import { PartnerProducts } from "@/components/partner-products";
import { useAccess } from "@/lib/access";
import { getProduct, saveProduct } from "@/lib/azagro";
import { listLookups } from "@/lib/erp/catalogs";
import { money, num, qty } from "@/lib/utils";

export const Route = createFileRoute("/products/$productId")({
  component: Ficha,
});

function Ficha() {
  const { productId } = Route.useParams();
  const id = Number(productId);
  const { can } = useAccess();
  const canEdit = can("products", "edit");
  const [lookups, setLookups] = useState<Awaited<ReturnType<typeof listLookups>> | null>(null);
  const [form, setForm] = useState<{
    code: string;
    name: string;
    product_type: string;
    uom: string;
    cost: number;
    list_price: number;
    min_stock: number;
  } | null>(null);
  const [onHand, setOnHand] = useState("0");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [p, l] = await Promise.all([getProduct({ data: { id } }), listLookups()]);
    setLookups(l);
    setForm({
      code: p.code,
      name: p.name,
      product_type: p.product_type,
      uom: p.uom,
      cost: num(p.cost),
      list_price: num(p.list_price),
      min_stock: num(p.min_stock),
    });
    setOnHand(p.on_hand);
  }

  useEffect(() => {
    setForm(null);
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, [id]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError(null);
    try {
      await saveProduct({ data: { ...form, id } });
      setMsg("Guardado");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    }
  }

  if (!form) return <p className="text-sm text-muted">{error ?? "Cargando…"}</p>;

  return (
    <form onSubmit={onSave} className="mx-auto max-w-3xl">
      <BackBar to="/products" label="Todos los productos" search={{ tab: "catalogo", tipo: "", q: "" }} />
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold">Editar producto</h1>
          <p className="mt-0.5 text-sm text-muted">
            {form.code} · {qty(onHand)} {form.uom} en existencia
            {form.list_price ? ` · lista ${money(form.list_price)}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/inventory" className="erp-btn grid place-items-center">
            Inventario
          </Link>
          {canEdit && (
            <button className="erp-btn-primary" type="submit">
              Guardar
            </button>
          )}
        </div>
      </div>
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <ProductFields form={form} setForm={setForm} lookups={lookups} onLookups={async () => setLookups(await listLookups())} />
      <PartnerProducts productId={id} canEdit={canEdit} />
    </form>
  );
}
