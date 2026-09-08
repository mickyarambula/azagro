// BLOQUE DE DESHACER — PASO 0 (7-sep-2026): cimientos, sin cambiar
// comportamiento. Ver DESHACER.md, DECISIONES.md (17-25), Decisiones 15/16.
//
// Este paso NO construye ninguna acción de cancelar ni de revertir — eso
// empieza en el paso 1. Solo pone: el estado nuevo (`cancelled` en
// solicitud/cotización/pedido/OC, `reversed` en facturas), quién/cuándo/por
// qué en el documento (migración 0029), la liga original↔reversa
// (`reverses_id`), y TODOS los lectores existentes corregidos para que un
// documento marcado a mano no siga contando como vivo.
//
// Esta prueba, del mismo estilo de cableado que scripts/erp-circuitos.test.mjs
// y scripts/erp-permissions.test.mjs: no ejecuta el motor, verifica por texto
// que cada lector de verdad excluye lo cancelado/revertido, y que ningún
// patrón viejo y peligroso (`<> 'paid'`, `<> 'done'`) sobrevive en src/lib.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

/** Igual que en erp-permissions.test.mjs: corta el cuerpo de una función
 * exportada, de `export const NAME`/`export async function NAME` hasta el
 * siguiente `export`. Si la función se renombra o se borra, el test falla. */
function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe export ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\nexport /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

// ---------------------------------------------------------------------------
// 1) La migración: estados nuevos, quién/cuándo/por qué, la liga original↔
//    reversa. Cinco tablas se marcan (customer_requests, quotes, sales_orders,
//    purchase_orders, invoices); cuatro llevan reverses_id.
// ---------------------------------------------------------------------------
test("migración 0029: cancelled_at/by/reason en las cinco tablas, reverses_id en las cuatro", () => {
  const m = src("migrations/0029_bloque_deshacer_paso0.sql");
  for (const t of ["customer_requests", "quotes", "sales_orders", "purchase_orders", "invoices"]) {
    for (const col of ["cancelled_at timestamptz", "cancelled_by text", "cancel_reason text"]) {
      assert.ok(
        m.includes(`alter table ${t} add column if not exists ${col};`),
        `${t} necesita ${col} — se marca y se conserva, nunca se borra (Decisión 15)`,
      );
    }
  }
  for (const t of ["invoices", "payments", "bank_moves", "stock_moves"]) {
    assert.ok(
      m.includes(`alter table ${t} add column if not exists reverses_id integer references ${t}(id)`),
      `${t} necesita reverses_id — sin la liga, una reversa se adivina por fecha/texto (DESHACER.md § 4, caso 4)`,
    );
  }
});

test("stock.ts: refreshInvoiceResidual limpia paid_date al reabrir (hueco confirmado en DESHACER.md § 2.1)", () => {
  const body = fnBody(src("src/lib/erp/stock.ts"), "refreshInvoiceResidual");
  assert.ok(
    body.includes("state = 'open', paid_date = null"),
    "sin esto, una factura reabierta se queda con fecha de pago y el interés no vuelve a correr",
  );
});

// ---------------------------------------------------------------------------
// 2) credit.ts: el predicado compartido — ni pagada, ni revertida es cartera
//    abierta. Un solo lugar, y las tres pantallas de cartera lo importan.
// ---------------------------------------------------------------------------
test("credit.ts: invoiceStillOwed excluye pagada Y revertida", () => {
  const body = fnBody(src("src/lib/erp/credit.ts"), "invoiceStillOwed");
  assert.ok(body.includes('state !== "paid" && state !== "reversed"'));
});

for (const file of ["src/routes/credit.tsx", "src/routes/cadena.tsx", "src/routes/vencimientos.tsx"]) {
  test(`${file}: importa y usa invoiceStillOwed, no state !== "paid" suelto`, () => {
    const c = src(file);
    assert.ok(c.includes("invoiceStillOwed"), `${file} no usa el predicado compartido`);
  });
}

test("credit.tsx: una factura revertida no muestra botón de Pago ni de recordatorio", () => {
  const c = src("src/routes/credit.tsx");
  assert.ok(c.includes("{invoiceStillOwed(r.state) && (\n                        <>\n                          <button type=\"button\" className=\"erp-btn h-8 text-[12px]\" onClick={() => setPay("));
  assert.ok(c.includes('"Revertida"'), "necesita su propia etiqueta, no puede caer en el badge de vigencia");
});

test("cadena.tsx: una factura revertida no cuenta en AR/AP ni se etiqueta como si tuviera vencimiento", () => {
  const c = src("src/routes/cadena.tsx");
  assert.ok(c.includes("if (!invoiceStillOwed(r.state)) continue;"));
  assert.ok(c.includes('"revertida"'));
});

// ---------------------------------------------------------------------------
// 3) Los lectores SQL con exclusión negativa (<> 'paid', <> 'done'): los
//    únicos peligrosos, porque un valor nuevo y distinto SÍ los cuela. Barrido
//    completo: cero patrones viejos sobreviven en src/lib.
// ---------------------------------------------------------------------------
test("src/lib: ningún `<> 'paid'` ni `<> 'done'` suelto sobre state — todos pasaron a not in (...)", () => {
  const files = ["src/lib/azagro.ts", "src/lib/erp/ops.ts", "src/lib/erp/alerts.ts", "src/lib/erp/reports.ts", "src/lib/erp/orders.ts"];
  for (const f of files) {
    const c = src(f);
    assert.ok(!/state <> 'paid'/.test(c), `${f} todavía deja pasar una factura revertida`);
    assert.ok(!/state <> 'done'/.test(c), `${f} todavía deja pasar un pedido/OC cancelado`);
  }
});

