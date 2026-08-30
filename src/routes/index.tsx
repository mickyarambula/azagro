import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BarChart3,
  ClipboardList,
  Landmark,
  Package,
  Receipt,
  ShoppingCart,
  Star,
  Users,
  Warehouse,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { StatusPill } from "@/components/erp";
import { getDashboard } from "@/lib/azagro";
import { FlujoAzagro } from "@/components/flujo";
import { useAccess } from "@/lib/access";
import { canSeeCosts, canSeeMargins, pathModule } from "@/lib/erp/acl";
import { prevPath } from "@/lib/trail";
import { money } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

const FAVORITES = [
  { to: "/solicitudes", label: "Solicitudes", icon: ClipboardList, search: undefined },
  { to: "/purchases", label: "Pedidos de compra", icon: ClipboardList, search: { tab: "all" } },
  { to: "/sales", label: "Pedidos de venta", icon: ShoppingCart, search: { tab: "todos", q: "" } },
  { to: "/inventory", label: "Inventario", icon: Warehouse, search: undefined },
  { to: "/products", label: "Productos", icon: Package, search: { tab: "catalogo", tipo: "", q: "" } },
  { to: "/partners", label: "Contactos", icon: Users, search: { tab: "clientes", q: "" } },
  { to: "/credit", label: "Por cobrar", icon: Landmark, search: { lado: "cobrar" } },
  { to: "/credit", label: "Por pagar", icon: Landmark, search: { lado: "pagar" } },
  { to: "/vencimientos", label: "Vencimientos", icon: ClipboardList, search: undefined },
  { to: "/reportes", label: "Utilidad", icon: BarChart3, search: undefined },
  { to: "/ayuda", label: "Cómo se usa", icon: ClipboardList, search: undefined },
  { to: "/gastos", label: "Gastos", icon: Receipt, search: undefined },
  { to: "/banks", label: "Bancos", icon: Wallet, search: undefined },
] as const;

