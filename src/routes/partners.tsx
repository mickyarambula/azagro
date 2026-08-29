import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { useAccess } from "@/lib/access";
import { listPartners } from "@/lib/azagro";
import { cn, money, num } from "@/lib/utils";

type Tab = "clientes" | "proveedores";

export const Route = createFileRoute("/partners")({
  validateSearch: (s: Record<string, unknown>): { tab: Tab; q: string; tipo?: "cliente" | "proveedor" } => ({
    tab: s.tab === "proveedores" ? "proveedores" : "clientes",
    q: typeof s.q === "string" ? s.q : "",
    tipo: s.tipo === "proveedor" ? "proveedor" : s.tipo === "cliente" ? "cliente" : undefined,
  }),
  component: Layout,
});

function letterOf(name: string) {
  const c = (name || "?").trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}

function Layout() {
  const { tab, q } = Route.useSearch();
  const navigate = useNavigate({ from: "/partners" });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { can } = useAccess();
  const canEdit = can("partners", "edit");
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listPartners>>>([]);

  useEffect(() => {
    void listPartners().then(setRows).catch(() => setRows([]));
  }, [pathname]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows
      .filter((r) => (tab === "proveedores" ? r.is_supplier : r.is_customer))
      .filter((r) => {
        if (!term) return true;
        return [r.code, r.name, r.legal_name, r.rfc, r.group_name, r.city, r.email, r.phone].join(" ").toLowerCase().includes(term);
      })
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [rows, tab, q]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const r of filtered) {
      const L = letterOf(r.name);
      const arr = map.get(L) ?? [];
      arr.push(r);
      map.set(L, arr);
    }
    return [...map.entries()];
  }, [filtered]);

  const selectedId = pathname.match(/\/partners\/(\d+)/)?.[1];
  const isCliente = tab !== "proveedores";

  return (
    <AppShell flush>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-cream px-4">
        <div className="flex">
          {(
            [
              ["clientes", "Clientes"],
              ["proveedores", "Proveedores"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="erp-tab"
              data-on={tab === id}
              onClick={() => navigate({ to: "/partners", search: { tab: id, q } })}
            >
              {label}
            </button>
          ))}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Link
              to="/partners/nuevo"
              search={{ tipo: isCliente ? "cliente" : "proveedor", tab, q }}
              className="erp-btn-primary grid place-items-center"
            >
              + Alta
            </Link>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-line bg-cream">
          <div className="border-b border-line p-3">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input
                className="erp-input w-full pl-8"
                placeholder="Buscar"
                value={q}
                onChange={(e) => navigate({ search: { tab, q: e.target.value } })}
              />
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {groups.map(([L, items]) => (
              <div key={L}>
                <p className="sticky top-0 bg-paper px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {L}
                </p>
                {items.map((r) => {
                  const on = selectedId === String(r.id);
                  return (
                    <Link
                      key={r.id}
                      to="/partners/$partnerId"
                      params={{ partnerId: String(r.id) }}
                      search={{ tab, q }}
                      className={cn("block border-l-2 px-3 py-2.5", on ? "border-accent bg-paper" : "border-transparent hover:bg-paper")}
                    >
                      <p className="truncate text-[13px] font-medium">{r.name}</p>
                      <p className="truncate text-[12px] text-muted">
                        {r.code}
                        {num(r.ar) || num(r.ap) ? ` · ${money(isCliente ? r.ar : r.ap)}` : ""}
                      </p>
                    </Link>
                  );
                })}
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted">
                {rows.length === 0 ? "Nadie dado de alta todavía." : "Nada coincide."}
              </p>
            )}
          </div>
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto bg-paper p-6">
          <Outlet />
        </section>
      </div>
    </AppShell>
  );
}
