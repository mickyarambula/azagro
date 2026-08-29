import { useState } from "react";
import { Field } from "@/components/erp";

export function CatalogSelect({
  label,
  value,
  items,
  onChange,
  onCreate,
  createKind,
}: {
  label: string;
  value: string;
  items: Array<{ code: string; name: string }>;
  onChange: (code: string) => void;
  onCreate: (code: string, name: string) => Promise<void>;
  createKind?: string;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Field label={label}>
      <div className="flex gap-2">
        <select className="erp-input flex-1" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {items.map((i) => (
            <option key={i.code} value={i.code}>
              {i.code}
              {i.name && i.name !== i.code ? ` · ${i.name}` : ""}
            </option>
          ))}
        </select>
        <button type="button" className="erp-btn shrink-0" onClick={() => setOpen((v) => !v)}>
          +
        </button>
      </div>
      {open && (
        <div className="mt-2 grid gap-2 rounded-md border border-line bg-paper p-2 sm:grid-cols-3">
          <input className="erp-input font-mono" placeholder="Clave" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <input className="erp-input" placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            type="button"
            className="erp-btn-primary"
            disabled={busy || !code.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const c = code.trim().toUpperCase();
                await onCreate(c, name.trim() || c);
                onChange(c);
                setCode("");
                setName("");
                setOpen(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            Agregar {createKind ?? ""}
          </button>
        </div>
      )}
    </Field>
  );
}
