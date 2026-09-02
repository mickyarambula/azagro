import { CatalogSelect } from "@/components/catalog-select";
import { AutoCodeField } from "@/components/partner-form";
import { Field } from "@/components/erp";
import { listLookups, saveLookup } from "@/lib/erp/catalogs";

export type ProductDraft = {
  code: string;
  name: string;
  product_type: string;
  uom: string;
  cost: number;
  ref_cost: number;
  list_price: number;
  min_stock: number;
};

export function ProductFields({
  form,
  setForm,
  lookups,
  onLookups,
  canEditRefCost = false,
  costSource,
}: {
  form: ProductDraft;
  setForm: (f: ProductDraft) => void;
  lookups: Awaited<ReturnType<typeof listLookups>> | null;
  onLookups: () => Promise<void>;
  /** El costo de referencia es de administración: solo el admin lo ve y lo edita. */
  canEditRefCost?: boolean;
  costSource?: "kardex" | "referencia" | "ninguno";
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <AutoCodeField
          value={form.code}
          onChange={(code) => setForm({ ...form, code })}
          hint="Se asigna solo. Cámbialo si ya usas una clave interna (SUL-MG, MKP…)."
        />
        <Field label="Nombre">
          <input className="erp-input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <CatalogSelect
          label="Tipo"
          value={form.product_type}
          items={lookups?.kinds ?? []}
          onChange={(product_type) => setForm({ ...form, product_type })}
          onCreate={async (code, name) => {
            await saveLookup({ data: { kind: "product_kind", code, name } });
            await onLookups();
          }}
          createKind="tipo"
        />
        <CatalogSelect
          label="Unidad de medida"
          value={form.uom}
          items={lookups?.uoms ?? []}
          onChange={(uom) => setForm({ ...form, uom })}
          onCreate={async (code, name) => {
            await saveLookup({ data: { kind: "uom", code, name } });
            await onLookups();
          }}
          createKind="unidad"
        />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Costo (promedio móvil)">
          <input className="erp-input" type="number" step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: Number(e.target.value) })} />
        </Field>
        <Field label="Precio de lista">
          <input className="erp-input" type="number" step="0.01" value={form.list_price} onChange={(e) => setForm({ ...form, list_price: Number(e.target.value) })} />
        </Field>
        <Field label="Mínimo de existencia">
          <input className="erp-input" type="number" step="0.01" value={form.min_stock} onChange={(e) => setForm({ ...form, min_stock: Number(e.target.value) })} />
        </Field>
      </div>
      {canEditRefCost && (
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Costo de referencia">
            <input
              className="erp-input"
              type="number"
              step="0.01"
              min="0"
              value={form.ref_cost}
              onChange={(e) => setForm({ ...form, ref_cost: Math.max(0, Number(e.target.value)) })}
            />
          </Field>
          <p className="text-xs text-muted md:col-span-2 md:self-center">
            Para productos que nunca entran a bodega (brokeraje, directo) o que aún no se han recibido. El sistema usa el promedio móvil del kardex si existe; si no, este.
            Sin ninguno de los dos no se puede cotizar a crédito. Todo cambio queda en Bitácora.
          </p>
        </div>
      )}
      {costSource && (
        <p className="text-xs text-muted">
          Costo que está usando el sistema:{" "}
          {costSource === "kardex" ? (
            <strong>promedio móvil del kardex</strong>
          ) : costSource === "referencia" ? (
            <strong>costo de referencia</strong>
          ) : (
            <strong className="text-warn">ninguno — no se puede cotizar a crédito</strong>
          )}
          .
        </p>
      )}
      <p className="text-xs text-muted">Costo y precio se pueden dejar en cero y completarlos al cotizar o comprar.</p>
    </div>
  );
}
