import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { BackBar } from "@/components/erp";
import { ProductFields, type ProductDraft } from "@/components/product-form";
import { nextProductCode, saveProduct } from "@/lib/azagro";
import { listLookups } from "@/lib/erp/catalogs";

export const Route = createFileRoute("/products/nuevo")({
  component: Nuevo,
});

function Nuevo() {
  const navigate = useNavigate();
  const [lookups, setLookups] = useState<Awaited<ReturnType<typeof listLookups>> | null>(null);
  const [form, setForm] = useState<ProductDraft>({
    code: "",
    name: "",
    product_type: "FERTILIZANTES",
    uom: "KGS",
    cost: 0,
    list_price: 0,
    min_stock: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [code, l] = await Promise.all([nextProductCode(), listLookups()]);
      setLookups(l);
      setForm((f) => ({
        ...f,
        code: code.code,
        product_type: l.kinds[0]?.code ?? "SOLUBLE",
        uom: l.uoms[0]?.code ?? "TM",
      }));
    })();
  }, []);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await saveProduct({ data: form });
      await navigate({
        to: "/products/$productId",
        params: { productId: String(res.id) },
        search: { tab: "catalogo", tipo: "", q: "" },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSave} className="mx-auto max-w-3xl">
      <BackBar to="/products" label="Todos los productos" search={{ tab: "catalogo", tipo: "", q: "" }} />
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold">Nuevo producto</h1>
          <p className="mt-0.5 text-sm text-muted">El tipo y la unidad son listas. Si falta una, se agrega aquí.</p>
        </div>
        <button className="erp-btn-primary" disabled={busy} type="submit">
          Guardar
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <ProductFields form={form} setForm={setForm} lookups={lookups} onLookups={async () => setLookups(await listLookups())} />
    </form>
  );
}
