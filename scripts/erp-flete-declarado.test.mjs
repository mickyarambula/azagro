// EL FLETE AL CLIENTE SE DECLARA, O EL DOCUMENTO NO NACE (Decisión 102).
//
// La regla del dueño, 20-sep-2026: «el flete no se estima, debes tener
// conocimiento del costo para poder cotizar porque si no puede variar
// negativamente y afectar el margen».
//
// Hasta esta pieza el campo nacía en CERO y nadie tenía que decir de dónde
// salía ese cero. Es el mismo patrón que ya se corrigió dos veces —el plazo
// del proveedor (Decisión 67) y la política de cobro (Decisión 69)—: vacío no
// es cero, y la corrección es la misma.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFreightDeclared, effectiveFreight, freightDeclared, freightSpoken, isDeclaredZero, FREIGHT_MODES, FREIGHT_MODE_LABEL } from "../src/lib/erp/freight-terms.ts";
import { marginFromPrice } from "../src/lib/erp/margins.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const L = (over) => ({ label: "UREA", freight: 0, mode: null, ...over });

// ---------------------------------------------------------------------------
// 1. Vacío no es cero
// ---------------------------------------------------------------------------
test("sin decir qué pasa con el flete, el documento NO nace", () => {
  assert.throws(() => assertFreightDeclared([L({})]), /Falta decir qué pasa con el flete/);
  assert.throws(() => assertFreightDeclared([L({})]), /UREA/, "nombra la partida");
  assert.throws(() => assertFreightDeclared([L({})]), /no se distingue de un flete que se olvidó/, "y dice por qué importa");
});

test("el mensaje nombra LAS TRES opciones: un candado sin salida es peor que el bug que tapa", () => {
  try {
    assertFreightDeclared([L({})]);
    assert.fail("debió detenerse");
  } catch (e) {
    for (const m of FREIGHT_MODES) assert.ok(e.message.includes(FREIGHT_MODE_LABEL[m]), `falta la salida «${FREIGHT_MODE_LABEL[m]}»`);
  }
});

test("«se le cobra» con importe en CERO es la contradicción que esto viene a matar", () => {
  assert.throws(() => assertFreightDeclared([L({ mode: "cobrado", freight: 0 })]), /el importe está en cero/);
  // Y con importe, pasa.
  assertFreightDeclared([L({ mode: "cobrado", freight: 20 })]);
});

// ---------------------------------------------------------------------------
// 2. Las dos salidas: cero, pero dicho
// ---------------------------------------------------------------------------
test("«el cliente lo recoge» y «lo pone el proveedor» son cero A PROPÓSITO", () => {
  assertFreightDeclared([L({ mode: "recoge", freight: 0 })]);
  assertFreightDeclared([L({ mode: "proveedor", freight: 0 })]);
  assert.equal(isDeclaredZero("recoge"), true);
  assert.equal(isDeclaredZero("proveedor"), true);
  assert.equal(isDeclaredZero("cobrado"), false);
  assert.equal(isDeclaredZero(null), false, "sin modo NO es un cero a propósito");
  assert.equal(isDeclaredZero(""), false);
});

test("un modo inventado no cuenta como declarado", () => {
  assert.throws(() => assertFreightDeclared([L({ mode: "gratis" })]), /Falta decir qué pasa con el flete/);
  assert.equal(freightDeclared({ label: "X", mode: "sin-flete", freight: 0 }), false);
});

// ---------------------------------------------------------------------------
// 3. Lo ya capturado no se toca (migraciones 0039 y 0040)
// ---------------------------------------------------------------------------
test("un documento VIEJO —sin modo y sin importe— sigue naciendo con `legacy`", () => {
  assertFreightDeclared([L({ mode: null, freight: 0 })], { legacy: true });
  assertFreightDeclared([L({ mode: null, freight: null })], { legacy: true });
});

test("UN IMPORTE ES LA DECLARACIÓN: con flete capturado no hace falta la etiqueta", () => {
  // La primera versión exigía además el modo, y eso dejaba cotizaciones
  // imposibles de aceptar: duplicar una traía el importe sin modo, y el
  // selector solo existe en la pantalla de la solicitud — sin salida.
  // «Hay $35 de flete» ⇒ «se le cobra» no es suponer: es leer el número.
  assertFreightDeclared([L({ mode: null, freight: 35 })]);
  assertFreightDeclared([L({ mode: null, freight: 35 })], { legacy: true });
  assert.equal(freightDeclared({ label: "X", mode: null, freight: 35 }), true);
  // Lo que sigue sin pasar: cero sin decir por qué.
  assert.equal(freightDeclared({ label: "X", mode: null, freight: 0 }), false);
});

