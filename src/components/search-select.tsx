import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type SearchOpt = { value: string; label: string; hint?: string };

export function SearchSelect({
  value,
  options,
  onChange,
  placeholder = "Buscar…",
  disabled,
  allowEmpty,
  emptyLabel = "—",
  onCreate,
  className,
  bare,
}: {
  value: string;
  options: SearchOpt[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  allowEmpty?: boolean;
  emptyLabel?: string;
  onCreate?: (query: string) => void;
  className?: string;
  bare?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState({ top: 0, left: 0, width: 240 });
  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = !s
      ? options
      : options.filter((o) => `${o.label} ${o.hint ?? ""} ${o.value}`.toLowerCase().includes(s));
    return base.slice(0, 80);
  }, [options, q]);

  function place() {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 260) });
  }

  useEffect(() => {
    if (!open) return;
    place();
    function onDoc(e: MouseEvent) {
      if (!box.current?.contains(e.target as Node)) {
        const drop = document.getElementById("az-search-drop");
        if (drop && drop.contains(e.target as Node)) return;
        setOpen(false);
        setQ("");
      }
    }
    function onScroll() {
      place();
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const showCreate = Boolean(onCreate && q.trim() && !options.some((o) => o.label.toLowerCase() === q.trim().toLowerCase()));

  return (
    <div ref={box} className={cn("relative", className)}>
      <input
        className={cn("erp-input w-full", bare && "border-0 bg-transparent px-0 shadow-none")}
        disabled={disabled}
        placeholder={placeholder}
        value={open ? q : selected?.label ?? ""}
        onFocus={() => {
          if (disabled) return;
          setQ("");
          setOpen(true);
          place();
        }}
        onChange={(e) => {
          setQ(e.target.value);
          if (!open) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setQ("");
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (filtered[0]) {
              onChange(filtered[0].value);
              setOpen(false);
              setQ("");
            } else if (showCreate && onCreate) {
              onCreate(q.trim());
              setOpen(false);
              setQ("");
            }
          }
        }}
      />
      {open && !disabled && (
        <div
          id="az-search-drop"
          className="fixed z-50 max-h-64 overflow-auto rounded-lg border border-line bg-cream shadow-lg"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {allowEmpty && (
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-[13px] text-muted hover:bg-paper"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange("");
                setOpen(false);
                setQ("");
              }}
            >
              {emptyLabel}
            </button>
          )}
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              className={cn(
                "block w-full px-3 py-2 text-left text-[13px] hover:bg-paper",
                o.value === value && "bg-brand-soft",
              )}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
                setQ("");
              }}
            >
              <span className="font-medium">{o.label}</span>
              {o.hint ? <span className="ml-2 text-[11px] text-muted">{o.hint}</span> : null}
            </button>
          ))}
          {filtered.length === 0 && !showCreate && <p className="px-3 py-2 text-[12px] text-muted">Sin coincidencias</p>}
          {showCreate && (
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-[13px] font-semibold text-accent hover:bg-paper"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onCreate?.(q.trim());
                setOpen(false);
                setQ("");
              }}
            >
              + Agregar «{q.trim()}»
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function asOpts<T>(
  rows: T[] | undefined,
  value: (r: T) => string | number,
  label: (r: T) => string,
  hint?: (r: T) => string | undefined,
): SearchOpt[] {
  return (rows ?? []).map((r) => ({
    value: String(value(r)),
    label: label(r),
    hint: hint?.(r),
  }));
}
