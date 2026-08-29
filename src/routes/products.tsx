import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { useAccess } from "@/lib/access";
import { listProducts } from "@/lib/azagro";
import { cn, num, qty } from "@/lib/utils";

type Tab = "catalogo" | "unidades" | "tipos";

export const Route = createFileRoute("/products")({
  validateSearch: (s: Record<string, unknown>): { tab: Tab; tipo: string; q: string } => ({
    tab: s.tab === "unidades" || s.tab === "tipos" ? s.tab : "catalogo",
    tipo: typeof s.tipo === "string" ? s.tipo : "",
    q: typeof s.q === "string" ? s.q : "",
  }),
  component: Layout,
});

function Layout() {
  const { tab, tipo, q } = Route.useSearch();
  const navigate = useNavigate({ from: "/products" });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { can } = useAccess();
  const canEdit = can("products", "edit");
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listProducts>>>([]);

  useEffect(() => {
    void listProducts().then(setRows).catch(() => setRows([]));
  }, [pathname]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows
      .filter((r) => !tipo || r.product_type === tipo)
      .filter((r) => {
        if (!term) return true;
        return [r.code, r.name, r.product_type, r.uom].join(" ").toLowerCase().includes(term);
      });
  }, [rows, tipo, q]);

  const selectedId = pathname.match(/\/products\/(\d+)/)?.[1];
  const split = tab === "catalogo";

  return (
    <AppShell flush>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-cream px-4">
        <div className="flex">
          {(
            [
              ["catalogo", "Catálogo"],
              ["unidades", "Unidades"],
              ["tipos", "Tipos"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="erp-tab"
              data-on={tab === id}
              onClick={() => navigate({ to: "/products", search: { tab: id, tipo: id === "catalogo" ? tipo : "", q } })}
            >
              {label}
            </button>
          ))}
        </div>
        {canEdit && tab === "catalogo" && (
          <Link to="/products/nuevo" search={{ tab: "catalogo", tipo, q }} className="erp-btn-primary grid place-items-center">
            + Alta
          </Link>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {split && (
          <aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-cream">
            <div className="border-b border-line p-3">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <input
                  className="erp-input w-full pl-8"
                  placeholder="Buscar"
                  value={q}
                  onChange={(e) => navigate({ search: { tab, tipo, q: e.target.value } })}
                />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {filtered.map((r) => {
                const on = selectedId === String(r.id);
                const low = num(r.min_stock) > 0 && num(r.on_hand) < num(r.min_stock);
                return (
                  <Link
                    key={r.id}
                    to="/products/$productId"
                    params={{ productId: String(r.id) }}
                    search={{ tab: "catalogo", tipo, q }}
                    className={cn("block border-l-2 px-3 py-2.5", on ? "border-accent bg-paper" : "border-transparent hover:bg-paper")}
                  >
                    <p className="truncate text-[13px] font-medium">{r.name}</p>
                    <p className={cn("truncate text-[12px] text-muted", low && "text-danger")}>
                      {r.code} · {qty(r.on_hand)} {r.uom}
                    </p>
                  </Link>
                );
              })}
              {filtered.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">Nada en el catálogo.</p>}
            </div>
          </aside>
        )}
        <section className="min-w-0 flex-1 overflow-y-auto bg-paper p-6">
          <Outlet />
        </section>
      </div>
    </AppShell>
  );
}