// ---------------------------------------------------------------------------
// 4. Varias partidas
// ---------------------------------------------------------------------------
test("se nombran TODAS las partidas que faltan, no solo la primera", () => {
  try {
    assertFreightDeclared([L({ label: "UREA" }), L({ label: "MAP", mode: "recoge" }), L({ label: "FOLIAR" })]);
    assert.fail("debió detenerse");
  } catch (e) {
    assert.ok(e.message.includes("UREA") && e.message.includes("FOLIAR"), "las dos que faltan");
    assert.ok(!e.message.includes("MAP"), "y no la que sí está declarada");
  }
});

test("una lista vacía no se detiene: no hay flete que declarar", () => {
  assertFreightDeclared([]);
});

// ---------------------------------------------------------------------------
// 5. Es puro, y la regla vive en UN solo lugar
// ---------------------------------------------------------------------------
test("sin imports: la prueba lo carga directo", () => {
  assert.ok(!/^import /m.test(src("src/lib/erp/freight-terms.ts")));
});

test("la regla vive UNA vez y la llaman los CUATRO nacimientos de una venta", () => {
  // Es el mismo molde que `assertSaleTerms` con la política de cobro
  // (Decisión 69): una regla, cuatro puertas. Si una se sale, nace un
  // documento sin flete y el precio se arma sin él.
  const f = src("src/lib/erp/freight-terms.ts");
  assert.equal((f.match(/export function assertFreightDeclared\(/g) || []).length, 1);
  const puertas = [
    ["src/lib/erp/ops.ts", "decideQuote: aceptar una cotización"],
    ["src/lib/azagro.ts", "createSale: la venta directa"],
    ["src/lib/erp/cpo.ts", "convertCustomerPO: la orden de compra del cliente"],
  ];
  for (const [p, quien] of puertas) {
    assert.ok(src(p).includes("assertFreightDeclared("), `${quien} no llama a la regla`);
  }
});

// ---------------------------------------------------------------------------
// 6. Lo que cerró la revisión (NO PASA del 22-sep-2026)
// ---------------------------------------------------------------------------
test("el candado corre ANTES de escribir la cotización, no después", () => {
  // La primera versión lo puso una línea después del `insert into quotes`, y
  // ese camino no corre en transacción: cada intento fallido dejaba una
  // cotización ENVIADA, con su total y sin una sola partida, y quemaba un
  // folio. Un candado que se dispara tarde no detiene el documento: lo deja
  // a medias.
  const r = src("src/lib/erp/requests.ts");
  const candado = r.indexOf("assertFreightDeclared(");
  const insert = r.indexOf("insert into quotes (");
  assert.notEqual(candado, -1, "el candado existe");
  assert.notEqual(insert, -1);
  assert.ok(candado < insert, "el candado tiene que estar ANTES del insert de la cotización");
  assert.ok(r.includes("**ANTES DE ESCRIBIR NADA**"), "y queda dicho por qué");
});

test("UNA sola definición de «declarado»: la regla y la utilidad no pueden discrepar", () => {
  // La regla decía que un importe basta; la utilidad solo honraba el flete si
  // había etiqueta. Una partida con $3,000 y sin modo se aceptaba, se
  // guardaba, y la utilidad la ignoraba: $3,000 por unidad fuera del costo
  // puesto — justo lo que la regla 8 prohíbe («las dos cifras tienen que
  // coincidir»).
  const f = src("src/lib/erp/freight-terms.ts");
  assert.equal((f.match(/export function effectiveFreight\(/g) || []).length, 1);
  assert.equal((f.match(/export function freightSpoken\(/g) || []).length, 1);
  // EL NÚMERO EFECTIVO SE CONGELA AL NACER EL DOCUMENTO, y los lectores solo
  // leen. Guardar el crudo junto a la etiqueta obligaba a cada lector a
  // interpretarlos, y dos lectores discreparon en las DOS direcciones en dos
  // revisiones seguidas: primero la utilidad ignoraba un flete que el precio
  // cobraba; después el precio cobró $3,000 que la utilidad ya no contaba.
  const req = src("src/lib/erp/requests.ts");
  // SE RESUELVE UNA VEZ, ARRIBA, Y DE AHÍ SALEN EL PRECIO Y LO GUARDADO.
  // Resolverlo solo donde se guarda no bastó: el precio siguió leyendo el
  // crudo y cobró $34,090.91 de más en 10 toneladas, con $30,000 de utilidad
  // que no existía. Hay que calcularlo donde se DECIDE.
  assert.ok(req.includes("const flete = effectiveFreight(l.freight_mode, Number(l.freight));"), "se resuelve una vez, arriba del mapeo");
  const cuerpo = req.slice(req.indexOf("const priced = lines.map"), req.indexOf("freightMode: l.freight_mode"));
  assert.equal((cuerpo.match(/freight: flete,/g) || []).length, 3, "los dos precios y el guardado, con el MISMO número");
  assert.equal((cuerpo.match(/freight: Number\(l\.freight\)/g) || []).length, 0, "ni un solo uso del crudo en el precio");
  // Y la pantalla enseña lo mismo que el servidor va a cobrar.
  const ui = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(ui.includes("const fleteEf = effectiveFreight(l.freight_mode, num(l.freight));"), "la vista previa del precio");
  // LISTA CERRADA, no barrido por ventana. La versión anterior miraba 300
  // caracteres alrededor de cada `num(l.freight)` y se podía burlar de tres
  // formas —probadas, no razonadas—: escribiendo `Number(l.freight)` en vez de
  // `num(...)`, pegando el uso crudo debajo del efectivo para heredar su
  // coartada, o guardando el valor en un alias.
  //
  // Aquí se enumeran TODOS los usos de `l.freight` en la pantalla y se exige
  // que cada renglón sea uno de los conocidos. Un uso nuevo —se llame como se
  // llame— falla hasta que alguien lo clasifique a propósito. Es la misma
  // forma que «los SEIS lectores»: si la lista dice menos de los que hay, el
  // que falte se sale sin que nadie lo note.
  const PERMITIDOS = [
    // El campo donde se captura, y lo que se manda al guardarlo.
    "value={num(l.freight)}",
    "freight: num(l.freight),",
    "if (Math.abs(n - num(l.freight)) < 0.0001) return;",
    // El efectivo: el único que decide dinero.
    "const fleteEf = effectiveFreight(l.freight_mode, num(l.freight));",
    "const landed = num(l.cost) + effectiveFreight(l.freight_mode, num(l.freight));",
    // Preguntar SI se tecleó algo, para decir «sin flete: lo recoge el
    // cliente» en vez de esconder el renglón. No decide cuánto.
    ") : num(l.freight) > 0 && l.freight_mode ? (",
  ];
  const renglones = ui.split("\n").filter((r) => /\bl\.freight\b/.test(r));
  assert.ok(renglones.length > 0, "la pantalla usa el flete en algún lado");
  for (const r of renglones) {
    assert.ok(
      PERMITIDOS.some((ok) => r.includes(ok)),
      `uso del flete sin clasificar en la pantalla — si es legítimo, agrégalo a PERMITIDOS a propósito: ${r.trim()}`,
    );
  }
  assert.ok(ui.includes("{money(num(l.cost))} + flete {money(fleteEf)}"), "el desglose enseña el efectivo");
  assert.ok(ui.includes("lo recoge el cliente"), "y cuando es cero dice por qué, en vez de desaparecer");
  // La utilidad solo LEE: el número guardado ya es el bueno.
  const r = src("src/lib/erp/reports.ts");
  assert.ok(r.includes("? Number(l.sale_freight)") && r.includes(": Number(l.quote_freight);"), "la utilidad solo LEE el número guardado");
  assert.ok(!r.includes("effectiveFreight("), "y no lo vuelve a interpretar");
  assert.ok(!r.includes("quote_freight_mode"), "ni se trae un campo que invite a interpretarlo");
  assert.ok(req.includes("El importe crudo se queda en la SOLICITUD"), "y queda dicho dónde vive cada uno");
});

test("cambiar de modo NO borra el importe capturado", () => {
  // Elegir «lo recoge» escribía 0 encima: un flete real de $3,000 se perdía
  // con dos clics, y volver a «se le cobra» ya no lo recuperaba.
  assert.equal(effectiveFreight("recoge", 3000), 0, "vale cero sin borrar el número");
  assert.equal(effectiveFreight("proveedor", 3000), 0);
  assert.equal(effectiveFreight("cobrado", 3000), 3000, "y volver a cobrarlo lo recupera");
  assert.equal(effectiveFreight(null, 3000), 3000, "un importe sin etiqueta vale lo que dice");
  const p = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(p.includes("// El importe NO se borra al cambiar de modo"), "y la pantalla ya no lo borra");
  assert.ok(p.includes("freight: num(l.freight),"), "manda el importe que había");
});

test("«no se capturó» se escribe igual en las tres puertas", () => {
  // La columna se hizo nullable justo para distinguir vacío de cero; dos
  // puertas escribían `?? 0` y una `null`.
  for (const p of ["src/lib/azagro.ts", "src/lib/erp/cpo.ts"]) {
    assert.ok(!/freight \?\? 0\}, \$\{[^}]*freightMode/.test(src(p)) && !/\?\.freight \?\? 0\}/.test(src(p)), `${p} escribe 0 donde debería escribir vacío`);
  }
});

test("el selector no se le ofrece a quien no puede escribirlo", () => {
  const p = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(p.includes("disabled={locked || !data.canSeeCosts}"), "el selector");
  assert.ok(p.includes('disabled={locked || !data.canSeeCosts || l.freight_mode !== "cobrado"}'), "y el importe");
  const r = src("src/lib/erp/requests.ts");
  assert.ok(r.includes("canSeeCosts: false }") && r.includes("canSeeCosts: true }"), "la pantalla sabe si puede");
});

test("las validaciones de saveOrder corren ANTES de escribir nada", () => {
  // La primera versión las puso después del `update sales_orders` y del
  // `delete from sales_lines`, en un handler sin transacción: al dispararse
  // dejaban un pedido confirmado con el total nuevo y cero partidas. Es el
  // mismo defecto que la revisión cazó en `quoteFromRequest`, mudado de
  // archivo — por eso esta prueba mira los DOS.
  const o = src("src/lib/erp/orders.ts");
  const i = o.indexOf("export const saveOrder");
  const j = o.indexOf("export const ", i + 10);
  const cuerpo = o.slice(i, j > 0 ? j : o.length)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*--.*$/gm, "");
  const v = cuerpo.indexOf("assertFreightDeclared(");
  assert.notEqual(v, -1, "saveOrder llama la regla: es el cuarto nacimiento");
  for (const escritura of ["update sales_orders set", "delete from sales_lines", "insert into sales_orders"]) {
    const w = cuerpo.indexOf(escritura);
    assert.ok(w > v, `la validación tiene que ir ANTES de «${escritura}»`);
  }
});

