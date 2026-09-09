export type TabDef = { label: string; tab?: string; href?: string };
export type SectionDef = {
  to: string;
  label: string;
  /** Clave estable de la sección: es lo que se marca como favorito (member_favorites.section_key). */
  key: string;
  tabs?: TabDef[];
  search?: Record<string, string>;
};
export type ModuleDef = {
  id: string;
  label: string;
  to: string;
  sections: SectionDef[];
};

/**
 * BLOQUE DE DISEÑO, parte 1 (9-sep-2026): el menú coincide con la taxonomía
 * de permisos (acl.ts MODULES). Antes había dos mapas del mismo territorio:
 * "Pedidos / Almacén / Contactos / Finanzas / Ajustes" aquí y "Cotizaciones /
 * Ventas / Compras / Inventario / Cartera / …" en permisos.
 *
 * Ninguna ruta cambió de dirección: solo cambia bajo qué módulo aparece cada
 * sección. Los permisos no se tocan (app-shell decide qué mostrar por
 * pathModule de cada ruta, igual que antes).
 *
 * Entregas, recepciones, kardex, facturas, cobros y pagos NO son rutas: son
 * acciones dentro de una pantalla. El menú apunta a donde viven.
 */
export const MODULES: ModuleDef[] = [
  {
    id: "home",
    label: "Inicio",
    to: "/",
    sections: [{ to: "/", label: "Inicio", key: "home" }],
  },
  {
    id: "sales",
    label: "Ventas",
    to: "/sales",
    sections: [
      { to: "/solicitudes", label: "Solicitudes", key: "solicitudes", tabs: [{ label: "Todas", tab: "todos" }, { label: "Nueva", tab: "nuevo", href: "/solicitudes/nuevo" }] },
      { to: "/quotes", label: "Cotizaciones", key: "quotes" },
      {
        to: "/sales",
        label: "Pedidos de venta",
        key: "sales",
        tabs: [
          { label: "Todos", tab: "todos" },
          { label: "Nuevo", tab: "nuevo", href: "/sales/nuevo" },
        ],
      },
      { to: "/cpo", label: "OC del cliente", key: "cpo" },
    ],
  },
  {
    id: "purchases",
    label: "Compras",
    to: "/purchases",
    sections: [
      { to: "/rfq", label: "Cotizar proveedores", key: "rfq", tabs: [{ label: "Todas", tab: "todos", href: "/rfq" }, { label: "Para inventario", tab: "nuevo", href: "/rfq/nuevo" }] },
      {
        to: "/purchases",
        label: "Pedidos de compra",
        key: "purchases",
        tabs: [
          { label: "Todas", tab: "all" },
          { label: "Nueva", tab: "new" },
        ],
      },
    ],
  },
  {
    id: "warehouse",
    label: "Almacén",
    to: "/inventory",
    sections: [
      { to: "/inventory", label: "Inventario", key: "inventory" },
      { to: "/bodegas", label: "Bodegas", key: "bodegas", search: { tab: "bodegas" } },
      { to: "/products", label: "Productos", key: "products" },
    ],
  },
  {
    id: "credit",
    label: "Cartera",
    to: "/credit",
    sections: [
      { to: "/credit", label: "Por cobrar", key: "credit-cobrar", search: { lado: "cobrar" } },
      { to: "/credit", label: "Por pagar", key: "credit-pagar", search: { lado: "pagar" } },
      { to: "/statements", label: "Estados de cuenta", key: "statements" },
      { to: "/banks", label: "Bancos", key: "banks" },
      { to: "/gastos", label: "Gastos", key: "gastos" },
    ],
  },
  {
    id: "contacts",
    label: "Contactos",
    to: "/partners",
    sections: [
      { to: "/partners", label: "Clientes", key: "clientes", search: { tab: "clientes", q: "" } },
      { to: "/partners", label: "Proveedores", key: "proveedores", search: { tab: "proveedores", q: "" } },
      // Los destinos son del cliente (la ficha del cliente ya los captura y
      // deleteLocation pide permiso de Contactos): se buscan aquí, no en
      // Almacén. La ruta y el permiso no cambian.
      { to: "/bodegas", label: "Destinos", key: "destinos", search: { tab: "destinos" } },
    ],
  },
  {
    id: "reports",
    label: "Reportes",
    to: "/reportes",
    sections: [
      { to: "/reportes", label: "Utilidad y Panorama", key: "reportes" },
      { to: "/vencimientos", label: "Vencimientos", key: "vencimientos" },
      { to: "/cadena", label: "Cadena de crédito", key: "cadena" },
    ],
  },
  {
    id: "settings",
    label: "Ajustes",
    to: "/settings",
    sections: [
      { to: "/settings", label: "Configuración", key: "settings" },
      { to: "/users", label: "Equipo", key: "users" },
      { to: "/importar", label: "Importar / corte", key: "importar" },
      { to: "/bitacora", label: "Bitácora", key: "bitacora" },
      { to: "/ayuda", label: "Cómo se usa", key: "ayuda" },
    ],
  },
];

/** Sección por su clave estable (la que se guarda en member_favorites). */
export function sectionByKey(key: string): SectionDef | undefined {
  for (const m of MODULES) {
    const s = m.sections.find((x) => x.key === key);
    if (s) return s;
  }
  return undefined;
}

function tabOf(searchStr: string) {
  return new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr).get("tab");
}

/**
 * Módulo activo. `/bodegas` vive en dos módulos según el `tab` (Bodegas en
 * Almacén, Destinos en Contactos): sin mirar el parámetro, las dos caerían en
 * el primero del arreglo.
 */
export function moduleForPath(pathname: string, searchStr = ""): ModuleDef {
  if (pathname === "/") return MODULES[0]!;
  if (pathname.startsWith("/bodegas")) {
    const tab = tabOf(searchStr) || "bodegas";
    const found = MODULES.find((m) => m.sections.some((s) => s.to === "/bodegas" && s.search?.tab === tab));
    if (found) return found;
  }
  const found = MODULES.find((m) => m.sections.some((s) => s.to !== "/" && pathname.startsWith(s.to)));
  return found ?? MODULES[0]!;
}

export function sectionForPath(pathname: string, searchStr = ""): SectionDef {
  const mod = moduleForPath(pathname, searchStr);
  const tab = new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr);
  if (pathname.startsWith("/partners") && tab.get("tab") === "proveedores") {
    return mod.sections.find((s) => s.search?.tab === "proveedores") ?? mod.sections[0]!;
  }
  if (pathname.startsWith("/bodegas")) {
    const t = tab.get("tab") || "bodegas";
    return mod.sections.find((s) => s.to === "/bodegas" && s.search?.tab === t) ?? mod.sections[0]!;
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