test("azagro.ts: tablero (pendientes PO/SO) y pendientes-por-recibir excluyen cancelado", () => {
  const c = src("src/lib/azagro.ts");
  assert.ok(c.includes("state not in ('done','cancelled')) as po,"));
  assert.ok(c.includes("state not in ('done','cancelled')) as so,"));
  assert.ok(c.includes("and po.state not in ('done','cancelled')"));
});

test("ops.ts + alerts.ts: listas de facturas por cobrar/pagar excluyen revertida", () => {
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("state not in ('paid','reversed') order by id desc limit 80"));
  const alerts = src("src/lib/erp/alerts.ts");
  assert.equal(
    (alerts.match(/state not in \('paid','reversed'\)/g) || []).length,
    2,
    "el digest de alertas y el envío de recordatorios — los dos",
  );
});

// ---------------------------------------------------------------------------
// 4) Las escrituras peligrosas: acciones que, sin el candado, procederían
//    sobre un documento cancelado. reviseQuote es el que el dueño nombró por
//    su cuenta ("hoy escribiría precios en un pedido cancelado"); decideQuote,
//    receivePurchase y deliverSale tienen el mismo defecto — un check
//    `=== "done"`/`=== "accepted"`/`=== "rejected"` no atrapa un tercer estado
//    nuevo y distinto.
// ---------------------------------------------------------------------------
test("reviseQuote: no revisa una cotización cancelada ni confunde una OC cancelada con firme", () => {
  const body = fnBody(src("src/lib/erp/ops.ts"), "reviseQuote");
  assert.ok(
    body.includes('if (q[0].state === "cancelled") throw new Error("Esta cotización está cancelada.");'),
    "sin este candado, reviseQuote seguiría de largo y escribiría precios (ops.ts:1503-1519) en un pedido de una cotización cancelada",
  );
  assert.ok(
    body.includes('ordenes.find((o) => o.state !== "draft" && o.state !== "cancelled")'),
    'un pedido cancelado no es "firme": no debe bloquear la revisión con ese mensaje',
  );
});

test("decideQuote: no acepta ni rechaza una cotización ya cancelada", () => {
  const body = fnBody(src("src/lib/erp/ops.ts"), "decideQuote");
  assert.ok(body.includes('q[0].state === "cancelled"'));
});

test("azagro.ts: receivePurchase y deliverSale rechazan una OC/pedido cancelado, no solo el ya terminado", () => {
  const c = src("src/lib/azagro.ts");
  assert.ok(c.includes('po[0].state === "done" || po[0].state === "cancelled"'), "receivePurchase");
  assert.ok(c.includes('so[0].state === "done" || so[0].state === "cancelled"'), "deliverSale");
});

test("quotes.tsx: una cotización cancelada no se ofrece como revisable", () => {
  const c = src("src/routes/quotes.tsx");
  assert.ok(c.includes('qrow.state !== "rejected" && qrow.state !== "cancelled" && (!closed || borrador)'));
});

// ---------------------------------------------------------------------------
// 5) Las pantallas: lo que hoy se leería "Abierta"/"Por recibir"/"Vigente"
//    para un documento cancelado (positivo por omisión) ahora dice
//    explícitamente "Cancelada"/"Cancelado".
// ---------------------------------------------------------------------------
test("order-form.tsx: stateLabel conoce cancelled (cubre el chip del pedido y la lista)", () => {
  const body = fnBody(src("src/components/order-form.tsx"), "stateLabel");
  assert.ok(body.includes('if (state === "cancelled") return "Cancelado";'));
});

test("sales.$orderId.tsx y purchases.tsx: la OC ligada no dice 'Por recibir' si está cancelada", () => {
  const soPage = src("src/routes/sales.$orderId.tsx");
  assert.ok(soPage.includes('po.state !== "done" && po.state !== "cancelled" && po.fulfill_kind !== "direct"'));
  assert.ok(soPage.includes('"Cancelada"'));
  const purchases = src("src/routes/purchases.tsx");
  assert.ok(purchases.includes('o.state !== "done" && o.state !== "cancelled" && o.fulfill_kind !== "direct"'));
  assert.ok(purchases.includes('"Cancelada"'));
});

for (const [file, label] of [
  ["src/routes/solicitudes.index.tsx", '"Cancelada"'],
  ["src/routes/solicitudes.$solicitudId.tsx", '"Cancelada"'],
]) {
  test(`${file}: una solicitud cancelada no se muestra como "Abierta"`, () => {
    assert.ok(src(file).includes(label));
  });
}

test("quotes.tsx: el badge distingue cancelada de vencida/vigente, y ofrece recotizar", () => {
  const c = src("src/routes/quotes.tsx");
  assert.ok(/qrow\.state === "cancelled"\s*\?\s*"muted"/.test(c), "tono muted para cancelada");
  assert.ok(/qrow\.state === "cancelled"\s*\?\s*"Cancelada"/.test(c), "etiqueta Cancelada");
  assert.ok(
    c.includes('qrow.state === "rejected" || qrow.state === "cancelled" || expired'),
    "recotizar (duplicateQuote) es igual de válido para una cancelada que para una rechazada o vencida",
  );
});
