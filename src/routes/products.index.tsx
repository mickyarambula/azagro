import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CatalogSelect } from "@/components/catalog-select";
import { useAccess } from "@/lib/access";
import { listLookups, saveLookup } from "@/lib/erp/catalogs";
import { Route as ProductsRoute } from "@/routes/products";

export const Route = createFileRoute("/products/")({
  component: Page,
});

function Page() {
  const { tab } = ProductsRoute.useSearch();
  const { can } = useAccess();
  const canEdit = can("products", "edit");
  const [lookups, setLookups] = useState<Awaited<ReturnType<typeof listLookups>> | null>(null);

  useEffect(() => {
    void listLookups().then(setLookups).catch(() => setLookups(null));
  }, []);

  if (tab === "unidades" && lookups) {
    return (
      <LookupPanel
        title="Unidades de medida"
        hint="TM, KGS, LTS, ROLLOS… Si llega un producto en otra unidad, agrégala y queda en todo el sistema."
        items={lookups.uoms}
        canEdit={canEdit}
        onAdd={async (code, name) => {
          await saveLookup({ data: { kind: "uom", code, name } });
          setLookups(await listLookups());
        }}
      />
    );
  }
  if (tab === "tipos" && lookups) {
    return (
      <LookupPanel
        title="Tipos de producto"
        hint="SOLUBLE, GRANULADO, LÍQUIDO, INSUMO. Cómo se mueve, no la marca comercial."
        items={lookups.kinds}
        canEdit={canEdit}
        onAdd={async (code, name) => {
          await saveLookup({ data: { kind: "product_kind", code, name } });
          setLookups(await listLookups());
        }}
      />
    );
  }

  return (
    <div className="grid h-full min-h-[360px] place-items-center">
      <div className="text-center">
        <p className="text-[15px] font-semibold">Selecciona un producto</p>
        <p className="mt-1 max-w-sm text-sm text-muted">
          El catálogo es el producto. El inventario es la existencia en una bodega.
        </p>
      </div>
    </div>
  );
}

function LookupPanel({
  title,
  hint,
  items,
  canEdit,
  onAdd,
}: {
  title: string;
  hint: string;
  items: Array<{ id: number; code: string; name: string }>;
  canEdit: boolean;
  onAdd: (code: string, name: string) => Promise<void>;
}) {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-[20px] font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted">{hint}</p>
      <ul className="mt-4 erp-card divide-y divide-line">
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span className="font-mono text-xs">{i.code}</span>
            <span>{i.name}</span>
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="mt-4">
          <CatalogSelect label="Agregar" value="" items={[]} onChange={() => undefined} onCreate={onAdd} />
        </div>
      )}
    </div>
  );
}
