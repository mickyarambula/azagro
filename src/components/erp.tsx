import type { FormEvent, ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { prevPath } from "@/lib/trail";

export function PageHead({
  title,
  hint,
  actions,
}: {
  title: string;
  hint?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
      </div>
      {actions}
    </div>
  );
}

/** Volver a la pantalla anterior, o a la lista si no hay historial. */
export function BackBar({
  to,
  label,
  search,
}: {
  to: string;
  label: string;
  search?: Record<string, string>;
}) {
  const router = useRouter();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
      <button
        type="button"
        className="inline-flex min-h-9 items-center gap-1.5 font-medium text-accent hover:underline"
        onClick={() => {
          const prev = prevPath();
          if (prev && prev !== `${window.location.pathname}${window.location.search}`) {
            router.history.back();
            return;
          }
          void router.navigate({ to: to as "/", search: (search ?? {}) as never });
        }}
      >
        <ArrowLeft className="size-4" />
        Volver
      </button>
      <span className="text-line">·</span>
      <Link to={to as "/"} search={(search ?? {}) as never} className="text-muted hover:text-ink hover:underline">
        {label}
      </Link>
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("erp-card p-4", className)}>{children}</div>;
}

export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("grid gap-1 text-[12px] font-medium uppercase tracking-wide text-muted", className)}>
      {label}
      {children}
    </label>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto erp-card">{children}</div>;
}

export function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <th className={cn("px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted", right && "text-right")}>
      {children}
    </th>
  );
}

export function Td({ children, right, className }: { children: ReactNode; right?: boolean; className?: string }) {
  return (
    <td className={cn("px-3 py-2.5", right && "text-right tabular-nums", className)}>{children}</td>
  );
}

export function FormGrid({
  onSubmit,
  children,
}: {
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} className="mb-5 grid gap-3 erp-card p-4 md:grid-cols-4">
      {children}
    </form>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "danger" | "muted";
  children: ReactNode;
}) {
  const cls =
    tone === "ok"
      ? "bg-ok/10 text-ok"
      : tone === "warn"
        ? "bg-warn/10 text-warn"
        : tone === "danger"
          ? "bg-danger/10 text-danger"
          : "bg-paper-2 text-muted";
  return (
    <span className={cn("inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-semibold", cls)}>
      {children}
    </span>
  );
}

export function FinanceNav({
  current,
}: {
  current: "cobrar" | "pagar" | "vencimientos" | "statements" | "banks" | "gastos" | "cadena" | "reportes";
}) {
  const items = [
    { to: "/credit", search: { lado: "cobrar" }, id: "cobrar" as const, label: "Por cobrar" },
    { to: "/credit", search: { lado: "pagar" }, id: "pagar" as const, label: "Por pagar" },
    { to: "/vencimientos", search: undefined, id: "vencimientos" as const, label: "Vencimientos" },
    { to: "/cadena", search: undefined, id: "cadena" as const, label: "Cadena" },
    { to: "/statements", search: undefined, id: "statements" as const, label: "Estados de cuenta" },
    { to: "/banks", search: undefined, id: "banks" as const, label: "Bancos" },
    { to: "/gastos", search: undefined, id: "gastos" as const, label: "Gastos" },
    { to: "/reportes", search: undefined, id: "reportes" as const, label: "Utilidad" },
  ];
  return (
    <div className="mb-4 flex flex-wrap border-b border-line">
      {items.map((i) => (
        <Link
          key={i.id}
          to={i.to as "/credit"}
          search={(i.search ?? {}) as never}
          className="erp-tab"
          data-on={current === i.id}
        >
          {i.label}
        </Link>
      ))}
    </div>
  );
}

export function OrdersNav({ current }: { current: "quotes" | "sales" | "purchases" }) {
  const items = [
    { to: "/quotes", id: "quotes" as const, label: "Cotizaciones" },
    { to: "/sales", id: "sales" as const, label: "Pedidos de venta" },
    { to: "/purchases", id: "purchases" as const, label: "Pedidos de compra" },
  ];
  return (
    <div className="mb-4 flex border-b border-line">
      {items.map((i) => (
        <Link
          key={i.id}
          to={i.to as "/sales"}
          search={i.id === "sales" ? ({ tab: "todos", q: "" } as never) : (undefined as never)}
          className="erp-tab"
          data-on={current === i.id}
        >
          {i.label}
        </Link>
      ))}
    </div>
  );
}

export function ModuleBar({
  items,
  current,
}: {
  items: Array<{ id: string; label: string; to: string; search?: Record<string, string> }>;
  current: string;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center bg-brand px-2 text-white">
      {items.map((i) => (
        <Link
          key={i.id}
          to={i.to as "/"}
          search={i.search as never}
          className={cn(
            "flex h-11 items-center px-4 text-[13px] font-medium",
            current === i.id ? "bg-white/15" : "text-white/80 hover:bg-white/10 hover:text-white",
          )}
        >
          {i.label}
        </Link>
      ))}
    </div>
  );
}

export function HeadBox({
  label,
  action,
  children,
  className,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("erp-card px-3 py-2.5", className)}>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

