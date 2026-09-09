// Bloque de diseño, parte 1 (9-sep-2026): el menú agrupa como los permisos.
// Cableado: lee nav.ts / acl.ts / app-shell.tsx / inventory.tsx tal cual y
// verifica (1) que ninguna ruta del menú viejo desapareció ni cambió de
// dirección, (2) que los módulos del menú son los ocho acordados y cada uno
// tiene su icono, (3) que /bodegas cae en Almacén o Contactos según el tab,
// (4) que la estrella ya no es un adorno con módulo "favorites", (5) que el
// formulario de bodega salió de /inventory, (6) que Plein Produce ya no sale
// en send-doc ni en ayuda. Al final imprime qué ve cada rol (mismo pathModule
// de siempre: los permisos no se tocaron).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const nav = read("src/lib/nav.ts");
const acl = read("src/lib/erp/acl.ts");
const shell = read("src/components/app-shell.tsx");

const moduleIds = [...nav.matchAll(/^ {4}id: "([a-z]+)"/gm)].map((m) => m[1]);
const sections = [...nav.matchAll(/to: "([^"]+)",\s*label: "([^"]+)",\s*key: "([a-z-]+)",?(?:\s*search: \{ ([^}]*)\})?/g)].map((m) => ({
  to: m[1],
  label: m[2],
  key: m[3],
  search: (m[4] ?? "").replace(/\s|"/g, "").replace(/,q:$/, ""),
}));
const routeOf = (s) => (s.search ? `${s.to}?${s.search.replace(/,/g, "&")}` : s.to);

// El menú antes de la parte 1 (HEAD~ de nav.ts): 26 destinos distintos.
const OLD_ROUTES = [
  "/", "/solicitudes", "/quotes", "/sales", "/cpo", "/rfq", "/purchases", "/inventory",
  "/bodegas?tab:bodegas", "/bodegas?tab:destinos", "/products",
  "/partners?tab:clientes", "/partners?tab:proveedores",
  "/credit?lado:cobrar", "/credit?lado:pagar", "/vencimientos", "/cadena", "/statements", "/banks", "/gastos",
  "/reportes", "/settings", "/users", "/importar", "/bitacora", "/ayuda",
];

test("menú: los ocho módulos acordados, en ese orden, cada uno con icono en el riel", () => {
  assert.deepEqual(moduleIds, ["home", "sales", "purchases", "warehouse", "credit", "contacts", "reports", "settings"]);
  const icons = shell.match(/const RAIL_ICONS[^=]*= \{([^}]*)\}/)?.[1] ?? "";
  const iconKeys = [...icons.matchAll(/(\w+):/g)].map((m) => m[1]);
  assert.deepEqual(iconKeys.sort(), [...moduleIds].sort());
  assert.ok(!shell.includes('"favorites"'), "app-shell ya no conoce un módulo favorites");
  assert.ok(!nav.includes("starred"), "nav.ts ya no trae favoritos fijos en código");
});

test("menú: ninguna ruta desapareció ni cambió de dirección; cada una tiene su archivo", () => {
  const now = new Set(sections.map(routeOf));
  for (const r of OLD_ROUTES) assert.ok(now.has(r), `sigue en el menú: ${r}`);
  assert.equal(now.size, OLD_ROUTES.length, "ni una ruta nueva sin decisión");
  for (const s of sections) {
    if (s.to === "/") continue;
    const base = s.to.slice(1);
    assert.ok(existsSync(new URL(`../src/routes/${base}.tsx`, import.meta.url)) || existsSync(new URL(`../src/routes/${base}.index.tsx`, import.meta.url)), `archivo de ruta para ${s.to}`);
  }
  const keys = sections.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, "claves de sección únicas (son la llave del favorito)");
  assert.equal(sections.filter((s) => s.to === "/settings").length, 1, "Empresa y Reglas son una sola entrada: Configuración");
});

test("menú: /bodegas cae en Almacén o en Contactos según el tab", () => {
  const fn = nav.slice(nav.indexOf("export function moduleForPath"), nav.indexOf("export function sectionForPath"));
  assert.ok(fn.includes('pathname.startsWith("/bodegas")') && fn.includes("s.search?.tab === tab"));
  assert.ok(shell.includes("moduleForPath(pathname, search)"), "app-shell le pasa el search al módulo activo");
  const warehouse = nav.slice(nav.indexOf('id: "warehouse"'), nav.indexOf('id: "credit"'));
  const contacts = nav.slice(nav.indexOf('id: "contacts"'), nav.indexOf('id: "reports"'));
  assert.ok(warehouse.includes('search: { tab: "bodegas" }') && contacts.includes('search: { tab: "destinos" }'));
});

test("inventario: el formulario de bodega vive solo en /bodegas; aquí queda la liga", () => {
  const inv = read("src/routes/inventory.tsx");
  for (const gone of ["saveLocation", "deleteLocation", "locForm", "setEditing", "Nueva bodega", "+ Alta"]) {
    assert.ok(!inv.includes(gone), `ya no está en /inventory: ${gone}`);
  }
  assert.ok(inv.includes('to="/bodegas" search={{ tab: "bodegas" }}'), "liga a Almacén → Bodegas");
  const bod = read("src/routes/bodegas.tsx");
  assert.ok(bod.includes("saveLocation") && bod.includes("deleteLocation"), "/bodegas sigue siendo el único lugar que crea y borra");
});

test("Plein Produce ya no sale en el envío ni en la ayuda", () => {
  assert.ok(!read("src/components/send-doc.tsx").includes("Plein"));
  assert.ok(!read("src/routes/ayuda.tsx").includes("Plein"));
});

