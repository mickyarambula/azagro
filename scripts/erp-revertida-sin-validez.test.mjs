// GRUPO ALTOS #37 (Decisión 75, 17-sep-2026): una factura revertida no se
// ENVÍA; «Documento» la imprime solo con la leyenda «REVERTIDA — SIN
// VALIDEZ» y la fecha, como comprobante interno. Nada sale idéntico a una
// viva (Decisión 31: una reversed es terminal).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`, `async function ${name}(`, `function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\n(export )?(async )?function |\nexport const /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

test("letterhead: con voided estampa REVERTIDA — SIN VALIDEZ antes del título; sin voided no cambia nada", () => {
  const body = fnBody(src("src/lib/print-doc.ts"), "letterhead");
  assert.ok(body.includes('${opts.voided ? `<p class="voided">REVERTIDA — SIN VALIDEZ'), "la marca es condicional");
  const iVoided = body.indexOf("opts.voided ?");
  const iH1 = body.indexOf("<h1>${escapeHtml(opts.title)}");
  assert.ok(iVoided !== -1 && iH1 !== -1 && iVoided < iH1, "la marca va ANTES del título, no escondida abajo");
  assert.ok(body.includes("revertida el ${escapeHtml(opts.voided)}"), "con la fecha en que se revirtió");
});

test("cableado: la factura de Cartera pasa voided al letterhead cuando está revertida, y el botón Enviar no se renderiza para ella", () => {
  const cr = src("src/routes/credit.tsx");
  assert.ok(cr.includes('voided: r.state === "reversed" ? (r.cancelled_at || "sí") : undefined,'), "Documento: marca con fecha, o \"sí\" si no hay fecha capturada");
  const iCond = cr.indexOf('{r.state !== "reversed" && (\n                      <SendButton');
  assert.notEqual(iCond, -1, "el bloque de Enviar está condicionado a que NO esté revertida");
  // Una revertida no se envía por NINGÚN camino: "Documento" abre una vista
  // previa (doc-preview.tsx) que trae su PROPIO botón "Enviar" si se le pasa
  // `send` — sin candado aquí, ese camino la enviaba idéntica a una viva
  // (hallazgo del revisor de dinero, NO PASA en la primera pasada).
  assert.ok(cr.includes('r.state === "reversed"\n                              ? undefined\n                              : {'), "sin `send` para una revertida: doc-preview no ofrece Enviar");
  assert.ok(cr.includes('totalLabel: r.state === "reversed" ? "Importe" : "Saldo",'), "\"Saldo\" implica deuda viva; una revertida ya no tiene una");
});

test("doc-preview.tsx: sin `send` no renderiza el botón Enviar (es la puerta que cierra el candado de credit.tsx)", () => {
  const dp = src("src/components/doc-preview.tsx");
  assert.ok(dp.includes("{send ? (") && dp.includes("<SendButton"), "el botón depende de que `send` venga con algo");
});

test("listInvoices: la fecha de revertida sale en el huso de Azagro, no el del servidor", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "listInvoices");
  assert.ok(body.includes("to_char(i.cancelled_at at time zone 'America/Mazatlan', 'YYYY-MM-DD') as cancelled_at"));
});

test("listInvoices trae cancelled_at para poder estampar la fecha en el papel", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "listInvoices");
  assert.ok(body.includes("cancelled_at: string | null;"));
  assert.ok(body.includes("to_char(i.cancelled_at at time zone 'America/Mazatlan', 'YYYY-MM-DD') as cancelled_at"));
});

test("la Decisión 75 vive en DECISIONES.md", () => {
  assert.match(src("DECISIONES.md"), /DECISIÓN 75 — Una factura revertida no se ENVÍA; se puede imprimir solo con la leyenda «REVERTIDA — SIN VALIDEZ»/);
});