test("la escritura y la validación de saveOrder mezclan IGUAL con la foto", () => {
  // Tenerlas distintas hacía que mandar el modo SIN el importe validara contra
  // el flete viejo y escribiera cero: $50,000 de costo puesto desaparecidos en
  // 100 sacos. Y al revés, mandar el importe sin modo borraba un «lo recoge».
  const o = src("src/lib/erp/orders.ts");
  assert.ok(o.includes("freight: l.freight ?? fleteAntes.get(l.productId)?.freight ?? null,"), "la validación mezcla");
  assert.ok(o.includes("mode: l.freightMode ?? fleteAntes.get(l.productId)?.mode ?? null,"), "la validación mezcla el modo");
  assert.ok(o.includes("effectiveFreight(line.freightMode ?? prev?.mode, line.freight ?? prev?.freight)"), "y la escritura mezcla igual");
  assert.ok(o.includes("mode: line.freightMode ?? prev?.mode ?? null,"), "también el modo");
});

test("«Sin decidir» es un clic deliberado y no se ignora", () => {
  // `coalesce(null, freight_mode)` dejaba el modo anterior pegado: no había
  // forma de regresar una partida a sin declarar, y el clic no hacía nada.
  const r = src("src/lib/erp/requests.ts");
  assert.ok(r.includes("mode: z.enum(FREIGHT_MODES).nullable().optional(),"), "null es distinto de ausente");
  assert.ok(
    r.includes("freight_mode = case when ${data.mode === undefined} then freight_mode else ${data.mode ?? null} end"),
    "ausente no toca; null borra",
  );
  const ui = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(ui.includes("mode: (mode || null)"), "y la pantalla manda null, no undefined");
});

