import type { getSql } from "@/lib/db";

type Sql = Awaited<ReturnType<typeof getSql>>;

export const MODULES = [
  { id: "dashboard", label: "Tablero" },
  { id: "quotes", label: "Cotizaciones" },
  { id: "sales", label: "Ventas" },
  { id: "purchases", label: "Compras" },
  { id: "inventory", label: "Inventario" },
  { id: "credit", label: "Cartera" },
  { id: "gastos", label: "Gastos" },
  { id: "banks", label: "Bancos" },
  { id: "statements", label: "Estados de cuenta" },
  { id: "partners", label: "Contactos" },
  { id: "products", label: "Productos" },
  { id: "settings", label: "Configuración" },
  { id: "users", label: "Usuarios" },
] as const;

export type ModuleId = (typeof MODULES)[number]["id"];
export type AclLevel = "none" | "view" | "edit";
export type AppRole =
  | "admin"
  | "gerencia"
  | "administracion"
  | "ventas"
  | "compras"
  | "almacen"
  | "cobranza"
  | "consulta";

export const ROLE_META: Record<AppRole, { label: string; hint: string; ownOnly: boolean }> = {
  admin: {
    label: "Administrador del sistema",
    hint: "Usuarios, permisos y toda la operación.",
    ownOnly: false,
  },
  gerencia: {
    label: "Gerencia",
    hint: "Ve y edita operación y finanzas. Usuarios en consulta.",
    ownOnly: false,
  },
  administracion: {
    label: "Administración",
    hint: "Cartera, bancos, estados de cuenta y catálogos.",
    ownOnly: false,
  },
  ventas: {
    label: "Ventas / CRM",
    hint: "Cotiza y vende. Solo ve sus clientes si se marca cartera propia.",
    ownOnly: true,
  },
  compras: {
    label: "Compras",
    hint: "Órdenes, proveedores e ingresos a almacén.",
    ownOnly: false,
  },
  almacen: {
    label: "Almacén",
    hint: "Existencias, recepciones y entregas.",
    ownOnly: false,
  },
  cobranza: {
    label: "Cobranza",
    hint: "Cartera, pagos y estados de cuenta.",
    ownOnly: false,
  },
  consulta: {
    label: "Solo consulta",
    hint: "Ve módulos operativos, no edita.",
    ownOnly: false,
  },
};

const ALL_EDIT = Object.fromEntries(MODULES.map((m) => [m.id, "edit"])) as Record<ModuleId, AclLevel>;
const ALL_VIEW = Object.fromEntries(MODULES.map((m) => [m.id, "view"])) as Record<ModuleId, AclLevel>;

export function templateAcl(role: AppRole): Record<ModuleId, AclLevel> {
  if (role === "admin") return { ...ALL_EDIT };
  if (role === "gerencia") return { ...ALL_EDIT, users: "view" };
  if (role === "consulta") return { ...ALL_VIEW, settings: "none", users: "none" };
  if (role === "administracion") {
    return {
      dashboard: "view",
      quotes: "view",
      sales: "view",
      purchases: "view",
      inventory: "view",
      credit: "edit",
      gastos: "edit",
      banks: "edit",
      statements: "edit",
      partners: "edit",
      products: "view",
      settings: "view",
      users: "none",
    };
  }
  if (role === "ventas") {
    return {
      dashboard: "view",
      quotes: "edit",
      sales: "edit",
      purchases: "none",
      inventory: "view",
      credit: "view",
      gastos: "view",
      banks: "none",
      statements: "view",
      partners: "edit",
      products: "view",
      settings: "none",
      users: "none",
    };
  }
  if (role === "compras") {
    return {
      dashboard: "view",
      quotes: "none",
      sales: "none",
      purchases: "edit",
      inventory: "edit",
      credit: "view",
      gastos: "edit",
      banks: "none",
      statements: "none",
      partners: "edit",
      products: "edit",
      settings: "none",
      users: "none",
    };
  }
  if (role === "almacen") {
    return {
      dashboard: "view",
      quotes: "none",
      sales: "edit",
      purchases: "edit",
      inventory: "edit",
      credit: "none",
      gastos: "none",
      banks: "none",
      statements: "none",
      partners: "view",
      products: "view",
      settings: "none",
      users: "none",
    };
  }
  return {
    dashboard: "view",
    quotes: "none",
    sales: "view",
    purchases: "none",
    inventory: "none",
    credit: "edit",
    gastos: "view",
    banks: "edit",
    statements: "edit",
    partners: "view",
    products: "view",
    settings: "none",
    users: "none",
  };
}

export function pathModule(pathname: string): ModuleId {
  if (pathname.startsWith("/cpo")) return "sales";
  if (pathname.startsWith("/solicitudes")) return "quotes";
  if (pathname.startsWith("/cotizador")) return "quotes";
  if (pathname.startsWith("/rfq")) return "purchases";
  if (pathname.startsWith("/sales")) return "sales";
  if (pathname.startsWith("/purchases")) return "purchases";
  if (pathname.startsWith("/inventory")) return "inventory";
  if (pathname.startsWith("/bodegas")) return "inventory";
  if (pathname.startsWith("/credit")) return "credit";
  if (pathname.startsWith("/cadena")) return "credit";
  if (pathname.startsWith("/vencimientos")) return "credit";
  if (pathname.startsWith("/gastos")) return "gastos";
  if (pathname.startsWith("/banks")) return "banks";
  if (pathname.startsWith("/statements")) return "statements";
  if (pathname.startsWith("/reportes")) return "credit";
  if (pathname.startsWith("/partners")) return "partners";
  if (pathname.startsWith("/products")) return "products";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/importar")) return "settings";
  if (pathname.startsWith("/bitacora")) return "settings";
  if (pathname.startsWith("/users")) return "users";
  if (pathname.startsWith("/ayuda")) return "dashboard";
  return "dashboard";
}

export function isAppRole(v: string): v is AppRole {
  return v in ROLE_META;
}

export async function seedAcl(sql: Sql, memberId: number, role: AppRole) {
  const acl = templateAcl(role);
  for (const m of MODULES) {
    await sql`
      insert into member_acl (member_id, module, level)
      values (${memberId}, ${m.id}, ${acl[m.id]})
      on conflict (member_id, module) do update set level = excluded.level
    `;
  }
}

export async function loadAcl(sql: Sql, memberId: number, role: string) {
  const rows = await sql<{ module: string; level: AclLevel }>`
    select module, level from member_acl where member_id = ${memberId}
  `;
  const base = templateAcl(isAppRole(role) ? role : "consulta");
  for (const r of rows) {
    if (r.module in base) base[r.module as ModuleId] = r.level;
  }
  return base;
}

export async function assertCan(sql: Sql, userId: string, module: ModuleId, need: AclLevel) {
  const m = await sql<{ id: number; role: string; status: string }>`
    select id, role, status from members where user_id = ${userId} limit 1
  `;
  if (!m[0] || m[0].status !== "active") throw new Error("Sin acceso a la empresa");
  const acl = await loadAcl(sql, m[0].id, m[0].role);
  const have = acl[module];
  if (need === "view" && have === "none") throw new Error("Sin permiso para ver este módulo");
  if (need === "edit" && have !== "edit") throw new Error("Sin permiso para editar este módulo");
  return m[0];
}

export async function memberScope(sql: Sql, userId: string) {
  const m = await sql<{ id: number; role: string; own_only: boolean; company_id: number }>`
    select id, role, own_only, company_id from members where user_id = ${userId} and status = 'active' limit 1
  `;
  if (!m[0]) throw new Error("Sin empresa");
  return m[0];
}