function Home() {
  const access = useAccess();
  const [data, setData] = useState<Awaited<ReturnType<typeof getDashboard>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resume, setResume] = useState<string | null>(null);

  useEffect(() => {
    getDashboard()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Error"));
    const prev = prevPath();
    if (prev && prev !== "/" && !prev.startsWith("/login")) setResume(prev);
  }, []);

  const agingOrder = ["Por vencer", "1-30", "31-60", "61+"];

  // Un atajo o una cifra sin permiso no se muestra en $0.00 — se oculta.
  // (Confunde: parece que la empresa no tiene dinero, no que falta permiso.)
  const favorites = FAVORITES.filter((f) => {
    if (f.to === "/ayuda") return true;
    if (f.to === "/reportes") return access.can("credit", "view") && canSeeMargins(access.role);
    return access.can(pathModule(f.to));
  });
  const seeCash = access.can("banks");
  const seeCredit = access.can("credit");
  const seeStockValue = canSeeCosts(access.role);

  return (
    <AppShell>
      <div className="p-5">
      <h1 className="text-[22px] font-semibold tracking-tight">Favoritos</h1>
      <p className="mt-0.5 text-sm text-muted">Atajos de trabajo. El pedido es el centro; el resto es consecuencia.</p>
      {resume ? (
        <a href={resume} className="mt-3 inline-flex min-h-10 items-center rounded-md border border-accent/30 bg-brand-soft px-3 text-sm font-medium text-forest">
          Seguir donde te quedaste
        </a>
      ) : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {favorites.map((f) => {
          const Icon = f.icon;
          return (
            <Link
              key={f.label}
              to={f.to as "/"}
              search={(f.search ?? undefined) as never}
              className="erp-card flex flex-col gap-6 p-4 transition-colors hover:border-accent/40"
            >
              <Star className="size-3.5 fill-warn text-warn" />
              <div className="mt-auto flex items-center gap-2">
                <Icon className="size-4 text-accent" />
                <span className="text-[13px] font-medium">{f.label}</span>
              </div>
            </Link>
          );
        })}
      </div>

      <div className="mt-8">
        <FlujoAzagro compact />
      </div>

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

      {(seeCash || seeCredit || seeStockValue) && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {seeCash && <Kpi label="Caja" value={data ? money(data.cash) : "—"} hint="Saldos bancarios" />}
          {seeCredit && (
            <Kpi label="Por cobrar" value={data ? money(data.ar) : "—"} hint={data?.overdueN ? `${data.overdueN} vencidas` : "Al corriente"} />
          )}
          {seeCredit && <Kpi label="Por pagar" value={data ? money(data.ap) : "—"} />}
          {seeStockValue && (
            <Kpi
              label="Inventario Azagro"
              value={data ? money(data.stockOwn) : "—"}
              hint={data ? `Proveedor ${money(data.stockSupplier)} · tránsito ${money(data.stockTransit)}` : undefined}
            />
          )}
        </div>
      )}

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {seeCredit && (
          <div className="erp-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold">Antigüedad CxC</h3>
              <Link to="/credit" search={{ lado: "cobrar" }} className="text-[12px] font-medium text-accent">
                Por cobrar
              </Link>
            </div>
            <ul className="mt-3 space-y-2 text-sm">
              {agingOrder.map((b) => {
                const amt = data?.aging.find((a) => a.bucket === b)?.amount ?? 0;
                return (
                  <li key={b} className="flex justify-between">
                    <span className="text-muted">{b}</span>
                    <span className="tabular-nums">{money(amt)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="erp-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold">Cola operativa</h3>
            <Link to="/sales" search={{ tab: "confirmed", q: "" }} className="text-[12px] font-medium text-accent">
              Pedidos
            </Link>
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex justify-between">
              <span className="text-muted">Ventas por entregar</span>
              <span className="tabular-nums">{data?.pendingSo ?? "—"}</span>
            </li>
            <li className="flex justify-between">
              <span className="text-muted">Compras por recibir</span>
              <span className="tabular-nums">{data?.pendingPo ?? "—"}</span>
            </li>
            {seeCredit && (
              <li className="flex justify-between">
                <span className="text-muted">Facturas vencidas</span>
                <span className="tabular-nums">{data?.overdueN ?? "—"}</span>
              </li>
            )}
          </ul>
        </div>
        <div className="erp-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold">Existencia por bodega</h3>
            <Link to="/inventory" className="text-[12px] font-medium text-accent">
              Inventario
            </Link>
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            {(data?.locStock ?? []).map((l) => (
              <li key={l.name} className="flex justify-between gap-2">
                <span className="truncate text-muted">
                  {l.name}
                  {l.locType === "supplier" ? " · prov." : ""}
                </span>
                {seeStockValue ? <span className="tabular-nums">{money(l.value)}</span> : <span className="tabular-nums">{l.qty}</span>}
              </li>
            ))}
            {data && data.locStock.length === 0 && <li className="text-muted">Sin ubicaciones.</li>}
          </ul>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto erp-card">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Factura reciente</th>
              <th className="px-3 py-3 font-medium">Partner</th>
              <th className="px-3 py-3 font-medium">Vence</th>
              <th className="px-3 py-3 text-right font-medium">Saldo</th>
              <th className="px-4 py-3 font-medium">Tipo</th>
            </tr>
          </thead>
          <tbody>
            {(data?.recentInv ?? []).map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="px-4 py-3 font-medium">{r.name}</td>
                <td className="px-3 py-3">{r.partner}</td>
                <td className="px-3 py-3 tabular-nums">{r.due_date}</td>
                <td className="px-3 py-3 text-right tabular-nums">{money(r.residual)}</td>
                <td className="px-4 py-3">
                  <StatusPill tone={r.kind === "customer" ? "warn" : "muted"}>
                    {r.kind === "customer" ? "CxC" : "CxP"}
                  </StatusPill>
                </td>
              </tr>
            ))}
            {data && data.recentInv.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted">
                  Aún no hay facturas. Se generan al entregar un pedido o recibir una compra.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </div>
    </AppShell>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="erp-card px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-[12px] text-muted">{hint}</p> : null}
    </div>
  );
}