test("cada mensaje nombra una salida que EXISTE", () => {
  // «quita el flete declarado y vuelve a capturarlo» mandaba a un campo que el
  // formulario del pedido no tiene. Un candado que nombra una puerta cerrada
  // es un candado sin salida con disfraz.
  const o = src("src/lib/erp/orders.ts");
  assert.ok(o.includes("junta las partidas repetidas en una sola y vuelve a guardar."), "la salida que sí se puede hacer");
  assert.ok(!o.includes("quita el flete declarado y vuelve a capturarlo"), "y ya no nombra la que no existe");
});

test("«lo pone el proveedor» no se lee como «nadie pagó flete»", () => {
  // El número es correcto ($0 que sumar al costo puesto), pero en brokeraje
  // puesto en destino SÍ hay flete: va dentro del precio del proveedor.
  const ui = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(ui.includes('"flete incluido en el precio del proveedor"'), "lo dice como es");
  assert.ok(ui.includes('"sin flete: lo recoge el cliente"'), "y el otro caso sí es sin flete");
});

// ---------------------------------------------------------------------------
// 7. El hueco de la pieza 3, cerrado: la pantalla de Cotizaciones ya no esquiva
// ---------------------------------------------------------------------------
function cuerpo(source, name) {
  const i = source.indexOf(`export const ${name}`);
  assert.notEqual(i, -1, `no existe ${name}`);
  const j = source.indexOf("export const ", i + 10);
  return source.slice(i, j > 0 ? j : source.length)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*--.*$/gm, "")
    // Todo espacio en blanco a uno solo: «insert into\n    quotes» se leía
    // como si no escribiera nada.
    .replace(/\s+/g, " ");
}

