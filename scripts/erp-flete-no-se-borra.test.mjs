// EL FLETE NO SE BORRA SOLO (20-sep-2026, hallazgo de la pasada de lectura del
// bloque del flete).
//
// A quien no ve costos de compra, la comparativa de proveedores de la
// solicitud le manda el flete ENMASCARADO en cero (`requests.ts`, junto con el
// costo y los márgenes). Pero guardarlo solo exigía `quotes:edit`, que ventas
// sí tiene, y el campo de dinero avisa al SALIR de él aunque nadie haya
// escrito nada. Resultado: un vendedor abría la solicitud, pasaba el cursor
// por la columna del flete y escribía 0 encima de un flete real de $3,000. El
// precio se armaba sin flete, el margen salía inflado, y no quedaba mensaje ni
// bitácora.
//
// Es el patrón de la regla 9 al revés: no es que el sistema invente un número,
// es que lo BORRA y deja un cero que no se distingue de «no se capturó».
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const start = source.indexOf(`export const ${name} `);
  assert.notEqual(start, -1, `No existe ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\nexport (const|async function|function) /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

test("no se escribe un número que no se puede ver: el permiso de escribir el flete es el de verlo", () => {
  const body = fnBody(src("src/lib/erp/requests.ts"), "saveLineFreight");
  assert.ok(body.includes("const me = await activeMember(sql, context.userId);"), "lee el rol");
  assert.ok(body.includes("if (!canSeeCosts(me.role)) {"), "y exige ver costos");
  assert.ok(
    body.includes("El flete lo captura quien ve los costos de compra (compras, gerencia o administrador)"),
    "y dice a quién le toca, no solo que no se puede",
  );
  // El permiso de siempre se queda: éste se SUMA, no lo sustituye.
  assert.ok(body.includes('await assertCan(sql, context.userId, "quotes", "edit");'), "sigue exigiendo editar la solicitud");
});

test("la máscara y el candado son el mismo rol: si se separan, la máscara vuelve a ser un borrador", () => {
  const r = src("src/lib/erp/requests.ts");
  // El mismo `canSeeCosts` que enmascara el flete es el que ahora deja escribirlo.
  assert.ok(r.includes('freight: "0",'), "sigue enmascarado a quien no ve costos");
  assert.equal((r.match(/if \(!canSeeCosts\(me\.role\)\) \{/g) || []).length, 3, "las dos máscaras y el candado, con la MISMA regla");
});

test("el campo no guarda al pasarle el cursor: solo cuando el número cambió", () => {
  const p = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(p.includes("if (Math.abs(n - num(l.freight)) < 0.0001) return;"), "la comparación antes de guardar");
  assert.ok(p.includes("El campo avisa al SALIR de él, haya escrito alguien o no."), "y queda dicho por qué");
  // Dos candados, no uno: el de pantalla evita el guardado inútil, el del
  // servidor evita el borrado aunque alguien llame la función por su cuenta.
  assert.ok(p.includes("segundo candado: el"), "y que son dos");
});

test("el flete deja rastro de quién lo puso: decide el precio y no tenía bitácora", () => {
  const body = fnBody(src("src/lib/erp/requests.ts"), "saveLineFreight");
  assert.ok(body.includes('action: "flete-de-solicitud",'), "la acción");
  assert.ok(body.includes("flete por unidad ${previo.toFixed(2)} → ${data.freight.toFixed(2)}"), "con el número de antes y el de después");
  // Solo cuando cambió: pasar el cursor no puede llenar la bitácora de ruido.
  // Decisión 102: el MODO también decide dinero («lo recoge» vale cero), así
  // que cambiarlo deja rastro aunque el importe no se mueva.
  assert.ok(
    body.includes("if (Math.abs(previo - data.freight) > 0.0001 || (data.mode != null && data.mode !== modoPrevio)) {"),
    "y solo si de verdad cambió el importe o el modo",
  );
});
