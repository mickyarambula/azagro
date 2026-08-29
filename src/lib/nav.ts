export type TabDef = { label: string; tab?: string; href?: string };
export type SectionDef = {
  to: string;
  label: string;
  starred?: boolean;
  tabs?: TabDef[];
  search?: Record<string, string>;
};
export type ModuleDef = {
  id: string;
  label: string;
  to: string;
  sections: SectionDef[];
};

export const MODULES: ModuleDef[] = [
  {
    id: "favorites",
    label: "Favoritos",
    to: "/",
    sections: [{ to: "/", label: "Inicio", starred: true }],
  },
  {
    id: "orders",
    label: "Pedidos",
    to: "/sales",
    sections: [
      {
        to: "/sales",
        label: "Pedidos de venta",
        starred: true,
        tabs: [
          { label: "Todos", tab: "todos" },
          { label: "Nuevo", tab: "nuevo", href: "/sales/nuevo" },
        ],
      },
      {
        to: "/purchases",
        label: "Pedidos de compra",
        starred: true,
        tabs: [
          { label: "Todas", tab: "all" },
          { label: "Nueva", tab: "new" },
        ],
      },
      { to: "/solicitudes", label: "Solicitudes", starred: true, tabs: [{ label: "Todas", tab: "todos" }, { label: "Nueva", tab: "nuevo", href: "/solicitudes/nuevo" }] },
      { to: "/quotes", label: "Cotizaciones", starred: true },
      { to: "/rfq", label: "Cotizar proveedores", tabs: [{ label: "Todas", tab: "todos", href: "/rfq" }, { label: "Para inventario", tab: "nuevo", href: "/rfq/nuevo" }] },
      { to: "/cpo", label: "OC del cliente" },
    ],
  },
  {
    id: "warehouse",
    label: "Almacén",
    to: "/inventory",
    sections: [
      { to: "/inventory", label: "Inventario", starred: true },
      { to: "/bodegas", label: "Bodegas", starred: true, search: { tab: "bodegas" } },
      { to: "/bodegas", label: "Destinos", starred: true, search: { tab: "destinos" } },
      { to: "/products", label: "Productos", starred: true },
    ],
  },
  {
    id: "contacts",
    label: "Contactos",
    to: "/partners",
    sections: [
      {
        to: "/partners",
        label: "Clientes",
        starred: true,
        search: { tab: "clientes", q: "" },
      },
      {
        to: "/partners",
        label: "Proveedores",
        starred: true,
        search: { tab: "proveedores", q: "" },
      },
    ],
  },
  {
    id: "finance",
    label: "Finanzas",
    to: "/credit",
    sections: [
      { to: "/credit", label: "Por cobrar", starred: true, search: { lado: "cobrar" } },
      { to: "/credit", label: "Por pagar", starred: true, search: { lado: "pagar" } },
      { to: "/vencimientos", label: "Vencimientos", starred: true },
      { to: "/cadena", label: "Cadena de crédito", starred: true },
      { to: "/statements", label: "Estados de cuenta" },
      { to: "/banks", label: "Bancos" },
      { to: "/gastos", label: "Gastos" },
      { to: "/reportes", label: "Utilidad" },
    ],
  },
  {
    id: "settings",
    label: "Ajustes",
    to: "/settings",
    sections: [
      { to: "/settings", label: "Empresa", starred: true },
      { to: "/users", label: "Equipo", starred: true },
      { to: "/settings", label: "Reglas" },
      { to: "/importar", label: "Importar / corte" },
      { to: "/bitacora", label: "Bitácora" },
      { to: "/ayuda", label: "Cómo se usa", starred: true },
    ],
  },
];

export function moduleForPath(pathname: string): ModuleDef {
  if (pathname === "/") return MODULES[0]!;
  const found = MODULES.find((m) => m.sections.some((s) => s.to !== "/" && pathname.startsWith(s.to)));
  return found ?? MODULES[0]!;
}

export function sectionForPath(pathname: string, searchStr = ""): SectionDef {
  const mod = moduleForPath(pathname);
  const tab = new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr);
  if (pathname.startsWith("/partners") && tab.get("tab") === "proveedores") {
    return mod.sections.find((s) => s.search?.tab === "proveedores") ?? mod.sections[0]!;
  }
  if (pathname.startsWith("/bodegas") && tab.get("tab") === "destinos") {
    return mod.sections.find((s) => s.search?.tab === "destinos") ?? mod.sections[0]!;
  }
  if (pathname.startsWith("/bodegas")) {
    return mod.sections.find((s) => s.to === "/bodegas" && s.search?.tab !== "destinos") ?? mod.sections[0]!;
  }
  if (pathname.startsWith("/credit") && tab.get("lado") === "pagar") {
    return mod.sections.find((s) => s.search?.lado === "pagar") ?? mod.sections[1]!;
  }
  if (pathname.startsWith("/credit")) {
    return mod.sections.find((s) => s.search?.lado === "cobrar") ?? mod.sections[0]!;
  }
  const exact = mod.sections.find((s) => (s.to === "/" ? pathname === "/" : pathname.startsWith(s.to)) && !s.search);
  if (exact) return exact;
  return mod.sections.find((s) => (s.to === "/" ? pathname === "/" : pathname.startsWith(s.to))) ?? mod.sections[0]!;
}

export function tabTone(pathname: string): "buyer" | "seller" | "light" {
  if (pathname.startsWith("/purchases")) return "buyer";
  if (pathname.startsWith("/sales") || pathname.startsWith("/quotes") || pathname.startsWith("/solicitudes") || pathname.startsWith("/cotizador")) return "seller";
  return "light";
}
