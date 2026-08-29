import { useState } from "react";
import { CatalogSelect } from "@/components/catalog-select";
import { Field } from "@/components/erp";
import { cn } from "@/lib/utils";

export type PartnerDraft = {
  code: string;
  name: string;
  legal_name: string;
  rfc: string;
  group_name: string;
  city: string;
  address: string;
  email: string;
  phone: string;
  notes: string;
  credit_limit: number;
  payment_days: number;
  late_rate: number;
  is_customer: boolean;
  is_supplier: boolean;
};

export function KindChips({ customer, supplier }: { customer: boolean; supplier: boolean }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {customer && <span className="erp-chip erp-chip-client">Cliente</span>}
      {supplier && <span className="erp-chip erp-chip-supplier">Proveedor</span>}
    </span>
  );
}

export function AutoCodeField({
  value,
  onChange,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  hint: string;
}) {
  const [locked, setLocked] = useState(true);
  return (
    <div className="grid gap-1">
      <span className="text-[12px] font-medium uppercase tracking-wide text-muted">Código</span>
      <div className="flex gap-2">
        <input
          className={cn("erp-input flex-1 font-mono", locked && "bg-paper")}
          value={value}
          readOnly={locked}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
        <button type="button" className="erp-btn shrink-0" onClick={() => setLocked((v) => !v)}>
          {locked ? "Editar" : "Listo"}
        </button>
      </div>
      <span className="text-xs text-muted">{hint}</span>
    </div>
  );
}

export function PartnerFields({
  form,
  setForm,
  showKind = true,
  groups = [],
  onCreateGroup,
}: {
  form: PartnerDraft;
  setForm: (f: PartnerDraft) => void;
  showKind?: boolean;
  groups?: Array<{ code: string; name: string }>;
  onCreateGroup?: (code: string, name: string) => Promise<void>;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Nombre comercial" className="md:col-span-1">
          <input className="erp-input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Teléfono">
          <input className="erp-input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Correo">
          <input className="erp-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Razón social" className="md:col-span-2">
          <input className="erp-input" value={form.legal_name} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} />
        </Field>
        <Field label="RFC">
          <input className="erp-input uppercase" value={form.rfc} onChange={(e) => setForm({ ...form, rfc: e.target.value.toUpperCase() })} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <p className="text-muted">
          Este registro está <span className="font-semibold text-ok">activo</span>
        </p>
        {showKind && (
          <>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.is_customer} onChange={(e) => setForm({ ...form, is_customer: e.target.checked })} />
              Cliente
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.is_supplier} onChange={(e) => setForm({ ...form, is_supplier: e.target.checked })} />
              Proveedor
            </label>
          </>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Plazo sugerido (días)">
          <input
            className="erp-input"
            type="number"
            min={0}
            value={form.payment_days}
            onChange={(e) => setForm({ ...form, payment_days: Number(e.target.value) })}
          />
        </Field>
        <AutoCodeField
          value={form.code}
          onChange={(code) => setForm({ ...form, code })}
          hint="Se asigna solo. Puedes cambiarlo."
        />
        <Field label="Límite de crédito">
          <input
            className="erp-input"
            type="number"
            min={0}
            value={form.credit_limit}
            onChange={(e) => setForm({ ...form, credit_limit: Number(e.target.value) })}
          />
        </Field>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {onCreateGroup ? (
          <CatalogSelect
            label="Grupo"
            value={form.group_name}
            items={groups.map((g) => ({ code: g.name || g.code, name: g.name || g.code }))}
            onChange={(group_name) => setForm({ ...form, group_name })}
            onCreate={onCreateGroup}
            createKind="grupo"
          />
        ) : (
          <Field label="Grupo">
            <input className="erp-input" placeholder="Ej. Grupo SL" value={form.group_name} onChange={(e) => setForm({ ...form, group_name: e.target.value })} />
          </Field>
        )}
        <Field label="Ciudad">
          <input className="erp-input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </Field>
        <Field label="Mora anual %">
          <input
            className="erp-input"
            type="number"
            step="0.01"
            value={form.late_rate}
            onChange={(e) => setForm({ ...form, late_rate: Number(e.target.value) })}
          />
        </Field>
      </div>

      <Field label="Dirección">
        <input className="erp-input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
      </Field>
      <Field label="Notas">
        <textarea
          className="erp-input h-24 py-2"
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </Field>
      <p className="text-xs text-muted">
        El plazo de la ficha es una sugerencia. En cada pedido se pacta contado, días, fecha o cosecha.
      </p>
    </div>
  );
}