/**
 * Toda escritura a la base dentro de un cuerpo, se llame la tabla como se
 * llame. Una lista de tablas conocidas se burlaba escribiendo a otra.
 */
function escrituras(b) {
  // Insensible a mayúsculas y con `merge into`: la revisión burló la versión
  // anterior con `INSERT INTO` y con `merge … when not matched then insert`.
  // Lo que un recorrido de texto NO puede ver, y queda dicho: una escritura
  // dentro de una función auxiliar definida afuera, y un candado envuelto en
  // una rama muerta. Para eso están la revisión de dinero y `withTx`.
  return [...b.matchAll(/\b(insert\s+into|update|delete\s+from|merge\s+into)\s+[a-z_$]+/gi)].map((m) => ({ que: m[0], en: m.index }));
}

test("createQuote y reviseQuote exigen la declaración SIN legacy: ya tienen el selector", () => {
  // Eran las dos puertas por las que se creaban partidas con flete cero sin
  // decir por qué. El candado va donde está la salida, y ahora la salida está.
  const ops = src("src/lib/erp/ops.ts");
  for (const fn of ["createQuote", "reviseQuote"]) {
    const b = cuerpo(ops, fn);
    const k = b.indexOf("assertFreightDeclared(");
    assert.notEqual(k, -1, `${fn} llama la regla`);
    const llamada = b.slice(k, b.indexOf(");", k) + 2);
    assert.ok(!llamada.includes("legacy"), `${fn} es estricta: esta pantalla sí puede declarar`);
  }
  // `decideQuote` sigue con legacy: acepta cotizaciones de antes de la pieza.
  const dq = cuerpo(ops, "decideQuote");
  const k = dq.indexOf("assertFreightDeclared(");
  assert.ok(dq.slice(k, dq.indexOf(");", k) + 2).includes("{ legacy: true }"), "decideQuote no tranca lo viejo");
});

