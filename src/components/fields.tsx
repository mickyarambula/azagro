import { useEffect, useState } from "react";
import { UOM_CATALOG } from "@/lib/erp/catalog";
import { cn } from "@/lib/utils";

function sanitizeDecimal(raw: string) {
  const v = raw.replace(",", ".").replace(/[^\d.]/g, "");
  const parts = v.split(".");
  if (parts.length <= 1) return v;
  return `${parts[0]}.${parts.slice(1).join("")}`;
}

export function QtyField({
  value,
  onChange,
  onCommit,
  disabled,
  className,
}: {
  value: number;
  /** Se llama en cada tecla — úsalo solo para reflejo local (cálculo en vivo, borrador). */
  onChange?: (n: number) => void;
  /** Se llama al terminar de escribir (salir del campo o Enter) — úsalo para guardar. */
  onCommit?: (n: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [raw, setRaw] = useState(value ? String(value) : "");
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    if (!focus) setRaw(value ? String(value) : "");
  }, [value, focus]);

  function parsed() {
    return raw === "" || raw === "." ? 0 : Number(raw);
  }

  return (
    <input
      className={cn("erp-input w-24 text-right tabular-nums", className)}
      inputMode="decimal"
      disabled={disabled}
      value={raw}
      placeholder="0"
      onFocus={() => setFocus(true)}
      onChange={(e) => {
        const next = sanitizeDecimal(e.target.value);
        setRaw(next);
        if (onChange) onChange(next === "" || next === "." ? 0 : Number(next));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      onBlur={() => {
        setFocus(false);
        onCommit?.(parsed());
        setRaw(value ? String(value) : "");
      }}
    />
  );
}

export function MoneyField({
  value,
  onChange,
  onCommit,
  disabled,
  className,
  placeholder = "0.00",
}: {
  value: number;
  /** Se llama en cada tecla — úsalo solo para reflejo local (cálculo en vivo, borrador). */
  onChange?: (n: number) => void;
  /** Se llama al terminar de escribir (salir del campo o Enter) — úsalo para guardar. */
  onCommit?: (n: number) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState(value ? String(value) : "");
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    if (!focus) setRaw(value ? String(value) : "");
  }, [value, focus]);

  function parsed() {
    return raw === "" || raw === "." ? 0 : Number(raw);
  }

  return (
    <input
      className={cn("erp-input w-28 text-right tabular-nums", className)}
      inputMode="decimal"
      disabled={disabled}
      value={raw}
      placeholder={placeholder}
      onFocus={() => setFocus(true)}
      onChange={(e) => {
        const next = sanitizeDecimal(e.target.value);
        setRaw(next);
        if (onChange) onChange(next === "" || next === "." ? 0 : Number(next));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      onBlur={() => {
        setFocus(false);
        onCommit?.(parsed());
        setRaw(value ? String(value) : "");
      }}
    />
  );
}

export function UomSelect({
  value,
  onChange,
  disabled,
  extra,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  extra?: string;
}) {
  const codes = UOM_CATALOG.map((u) => u.code);
  const list = extra && !codes.includes(extra) ? [{ code: extra, name: extra }, ...UOM_CATALOG] : UOM_CATALOG;
  return (
    <select className="erp-input w-[7.5rem]" disabled={disabled} value={value || list[0]?.code} onChange={(e) => onChange(e.target.value)}>
      {list.map((u) => (
        <option key={u.code} value={u.code}>
          {u.code}
        </option>
      ))}
    </select>
  );
}
