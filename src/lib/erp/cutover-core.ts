/**
 * Corazón del importador del corte Compaq (saldos abiertos y existencias),
 * SIN dependencias de servidor — solo tipos — para poder probarlo de verdad
 * contra PGlite (`scripts/erp-corte.test.mjs`), como `parciales.ts` y
 * `credit-limit.ts`. Las envolturas con permisos, transacción y bitácora
 * viven en `cutover.ts`.
 *
 * Lo que el catálogo o el kardex necesitan del mundo exterior entra por
 * parámetro (`foldName`, `postStock`, `today`): el módulo no importa nada
 * con alias en tiempo de ejecución, que es lo que dejaría fuera a las
 * pruebas de node --test.
 */
import type { Sql } from "@/lib/db";

export type InvRow = {
  partnerCode: string;
  folio: string;
  date: string;
  due: string;
  cargo: number;
  abono: number;
  saldo: number;
  currency: "MXN" | "USD";
  // "unknown" = la columna «lado» no dice cliente o proveedor (vacía, ausente
  // o con otra palabra). No se adivina (hallazgo #7, regla 9): la fila se
  // rechaza con motivo en el apply y se marca en el preview.
  kind: "customer" | "supplier" | "unknown";
};

export type StockRow = {
  productCode: string;
  locationCode: string;
  qty: number;
  cost: number;
};