test("en createQuote y reviseQuote la validación corre ANTES de toda escritura de DINERO", () => {
  // La lección de la pieza 3, aplicada a las dos puertas nuevas: puesto
  // después, en un handler sin transacción, dejaba el documento a medias.
  // Se recorren TODAS las escrituras del cuerpo, no una lista de tablas, y se
  // exige que exista al menos una: un cuerpo «sin escrituras» sería la señal
  // de que el recorrido dejó de ver.
  const ops = src("src/lib/erp/ops.ts");
  for (const fn of ["createQuote", "reviseQuote", "duplicateQuote"]) {
    const b = cuerpo(ops, fn);
    const v = b.indexOf("assertFreightDeclared(");
    assert.notEqual(v, -1, `${fn} llama la regla`);
    // La llamada es una sentencia incondicional. Un candado colgado de un
    // `if (` —`if (x) assertFreightDeclared(...)` o `if (x) { assert… }`— es
    // un candado que a veces no está, y la revisión lo metió en una rama
    // muerta antes del real para que `indexOf` lo encontrara primero. Se mira
    // TODA aparición, y el tramo desde el último `;` hasta ella no puede
    // traer un `if (`.
    for (const m of b.matchAll(/assertFreightDeclared\(/g)) {
      const pre = b.slice(b.lastIndexOf(";", m.index) + 1, m.index);
      assert.ok(!/\bif\s*\(/.test(pre), `${fn}: la regla cuelga de una condición: «${pre.trim().slice(-80)}»`);
    }
    // `alter table … if not exists` es esquema idempotente, no dinero: se
    // deja fuera a propósito.
    const ws = escrituras(b).filter((w) => !/^update .*if not exists/.test(w.que));
    assert.ok(ws.length >= 2, `${fn}: el recorrido tiene que ver escrituras (vio ${ws.length})`);
    for (const w of ws) assert.ok(w.en > v, `${fn}: «${w.que}» está antes de la validación`);
  }
});

test("la partida NUEVA de una revisión despeja su margen CON el flete que guarda", () => {
  // La primera versión guardaba $500/u de flete pero despejaba el margen sin
  // él: $52,793.54 de utilidad fantasma en 100 unidades, y $629.92/u de más
  // al cliente al reconstruir el precio desde ese margen. El mismo defecto de
  // la pieza 3 — resuelto donde se guarda, no donde se decide.
  const b = cuerpo(src("src/lib/erp/ops.ts"), "reviseQuote");
  assert.ok(b.includes("const fleteNuevo = prev ? 0 : effectiveFreight(line.freightMode, line.freight);"), "se resuelve una vez, arriba del bucle");
  assert.ok(b.includes("costoNuevo(line.productId) + fleteNuevo;"), "y entra al costo puesto con el que se despeja el margen");
  assert.ok(b.includes("${fleteDeNueva(line)},"), "y es el mismo número que se guarda");
  assert.ok(b.includes("const fleteDeNueva = (line: { freightMode?: string; freight?: number }) => effectiveFreight(line.freightMode, line.freight);"), "con la misma regla, no una copia");
  // Con números, usando la fórmula REAL del margen: costo 10,000 + flete 500,
  // precio de contado 11,363.64 (12 % sobre 10,000). Con el flete adentro, el
  // margen real es 7.6 %, no 12 %.
  const conFlete = marginFromPrice({ price: 11363.64, landed: 10500, finance: 0, mode: "pct" });
  const sinFlete = marginFromPrice({ price: 11363.64, landed: 10000, finance: 0, mode: "pct" });
  assert.equal(Math.round(sinFlete.pct * 100) / 100, 12, "sin el flete el margen se ve completo");
  assert.equal(Math.round(conFlete.pct * 100) / 100, 7.6, "con el flete adentro, el margen real");
  assert.equal(Math.round((sinFlete.nominal - conFlete.nominal) * 100) / 100, 500, "$500/u de utilidad fantasma por unidad");
});

test("lo que se enmascara no se escribe: el flete de una cotización lo guarda quien lo ve", () => {
  // `listQuotes` manda el flete en cero a quien no ve costos; sin este
  // candado, un vendedor tecleaba «se le cobra $500» y movía $50,000 del
  // margen guardado sin ver el costo ni el margen — y sin bitácora.
  const ops = src("src/lib/erp/ops.ts");
  for (const fn of ["createQuote", "reviseQuote"]) {
    const b = cuerpo(ops, fn);
    // Por el IMPORTE, no por el modo: los dos ceros dichos no enseñan ningún
    // costo y ventas los sabe. Dispararlo por el modo dejaba a ventas sin
    // poder cotizar por /quotes el 100 % de las veces.
    assert.ok(b.includes('const cobra = data.lines.some((l) => l.freightMode === "cobrado" || Number(l.freight ?? 0) > 0.0001);'), `${fn}: el candado mira el importe`);
    assert.ok(b.includes("if (cobra && !canSeeCosts(me.role)) {"), `${fn}: el candado de rol`);
    assert.ok(b.includes("Sí puedes marcar «lo recoge» o «lo pone el proveedor»."), `${fn}: y nombra la salida que ventas SÍ tiene`);
    assert.ok(b.includes('action: "rechazado-permiso", entity: "quote"'), `${fn}: el intento negado queda en bitácora`);
    assert.ok(b.includes('action: "flete-de-cotizacion",'), `${fn}: y el flete declarado también`);
  }
  // La pantalla: el selector sigue abierto para ventas; «se le cobra» y el
  // importe, solo para quien ve costos.
  const qq = src("src/routes/quotes.tsx");
  assert.ok(qq.includes('<option value="cobrado" disabled={!canCharge}>'), "«se le cobra» se apaga a quien no ve costos");
  assert.ok(qq.includes('{mode === "cobrado" && canCharge ? ('), "y el importe también");
  assert.ok(!qq.includes("<select\n        className=\"erp-input h-7 w-36 text-[11px]\"\n        disabled="), "pero el selector NO se apaga entero");
  assert.ok(ops.includes("canSeeCosts: false,") && ops.includes("canSeeCosts: true }"), "listQuotes le dice a la pantalla si puede");
  const q = src("src/routes/quotes.tsx");
  assert.equal((q.match(/canCharge=\{!?!?data\??\.canSeeCosts\}/g) || []).length, 2, "y las dos filas saben si pueden cobrar");
  assert.ok(src("src/routes/bitacora.tsx").includes('"flete-de-cotizacion":'), "con nombre legible");
  assert.ok(src("src/lib/erp/audit.ts").includes('"flete-de-cotizacion",'), "y enmascarada, como el número que protege");
});

test("duplicateQuote pasa por la regla (con legacy), y el hueco que deja queda dicho", () => {
  const b = cuerpo(src("src/lib/erp/ops.ts"), "duplicateQuote");
  const k = b.indexOf("assertFreightDeclared(");
  assert.notEqual(k, -1, "la llama");
  assert.ok(b.slice(k, b.indexOf(");", k) + 2).includes("{ legacy: true }"), "con legacy: no tiene selector y la original puede ser vieja");
  const ins = b.indexOf("insert into quote_lines");
  assert.ok(k < ins, "y antes de escribir las partidas");
});

test("createQuote resuelve el flete efectivo UNA vez, arriba, y de ahí sale todo", () => {
  const b = cuerpo(src("src/lib/erp/ops.ts"), "createQuote");
  assert.ok(b.includes("const freight = effectiveFreight(l.freightMode, l.freight);"), "una vez, en el mapeo");
  assert.ok(b.includes("return { ...l, cash, credit, unit, freight };"), "y reemplaza el crudo en la partida");
  // De ahí en adelante `line.freight` YA es el efectivo: el costo puesto y lo
  // guardado lo leen sin volver a interpretar.
  assert.ok(b.includes("${line.freight}, ${line.other ?? 0}"), "lo guardado");
  assert.ok(!b.includes("effectiveFreight(line."), "y no se vuelve a resolver más abajo");
  assert.ok(b.includes("${line.freightMode ?? null},"), "con su modo");
});

test("la pantalla de Cotizaciones tiene el selector en las DOS filas y lo manda", () => {
  const q = src("src/routes/quotes.tsx");
  assert.equal((q.match(/<FreightPick/g) || []).length, 2, "la fila nueva y la partida nueva de una revisión");
  assert.ok(q.includes('<option value="recoge">Lo recoge</option>'), "las tres opciones");
  assert.ok(q.includes("freight: l.freight,\n            freightMode: l.freightMode,"), "createQuote las recibe");
  assert.ok(q.includes("freight: a.freight,\n                                        freightMode: a.freightMode,"), "reviseQuote las recibe para las nuevas");
  // El importe no se borra al cambiar de modo — la lección del selector de la
  // solicitud.
  assert.ok(q.includes("onChange({ freightMode: m, freight: amount });"), "cambiar de modo conserva el importe");
});