// Qué ve cada rol con el menú nuevo: misma regla de siempre (pathModule +
// plantilla del rol). Se imprime para la verificación de la parte 1; los
// permisos no cambiaron, así que la lista por rol es la misma que antes.
test("menú por rol: todo lo que se ve pasa por pathModule (permisos intactos)", () => {
  const rules = [...acl.matchAll(/startsWith\("([^"]+)"\)\) return "([a-z]+)"/g)].map((m) => [m[1], m[2]]);
  const pathModule = (p) => (p === "/" ? "dashboard" : (rules.find(([pre]) => p.startsWith(pre)) ?? [null, null])[1]);
  for (const s of sections) assert.ok(pathModule(s.to), `pathModule conoce ${s.to}`);
  const block = (role) => {
    const i = acl.indexOf(`if (role === "${role}")`);
    const body = acl.slice(i, acl.indexOf("}", acl.indexOf("return {", i)));
    return Object.fromEntries([...body.matchAll(/(\w+): "(edit|view|none)"/g)].map((m) => [m[1], m[2]]));
  };
  const tail = acl.slice(acl.lastIndexOf("return {", acl.indexOf("export function pathModule")));
  const cobranza = Object.fromEntries([...tail.slice(0, tail.indexOf("}")).matchAll(/(\w+): "(edit|view|none)"/g)].map((m) => [m[1], m[2]]));
  const aclIds = [...acl.slice(0, acl.indexOf("export type AppRole")).matchAll(/id: "([a-z_]+)"/g)].map((m) => m[1]);
  const all = (lvl) => Object.fromEntries(aclIds.map((id) => [id, lvl]));
  const templates = {
    admin: all("edit"),
    gerencia: { ...all("edit"), users: "view" },
    consulta: { ...all("view"), settings: "none", users: "none" },
    administracion: block("administracion"),
    ventas: block("ventas"),
    compras: block("compras"),
    almacen: block("almacen"),
    cobranza,
  };
  assert.ok(shell.includes('if (m.id === "settings") return (acl.settings ?? "none") !== "none" || (acl.users ?? "none") !== "none";'));
  assert.ok(shell.includes('if (m.id === "home") return (acl.dashboard ?? "none") !== "none";'));
  assert.ok(shell.includes("const own = m.sections.filter((s) => canSeePath(s.to));"), "secciones filtradas por permiso");
  assert.ok(shell.includes("? visibleSections(m).map((s) => (") && shell.includes("items={visibleSections(mod).map("), "riel y encabezado usan la lista filtrada");
  assert.ok(!shell.includes("? m.sections.map((s) => ("), "ya no se lista una sección que da Sin permiso");
  const modLabel = Object.fromEntries([...nav.matchAll(/^ {4}id: "([a-z]+)",\s*label: "([^"]+)"/gm)].map((m) => [m[1], m[2]]));
  const modOf = (to, search) => {
    const seg = nav.slice(0, nav.indexOf(search ? `to: "${to}", label: "${sections.find((s) => s.to === to && s.search === search).label}"` : `to: "${to}"`));
    return [...seg.matchAll(/^ {4}id: "([a-z]+)"/gm)].pop()[1];
  };
  const lines = [];
  for (const [role, t] of Object.entries(templates)) {
    assert.equal(Object.keys(t).length, aclIds.length, `plantilla completa de ${role}`);
    // Misma regla que app-shell (visibleModules): Inicio si ve dashboard; Ajustes
    // si ve settings o users (aunque /ayuda sea de dashboard); los demás, si
    // alguna de sus secciones pasa por canSeePath.
    const can = (to) => (t[pathModule(to)] ?? "none") !== "none";
    const modVisible = (id) => (id === "home" ? t.dashboard !== "none" : id === "settings" ? t.settings !== "none" || t.users !== "none" : true);
    const seen = {};
    for (const s of sections) {
      const id = modOf(s.to, s.search);
      // Patrón B1: dentro de un módulo visible solo se listan las secciones que
      // el rol puede abrir (visibleSections en app-shell).
      if (modVisible(id) && can(s.to)) (seen[modLabel[id]] ??= []).push(s.label);
    }
    lines.push(`${role}: ` + Object.entries(seen).map(([m, ss]) => `${m} [${ss.join(", ")}]`).join(" · "));
  }
  console.log(lines.join("\n"));
  assert.ok(lines.length === 8);
});

test("favoritos: por persona, en tabla, clave del menú, sin bitácora", () => {
  const fav = read("src/lib/erp/favorites.ts");
  assert.ok(fav.includes("activeMember(sql, context.userId)"), "el member_id sale de la sesión");
  assert.ok(!/memberId/.test(fav), "el cliente no manda a quién marcar");
  assert.ok(fav.includes("sectionByKey(data.key)"), "una clave que no está en el menú se rechaza");
  assert.ok(!fav.includes("writeAudit"), "no va a bitácora (decisión del dueño)");
  const mig = read("migrations/0031_member_favorites.sql");
  assert.ok(mig.includes("primary key (member_id, section_key)") && mig.includes("references members(id) on delete cascade"));
  assert.ok(!/insert into/.test(mig), "nace vacía: sin favoritos por omisión");
  assert.ok(shell.includes("toggleFavorite({ data: { key: section.key } })"), "la estrella marca la sección actual");
  assert.ok(shell.includes('if (m.id !== "home") return own;') && shell.includes("favs.map(sectionByKey)"), "Inicio lista lo marcado");
  const keys = new Set(sections.map((s) => s.key));
  assert.ok(nav.includes("export function sectionByKey"));
  assert.ok(keys.size === 26 && !keys.has(""), "26 claves estables, ninguna vacía");
});