function splitCsv(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/**
 * Celdas de una fila. Con tabulador es TSV (Excel). Con comas, CSV real
 * (RFC 4180): un campo entre comillas puede traer comas adentro ("GRUPO
 * AGRICOLA, S.A. DE C.V.", "1,500.00") y una comilla doblada ("") es una
 * comilla literal. Antes era `split(",")`: la coma de la razón social corría
 * todas las columnas una posición y la fila entraba con dinero de la columna
 * equivocada, sin aviso (hallazgo #10).
 */
function cells(line: string) {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  // Comillas sin par (TUBO 2",001,10,50 — pulgadas en un código): no es un
  // campo entrecomillado; se lee como siempre para que la fila no desaparezca.
  if (((line.match(/"/g) || []).length & 1) === 1) return line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** El lado del saldo, por la columna 9 y solo por ella: cliente o proveedor; lo demás no se adivina. */
function sideOf(lado: string): InvRow["kind"] {
  const v = (lado || "").trim();
  if (/^(prov|proveedor|proveedores|por\s*pagar|pagar|cxp|c\s*x\s*p|supplier|fp)$/i.test(v)) return "supplier";
  if (/^(cli|cliente|clientes|por\s*cobrar|cobrar|cxc|c\s*x\s*c|customer|fv)$/i.test(v)) return "customer";
  return "unknown";
}

function num(v: string) {
  const n = Number(String(v || "0").replace(/,/g, "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function parseOpenInvoices(raw: string, today: string): InvRow[] {
  const lines = splitCsv(raw);
  const out: InvRow[] = [];
  for (const line of lines) {
    const c = cells(line);
    if (!c[0] || (/codigo|código|partner|cliente|proveedor|folio/i.test(c[0]!) && out.length === 0)) continue;
    // Hallazgo #7: antes, sin columna «lado», miraba la columna 1 (el CÓDIGO
    // del socio) y, como no decía "prov", todo entraba como cuenta por cobrar.
    const kind = sideOf(c[8] || "");
    const folio = (c[1] || c[2] || "").replace(/\s+/g, "-");
    const saldo = num(c[6] || c[5] || "0");
    if (!folio || Math.abs(saldo) < 0.009) continue;
    out.push({
      partnerCode: (c[0] || "").toUpperCase(),
      folio,
      date: (c[2] || c[3] || today).slice(0, 10),
      due: (c[3] || c[4] || c[2] || today).slice(0, 10),
      cargo: num(c[4] || c[5] || "0"),
      abono: num(c[5] || "0"),
      saldo,
      currency: /usd|dll/i.test(c[7] || "") ? "USD" : "MXN",
      kind,
    });
  }
  return out;
}

export function parseStockSnap(raw: string): StockRow[] {
  const out: StockRow[] = [];
  for (const line of splitCsv(raw)) {
    const c = cells(line);
    if (!c[0] || (/producto|codigo|código|code/i.test(c[0]!) && out.length === 0)) continue;
    const qty = num(c[2] || c[1] || "0");
    if (qty <= 0.0001) continue;
    out.push({
      productCode: (c[0] || "").toUpperCase(),
      locationCode: (c[1] || "001").toUpperCase(),
      qty,
      // Decisión 64: el costo viene SOLO de la columna 4. El respaldo viejo
      // (c[3] || c[2]) copiaba la CANTIDAD como costo cuando la columna venía
      // vacía — un número inventado que decidía dinero.
      cost: num(c[3] || "0"),
    });
  }
  return out;
}

export function cutoverKeyOf(r: InvRow) {
  return `${r.kind}:${r.partnerCode}:${r.folio}`;
}

/** ¿Dos importes son el mismo dinero? Mismo umbral que usa el parseo (± 0.009). */
function sameMoney(a: number, b: number) {
  return Math.abs(a - b) < 0.009;
}

export async function previewOpenInvoiceRows(sql: Sql, o: { companyId: number; rows: InvRow[]; today?: string }) {
  const rows: (InvRow & { key: string; partnerName: string; partnerId: number; skip: boolean; differs?: string; problem?: string })[] = [];
  const fx = await fxAtCutover(sql, o.companyId, o.today);
  for (const r of o.rows) {
    const key = cutoverKeyOf(r);
    const problem = rowProblem(r, fx);
    if (problem) {
      rows.push({ ...r, key, partnerName: "", partnerId: 0, skip: false, problem });
      continue;
    }
    const exists = await sql<{ id: number; amount: string; opening_paid: string; fx_agreed: string }>`
      select id, amount::text, coalesce(opening_paid, 0)::text as opening_paid, coalesce(fx_agreed, 0)::text as fx_agreed
      from invoices where company_id = ${o.companyId} and cutover_key = ${key} limit 1
    `;
    const partner = await sql<{ id: number; name: string }>`
      select id, name from partners where company_id = ${o.companyId} and upper(code) = ${r.partnerCode} limit 1
    `;
    // Decisión 65: lo ya cargado que llega con OTROS importes no se ignora en
    // silencio — se compara contra lo congelado al importar (amount y
    // opening_paid no cambian con los cobros posteriores; residual sí, por
    // eso no se compara contra residual).
    let differs: string | undefined;
    if (exists[0]) {
      // Decisión 70: lo guardado de una fila USD está en pesos al TC del
      // corte; se compara en dólares, en la moneda del CSV, para que un TC
      // distinto hoy no alarme por nada.
      const div = r.currency === "USD" && Number(exists[0].fx_agreed) > 0 ? Number(exists[0].fx_agreed) : 1;
      const storedCargo = Number(exists[0].amount) / div;
      const storedSaldo = (Number(exists[0].amount) - Number(exists[0].opening_paid)) / div;
      const csvCargo = r.cargo || r.saldo + r.abono;
      if (!sameMoney(storedCargo, csvCargo) || !sameMoney(storedSaldo, r.saldo)) {
        differs = `Folio ${r.folio}: ya está cargado con cargo ${storedCargo} y saldo de corte ${storedSaldo}; el CSV trae cargo ${csvCargo} y saldo ${r.saldo}. No se aplica — si el bueno es el nuevo, se corrige la factura a mano.`;
      }
    }
    rows.push({
      ...r,
      key,
      partnerName: partner[0]?.name ?? "",
      partnerId: partner[0]?.id ?? 0,
      skip: Boolean(exists[0]),
      ...(differs ? { differs } : {}),
    });
  }
  return {
    rows,
    open: rows.filter((r) => !r.skip && !r.problem).length,
    skipped: rows.filter((r) => r.skip).length,
    differing: rows.filter((r) => r.differs).length,
    problems: rows.filter((r) => r.problem).length,
  };
}

function sideProblem(r: InvRow) {
  return `Fila ${r.partnerCode} · folio ${r.folio}: la columna «lado» no dice cliente o proveedor (viene vacía o con otra palabra). No se adivina: corrige el CSV y vuelve a pegar.`;
}

/**
 * Lo que detiene una fila ANTES de mirar el catálogo, en el mismo orden en el
 * apply y en el preview: sin lado (hallazgo #7) y saldo negativo (Decisión
 * 71: un anticipo o NC abierta de Compaq no entra como factura — hoy se
 * colapsaría a $0 al primer recálculo — se rechaza a la vista y se captura
 * cuando exista el saldo a favor de la Decisión 12).
 */
function rowProblem(r: InvRow, fx: FxPick | null): string | null {
  if (r.kind === "unknown") return sideProblem(r);
  if (r.saldo < 0) {
    return `Fila ${r.partnerCode} · folio ${r.folio}: saldo a favor (${r.saldo} ${r.currency}). Un anticipo o nota de crédito abierta de Compaq no entra como factura; se captura cuando exista el saldo a favor del cliente (Decisión 71).`;
  }
  if (r.currency === "USD" && !fx) {
    return `Fila ${r.partnerCode} · folio ${r.folio}: saldo en dólares y no hay tipo de cambio en la tabla para la fecha del corte. Captúralo en Ajustes → Tipo de cambio y vuelve a pegar (Decisión 70: no se inventa un TC).`;
  }
  return null;
}

export type FxPick = { rate: number; date: string };

/**
 * Decisión 70: el TC del corte es el último renglón de la tabla con fecha ≤ la
 * fecha del corte (hoy). Sin renglón, las filas en USD se rechazan — regla 9.
 */
export async function fxAtCutover(sql: Sql, companyId: number, today?: string): Promise<FxPick | null> {
  // Sin fecha (solo pruebas): el último renglón de la tabla. cutover.ts
  // siempre pasa todayMx() — aquí no se calcula "hoy" (sería UTC).
  const rows = await sql<{ date: string; usd_mxn: string }>`
    select date::text, usd_mxn::text from fx_rates
    where company_id = ${companyId} and (${today ?? null}::date is null or date <= ${today ?? null}::date)
    order by date desc limit 1
  `;
  return rows[0] && Number(rows[0].usd_mxn) > 0 ? { rate: Number(rows[0].usd_mxn), date: rows[0].date } : null;
}

/**
 * USD × TC al centavo, sin el error de coma flotante: 999.99 × 18.5 es
 * 18,499.815 exacto, pero la máquina calcula 18,499.81499… y `Math.round`
 * daría 18,499.81. Con centavos y millonésimas enteros el producto es exacto
 * y el redondeo es el de la aritmética, no el del float.
 */
function usdToMxn(usd: number, rate: number) {
  return Math.round((Math.round(usd * 100) * Math.round(rate * 1e6)) / 1e6) / 100;
}

/**
 * Preview de existencias (no existía): los mismos candados que el apply —
 * sin costo (Decisión 64), sin catálogo (Decisión 66) — y la comparación de
 * la Decisión 65 contra el saldo inicial ya cargado, ANTES de aplicar nada.
 */
export async function previewStockRows(sql: Sql, o: { companyId: number; rows: StockRow[] }) {
  const rows: (StockRow & { skip: boolean; differs?: string; problem?: string })[] = [];
  for (const r of o.rows) {
    if (!(r.cost > 0)) {
      rows.push({ ...r, skip: false, problem: `Producto ${r.productCode} sin costo en el CSV: captura el costo real (vacío no es cero).` });
      continue;
    }
    const product = await sql<{ id: number }>`
      select id from products where company_id = ${o.companyId} and upper(code) = ${r.productCode} limit 1
    `;
    if (!product[0]) {
      rows.push({ ...r, skip: false, problem: `Producto ${r.productCode} no está en catálogo` });
      continue;
    }
    const loc = await sql<{ id: number }>`
      select id from locations
      where company_id = ${o.companyId} and (upper(code) = ${r.locationCode} or upper(name) = ${r.locationCode})
      limit 1
    `;
    if (!loc[0]) {
      rows.push({ ...r, skip: false, problem: `Bodega ${r.locationCode} no está en catálogo` });
      continue;
    }
    const already = await sql<{ quantity: string; unit_cost: string }>`
      select quantity::text, coalesce(unit_cost, 0)::text as unit_cost
      from stock_moves
      where company_id = ${o.companyId} and product_id = ${product[0].id} and location_to = ${loc[0].id}
        and move_type = 'opening' and origin = 'Corte Compaq'
      limit 1
    `;
    if (!already[0]) {
      rows.push({ ...r, skip: false });
      continue;
    }
    const storedQty = Number(already[0].quantity);
    const storedCost = Number(already[0].unit_cost);
    let differs: string | undefined;
    if (!sameMoney(storedQty, r.qty) || !sameMoney(storedCost, r.cost)) {
      differs = `${r.productCode} en ${r.locationCode}: ya está el saldo inicial con ${storedQty} a ${storedCost}; el CSV trae ${r.qty} a ${r.cost}. No se aplica — si el bueno es el nuevo, se ajusta en inventario.`;
    }
    rows.push({ ...r, skip: true, ...(differs ? { differs } : {}) });
  }
  return {
    rows,
    open: rows.filter((x) => !x.skip && !x.problem).length,
    skipped: rows.filter((x) => x.skip).length,
    differing: rows.filter((x) => x.differs).length,
    problems: rows.filter((x) => x.problem).length,
  };
}

export async function applyOpenInvoiceRows(
  sql: Sql,
  o: {
    companyId: number;
    userId: string;
    policyCode: string;
    circuitCode: string;
    rows: InvRow[];
    today?: string;
    // Decisión 72: días del plazo financiero de estos saldos (la columna
    // «vence» del CSV es el día 120). cutover.ts lo exige; sin él (solo
    // pruebas viejas) la factura queda como antes: sin credit_due.
    creditDays?: number;
    foldName: (s: string) => string;
  },
) {
  let inserted = 0;
  let skipped = 0;
  // Decisión 66: una fila mala no aborta el lote — se reporta con su razón y
  // las válidas entran. El reintento es seguro: lo ya cargado se salta por
  // cutover_key.
  const rejected: { reason: string }[] = [];
  const fx = await fxAtCutover(sql, o.companyId, o.today);
  for (const row of o.rows) {
    let r = row;
    const key = cutoverKeyOf(r);
    const exists = await sql<{ id: number }>`
      select id from invoices where company_id = ${o.companyId} and cutover_key = ${key} limit 1
    `;
    if (exists[0]) {
      skipped += 1;
      continue;
    }
    const problem = rowProblem(r, fx);
    if (problem) {
      rejected.push({ reason: problem });
      continue;
    }
    let partner = await sql<{ id: number }>`
      select id from partners where company_id = ${o.companyId} and upper(code) = ${r.partnerCode} limit 1
    `;
    if (!partner[0]) {
      const folded = o.foldName(r.partnerCode);
      partner = await sql<{ id: number }>`
        select id from partners where company_id = ${o.companyId} and upper(name) = ${folded} limit 1
      `;
    }
    if (!partner[0]) {
      rejected.push({ reason: `No está en catálogo el código ${r.partnerCode} (folio ${r.folio}). Carga catálogos Compaq primero.` });
      continue;
    }
    // Decisión 70: una fila en dólares entra en PESOS al TC del corte (como
    // toda FV USD del sistema, Decisión 2): cargo, abono y saldo en pesos,
    // amount_fx = el cargo en USD, fx_agreed = ese TC. Una fila MXN no pasa
    // por aquí y no cambia ni un centavo.
    const usd = row.currency === "USD";
    const cargoUsd = row.cargo || row.saldo + row.abono;
    const rate = usd ? fx!.rate : 1;
    if (usd) r = { ...row, cargo: usdToMxn(row.cargo, rate), abono: usdToMxn(row.abono, rate), saldo: usdToMxn(row.saldo, rate) };
    const cargo = r.cargo || r.saldo + r.abono;
    // El abono que ya traía en Compaq queda registrado: el saldo de aquí
    // en adelante es cargo − abono de corte − pagos capturados en el sistema.
    const openingPaid = Math.max(0, cargo - r.saldo);
    // Decisión 72: «vence» (due_date) es cobranza; la mora corre desde
    // credit_due = fecha + días elegidos en /importar, y credit_days lo dice.
    // Solo al cliente: la deuda con el proveedor no lleva plazo financiero
    // (la mora es de cartera por cobrar) y escribírselo sería un dato falso.
    const cd = r.kind === "customer" && o.creditDays && o.creditDays > 0 ? Math.round(o.creditDays) : null;
    await sql`
      insert into invoices (company_id, kind, name, partner_id, date, due_date, state, amount, residual, origin, currency, cutover_key, opening_paid, policy_code, created_by, circuit_code, amount_fx, fx_agreed, credit_due, credit_days)
      values (
        ${o.companyId}, ${r.kind}, ${r.folio}, ${partner[0].id}, ${r.date}, ${r.due}, 'open',
        ${cargo}, ${r.saldo}, ${"Corte Compaq"}, ${r.currency}, ${key}, ${openingPaid}, ${o.policyCode}, ${o.userId},
        ${r.kind === "customer" ? o.circuitCode : null}, ${usd ? cargoUsd : 0}, ${usd ? rate : 1},
        ${cd == null ? null : r.date}::date + ${cd ?? 0}::int, ${cd ?? 0}
      )
    `;
    inserted += 1;
  }
  return { inserted, skipped, rejected };
}

export type PostStockFn = (
  sql: Sql,
  args: {
    companyId: number;
    userId: string;
    moveType: "opening";
    origin: string;
    productId: number;
    quantity: number;
    locationTo: number;
    unitCost: number;
  },
) => Promise<unknown>;

export async function applyStockRows(
  sql: Sql,
  o: { companyId: number; userId: string; rows: StockRow[]; postStock: PostStockFn },
) {
  let inserted = 0;
  let skipped = 0;
  const rejected: { reason: string }[] = [];
  for (const r of o.rows) {
    // Decisión 64: sin costo no hay saldo inicial — vacío no es cero (regla 9).
    // A costo $0, toda venta posterior calcularía margen y financiamiento
    // sobre un costo inventado.
    if (!(r.cost > 0)) {
      rejected.push({ reason: `Producto ${r.productCode} sin costo en el CSV: captura el costo real (vacío no es cero).` });
      continue;
    }
    const product = await sql<{ id: number }>`
      select id from products where company_id = ${o.companyId} and upper(code) = ${r.productCode} limit 1
    `;
    if (!product[0]) {
      rejected.push({ reason: `Producto ${r.productCode} no está en catálogo` });
      continue;
    }
    const loc = await sql<{ id: number }>`
      select id from locations
      where company_id = ${o.companyId} and (upper(code) = ${r.locationCode} or upper(name) = ${r.locationCode})
      limit 1
    `;
    if (!loc[0]) {
      rejected.push({ reason: `Bodega ${r.locationCode} no está en catálogo` });
      continue;
    }
    const already = await sql<{ id: number }>`
      select id from stock_moves
      where company_id = ${o.companyId} and product_id = ${product[0].id} and location_to = ${loc[0].id}
        and move_type = 'opening' and origin = 'Corte Compaq'
      limit 1
      for update
    `;
    if (already[0]) {
      skipped += 1;
      continue;
    }
    await o.postStock(sql, {
      companyId: o.companyId,
      userId: o.userId,
      moveType: "opening",
      origin: "Corte Compaq",
      productId: product[0].id,
      quantity: r.qty,
      locationTo: loc[0].id,
      unitCost: r.cost,
    });
    inserted += 1;
  }
  return { inserted, skipped, rejected };
}

// ---------------------------------------------------------------------------
// Bancos del corte (Decisión 63, migración 0038).
//
// El saldo inicial de cada cuenta entra como un MOVIMIENTO de banco con
// fecha y rastro (`bank_moves`, kind 'saldo-inicial', cutover_key
// 'bank:CUENTA'), no pisando `banks.opening`. El saldo en pantalla ya es
// opening + Σ movimientos, así que cuadra sin tocar ningún lector. Nace
// conciliado: el saldo inicial ES el estado de cuenta del banco, el ancla
// contra la que se concilia lo demás.
//
// Candado contra el doble conteo: una cuenta con `opening` capturado a mano
// (≠ 0) se rechaza — si también entrara el movimiento, sumaría dos veces.
// El candado en sentido contrario (no capturar `opening` a mano cuando ya
// hay movimiento de corte) vive en saveBankOpening (ops.ts).
// ---------------------------------------------------------------------------

export type BankRow = { account: string; amount: number; date: string };

export const BANK_CUTOVER_KIND = "saldo-inicial";
export const BANK_CUTOVER_MEMO = "Saldo inicial — Corte Compaq";

export function parseBankSnap(raw: string, today: string): BankRow[] {
  const out: BankRow[] = [];
  for (const line of splitCsv(raw)) {
    const c = cells(line);
    if (!c[0] || (/cuenta|banco|account|bank/i.test(c[0]!) && out.length === 0)) continue;
    const amount = num(c[1] || "0");
    if (Math.abs(amount) < 0.009) continue;
    out.push({ account: (c[0] || "").toUpperCase(), amount, date: (c[2] || today).slice(0, 10) });
  }
  return out;
}

/**
 * La llave es por la CUENTA ENCONTRADA (su id), no por el texto tecleado: la
 * misma cuenta pegada una vez por nombre y otra por número es una sola.
 */
export function bankKeyOf(bankId: number) {
  return `bank:${bankId}`;
}

async function findBank(sql: Sql, companyId: number, account: string) {
  return sql<{ id: number; name: string; opening: string }>`
    select id, name, opening::text from banks
    where company_id = ${companyId} and (upper(name) = ${account} or upper(account) = ${account})
    limit 1
  `;
}

export async function previewBankRows(sql: Sql, o: { companyId: number; rows: BankRow[] }) {
  const rows: (BankRow & { key: string; bankId: number; bankName: string; skip: boolean; differs?: string; problem?: string })[] = [];
  for (const r of o.rows) {
    const bank = await findBank(sql, o.companyId, r.account);
    if (!bank[0]) {
      rows.push({ ...r, key: "", bankId: 0, bankName: "", skip: false, problem: `Cuenta ${r.account} no está en Bancos: créala primero.` });
      continue;
    }
    const key = bankKeyOf(bank[0].id);
    const exists = await sql<{ amount: string }>`
      select amount::text from bank_moves where company_id = ${o.companyId} and cutover_key = ${key} limit 1
    `;
    if (exists[0]) {
      const stored = Number(exists[0].amount);
      const differs = sameMoney(stored, r.amount)
        ? undefined
        : `Cuenta ${r.account}: ya está el saldo inicial con ${stored}; el CSV trae ${r.amount}. No se aplica — si el bueno es el nuevo, se ajusta con un movimiento de banco.`;
      rows.push({ ...r, key, bankId: bank[0].id, bankName: bank[0].name, skip: true, ...(differs ? { differs } : {}) });
      continue;
    }
    if (!sameMoney(Number(bank[0].opening), 0)) {
      rows.push({
        ...r, key, bankId: bank[0].id, bankName: bank[0].name, skip: false,
        problem: `Cuenta ${r.account} ya tiene saldo inicial capturado a mano en Bancos (${Number(bank[0].opening)}): déjalo en 0 antes de importar, o no importes esta cuenta.`,
      });
      continue;
    }
    rows.push({ ...r, key, bankId: bank[0].id, bankName: bank[0].name, skip: false });
  }
  return {
    rows,
    open: rows.filter((x) => !x.skip && !x.problem).length,
    skipped: rows.filter((x) => x.skip).length,
    differing: rows.filter((x) => x.differs).length,
    problems: rows.filter((x) => x.problem).length,
  };
}

export async function applyBankRows(sql: Sql, o: { companyId: number; userId: string; rows: BankRow[] }) {
  let inserted = 0;
  let skipped = 0;
  const rejected: { reason: string }[] = [];
  for (const r of o.rows) {
    const bank = await findBank(sql, o.companyId, r.account);
    if (!bank[0]) {
      rejected.push({ reason: `Cuenta ${r.account} no está en Bancos: créala primero.` });
      continue;
    }
    const key = bankKeyOf(bank[0].id);
    const exists = await sql<{ id: number }>`
      select id from bank_moves where company_id = ${o.companyId} and cutover_key = ${key} limit 1
    `;
    if (exists[0]) {
      skipped += 1;
      continue;
    }
    if (!sameMoney(Number(bank[0].opening), 0)) {
      rejected.push({
        reason: `Cuenta ${r.account} ya tiene saldo inicial capturado a mano en Bancos (${Number(bank[0].opening)}): déjalo en 0 antes de importar, o no importes esta cuenta.`,
      });
      continue;
    }
    await sql`
      insert into bank_moves (company_id, bank_id, date, amount, memo, kind, reconciled, created_by, cutover_key)
      values (${o.companyId}, ${bank[0].id}, ${r.date}, ${r.amount}, ${BANK_CUTOVER_MEMO}, ${BANK_CUTOVER_KIND}, true, ${o.userId}, ${key})
    `;
    inserted += 1;
  }
  return { inserted, skipped, rejected };
}
