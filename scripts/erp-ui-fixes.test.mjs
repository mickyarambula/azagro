import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------------------
// Hora de Los Mochis (America/Mazatlan, UTC-7 fijo, sin horario de verano).
// Copia de dateTimeMx en src/lib/utils.ts — si cambia el motor, actualiza
// aquí y piensa por qué.
// ---------------------------------------------------------------------------
const AZAGRO_TZ = "America/Mazatlan";
function dateTimeMx(iso) {
  if (!iso) return "—";
  const hasZone = /Z$|[+-]\d{2}:?\d{2}$/.test(iso.trim());
  if (!hasZone) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: AZAGRO_TZ,
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

test("bitácora: 19:20:06 UTC (el caso real reportado) se muestra como 12:20:06 en Los Mochis", () => {
  assert.equal(dateTimeMx("2026-09-01T19:20:06Z"), "01/09/26 12:20:06");
});

test("sin horario de verano: en pleno verano sigue siendo UTC-7, nunca UTC-6", () => {
  // 19:00 UTC en julio debe seguir dando 12:00 (no 13:00, que sería con DST).
  assert.equal(dateTimeMx("2026-07-15T19:00:00Z"), "15/07/26 12:00:00");
});

test("medianoche exacta cruza de día: 06:00 UTC del día 2 es 23:00 del día 1 en Los Mochis", () => {
  assert.equal(dateTimeMx("2026-09-02T06:00:00Z"), "01/09/26 23:00:00");
});

test("sin zona explícita en el texto, no se adivina: se muestra tal cual llegó", () => {
  // Nunca debe tratar un texto ambiguo (sin Z ni offset) como si fuera UTC.
  assert.equal(dateTimeMx("2026-09-01 19:20:06"), "2026-09-01 19:20:06");
});

test("cableado: la bitácora pide un UTC inequívoco a la base y lo formatea en hora de Los Mochis", () => {
  const audit = src("src/lib/erp/audit.ts");
  assert.ok(
    audit.includes(`to_char(a.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`),
    "el SELECT debe pedir un texto UTC con Z explícita, no un ::text ambiguo dependiente del timezone de la sesión",
  );
  const ui = src("src/routes/bitacora.tsx");
  assert.ok(ui.includes("dateTimeMx(r.created_at)"), "la pantalla debe convertir a hora de Los Mochis al mostrar");
  assert.ok(!ui.includes('replace("T", " ")'), "ya no debe mostrar la hora cruda sin convertir");
});

test("las fechas SIN hora (factura, vencimiento, corte) no pasan por conversión de zona: siguen inmunes", () => {
  // dateDMY/fmtDate parten el string YYYY-MM-DD a mano, nunca construyen un
  // Date ni aplican timezone — por diseño no pueden recorrerse de día.
  const utils = src("src/lib/utils.ts");
  const dateDMY = utils.slice(utils.indexOf("export function dateDMY"), utils.indexOf("export function fmtDate"));
  const fmtDate = utils.slice(utils.indexOf("export function fmtDate"), utils.indexOf("export function dateTimeMx"));
  for (const fn of [dateDMY, fmtDate]) {
    assert.ok(!fn.includes("new Date("), "no debe construir un objeto Date (evita cualquier corrimiento de día)");
    assert.ok(fn.includes(".split(\"-\")"), "debe partir el texto YYYY-MM-DD directamente");
  }
});

// ---------------------------------------------------------------------------
// Guardar al terminar de escribir, no tecla por tecla.
// Copia del contrato de src/components/fields.tsx.
// ---------------------------------------------------------------------------
test("cableado: QtyField y MoneyField separan reflejo en vivo (onChange) de guardar (onCommit al salir/Enter)", () => {
  const fields = src("src/components/fields.tsx");
  for (const comp of ["QtyField", "MoneyField"]) {
    const body = fields.slice(fields.indexOf(`export function ${comp}`));
    assert.ok(body.includes("onCommit?:"), `${comp} debe aceptar onCommit (guardar)`);
    assert.ok(body.includes("onChange?:"), `${comp} debe aceptar onChange opcional (solo reflejo local)`);
    // onChange sigue disponible para quien necesite recalcular en vivo mientras
    // se escribe, pero onCommit es lo único que debe disparar el guardado real.
    assert.ok(/onBlur=\{\(\) => \{[\s\S]{0,80}onCommit\?\.\(parsed\(\)\)/.test(body), `${comp}: onCommit se llama al salir del campo`);
    assert.ok(body.includes('e.key === "Enter"'), `${comp}: Enter también confirma`);
  }
});

test("cableado: margen, flete y ofertas de RFQ ya no guardan en cada tecla", () => {
  const sol = src("src/routes/solicitudes.$solicitudId.tsx");
  const rfq = src("src/routes/rfq.$rfqId.tsx");
  // Los dos campos de margen (QtyField % y MoneyField $) deben colgar de
  // onCommit. El <select> de modo margen/nominal es aparte (no es "cada
  // tecla") y se deja como onChange a propósito.
  // (Entre el onCommit y la llamada puede ir el candado de "sin margen": salir
  // del campo sin escribir nada no debe guardar un 0%.)
  const marginCommits = sol.match(/onCommit=\{\(n\) => \{[^}]*void saveLineMargin\(/g) ?? [];
  assert.equal(marginCommits.length, 2, "las dos capturas de margen (% y $) deben colgar de onCommit");
  assert.equal((sol.match(/if \(!m && n === 0\) return;/g) ?? []).length, 2, "pasar por el campo vacío no captura un margen de 0%");
  const marginOnChange = sol.match(/onChange=\{\(n\) => \{[^}]*void saveLineMargin\(/g) ?? [];
  assert.equal(marginOnChange.length, 0, "el margen ya no debe guardar desde onChange");

  // El flete lleva el MISMO candado que el margen dos renglones arriba, y por
  // la misma razón elevada al cuadrado: el campo avisa al salir de él haya
  // escrito alguien o no, y a quien no ve costos el flete se le enseña
  // ENMASCARADO en cero — o sea que pasar el cursor por la columna escribía 0
  // encima de un flete real. Por eso el regex permite código entre el
  // onCommit y la llamada, como el del margen, y se exige que ese código sea
  // la comparación.
  // Decisión 102: ahora hay DOS escrituras del flete — el importe (al salir
  // del campo) y el modo (al elegirlo en el selector, que es un clic
  // deliberado, no «cada tecla»). El regex del onCommit solo debe encontrar la
  // primera.
  // Anclado al candado del importe: con dos escrituras del flete (el importe y
  // el modo) el regex viejo atravesaba bloques y contaba de más.
  const freightCommit = sol.match(/if \(Math\.abs\(n - num\(l\.freight\)\) < 0\.0001\) return;\s*void saveLineFreight\(/g) ?? [];
  assert.equal(freightCommit.length, 1, "el importe del flete se guarda al salir del campo, y solo si cambió");
  // Y LO QUE PROTEGÍA NO SE AFLOJA (incidente del 20-sep-2026: pasar el cursor
  // por la columna escribía $0 sobre un flete real de $3,000). TODA escritura
  // del flete desde un campo de dinero tiene que llevar ese candado: si
  // aparece una segunda sin él, esto falla.
  // Escrito como código y no como regex: un regex laxo cruzaba bloques y
  // contaba llamadas de otro campo. Cada escritura del flete tiene que ser, o
  // un campo de dinero CON el candado, o un clic deliberado en el selector.
  const escrituras = [...sol.matchAll(/void saveLineFreight\(/g)].map((m) => sol.slice(Math.max(0, m.index - 600), m.index));
  assert.equal(escrituras.length, 2, "hoy son dos: el importe y el modo");
  for (const antes of escrituras) {
    const conCandado = antes.includes("if (Math.abs(n - num(l.freight)) < 0.0001) return;");
    const esSelector = antes.lastIndexOf("onChange={(e) =>") > antes.lastIndexOf("onCommit={(n) =>");
    assert.ok(
      conCandado || esSelector,
      "una escritura del flete sin el candado del 20-sep y sin ser un clic del selector: por ahí se borraba un flete real con $0",
    );
  }
  assert.ok(sol.includes('<option value="recoge">Lo recoge</option>'), "y el modo se elige, no se teclea");
  assert.equal(
    (sol.match(/if \(Math\.abs\(n - num\(l\.freight\)\) < 0\.0001\) return;/g) ?? []).length,
    1,
    "pasar por el campo del flete sin escribir no puede guardar el valor que se estaba enseñando",
  );
  assert.ok(!/onChange=\{\(n\) => \{\s*void saveLineFreight\(/.test(sol), "el flete ya no debe guardar desde onChange");

  for (const [label, source] of [["solicitudes (RFQ inline)", sol], ["rfq.$rfqId", rfq]]) {
    assert.ok(/onCommit=\{\(n\) => \{\s*void saveRfqBid\(/.test(source), `saveRfqBid en ${label}: debe colgar de onCommit`);
    assert.ok(!/onChange=\{\(n\) => \{\s*void saveRfqBid\(/.test(source), `saveRfqBid en ${label}: ya no debe guardar desde onChange`);
  }
});

test("cableado: los campos de borrador local (líneas de cotización, compra, etc.) siguen usando onChange en vivo", () => {
  // No deben haberse tocado: ahí onChange solo actualiza estado local (setLines),
  // sin llamar al servidor, así que el reflejo por tecla sigue siendo correcto.
  for (const file of ["src/routes/quotes.tsx", "src/routes/purchases.tsx", "src/routes/cpo.tsx", "src/routes/rfq.nuevo.tsx"]) {
    const body = src(file);
    assert.ok(/onChange=\{\([^)]*\) => setLines/.test(body), `${file}: el borrador local debe seguir en onChange`);
  }
});
