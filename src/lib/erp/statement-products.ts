/**
 * Bloque "Por producto" del estado de cuenta.
 *
 * El estado de cuenta contesta UNA pregunta: cuánto debe el cliente y de qué.
 * Por eso este bloque muestra **saldo pendiente**, no venta del periodo: si
 * arriba va saldo y abajo venta, son dos cifras distintas en el mismo
 * documento y no cuadran.
 *
 * Reglas (3-sep-2026, prueba con el dueño):
 *   1. Saldo por producto, prorrateado por importe de partida. La suma del
 *      bloque da EXACTAMENTE el total de la tabla de arriba.
 *   2. Un solo criterio en todo el documento: lo que se filtra arriba
 *      ("Ocultar pagadas") se filtra aquí. Por eso el bloque se arma con los
 *      MISMOS renglones que ya se pintaron en la tabla, no con otra consulta.
 *   3. Monedas separadas: nunca un número que sume MXN con USD.
 *   4. Los cargos que no son mercancía (corte Compaq, mora, ajuste de TC) no
 *      son productos: van agrupados aparte, con su desglose.
 *
 * El corte Compaq entra por saldo abierto sin partidas, así que sí forma parte
 * del saldo de la tabla pero no se puede atribuir a un producto: va en "Otros
 * cargos", dentro del total. La mora facturada (FI) y el ajuste de tipo de
 * cambio (ATC) son documentos de otra clase, fuera de la tabla de arriba y por
 * lo tanto fuera del total: se listan aparte para que no desaparezcan.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Un renglón del estado de cuenta, visto por este bloque. */
export type StatementRow = {
  name: string;
  origin?: string | null;
  currency?: string | null;
  saldo: number;
  products: Array<{ product: string; amount: string | number }>;
};

export type ConceptTotal = {
  concept: string;
  saldo: number;
  /** Cuántos documentos aportaron a este concepto. */
  docs: number;
};

export type CurrencyBlock = {
  currency: string;
  /** Mercancía: un renglón por producto, de mayor a menor saldo. */
  products: ConceptTotal[];
  /** Cargos sin partida (corte Compaq y cualquier otro documento sin producto). */
  others: ConceptTotal[];
  othersTotal: number;
  /** Igual, al centavo, al total de saldo de la tabla de arriba en esa moneda. */
  total: number;
};

/** Orden de monedas: el mismo de la tabla de arriba. */
const CURRENCY_ORDER = ["MXN", "USD"];

function currencyRank(cur: string) {
  const i = CURRENCY_ORDER.indexOf(cur);
  return i < 0 ? CURRENCY_ORDER.length : i;
}

function addTo(map: Map<string, ConceptTotal>, concept: string, saldo: number) {
  const prev = map.get(concept);
  if (prev) {
    prev.saldo += saldo;
    prev.docs += 1;
  } else {
    map.set(concept, { concept, saldo, docs: 1 });
  }
}

function bySaldoDesc(a: ConceptTotal, b: ConceptTotal) {
  return Math.abs(b.saldo) - Math.abs(a.saldo) || a.concept.localeCompare(b.concept, "es");
}

/**
 * Reparte el saldo de cada documento entre sus productos, a prorrata del
 * importe de la partida, y separa por moneda.
 *
 * `rows` son los renglones que la tabla de arriba YA está mostrando (clase
 * producto, del cliente, con el filtro de pagadas aplicado). Eso es lo que
 * garantiza el mismo criterio y el mismo total.
 */
export function statementByProduct(rows: StatementRow[]): CurrencyBlock[] {
  const currencies = [...new Set(rows.map((r) => r.currency || "MXN"))].sort(
    (a, b) => currencyRank(a) - currencyRank(b) || a.localeCompare(b),
  );
  return currencies.map((currency) => {
    const set = rows.filter((r) => (r.currency || "MXN") === currency);
    const total = set.reduce((s, r) => s + r.saldo, 0);
    const products = new Map<string, ConceptTotal>();
    const others = new Map<string, ConceptTotal>();
    for (const r of set) {
      const lineSum = r.products.reduce((s, l) => s + Number(l.amount), 0);
      // Sin partidas (o con partidas en cero) no hay a qué producto atribuirlo:
      // el saldo no se pierde, se va a "Otros cargos" con su concepto.
      if (!r.products.length || !(lineSum > 0)) {
        addTo(others, r.origin || r.name, r.saldo);
        continue;
      }
      for (const l of r.products) {
        addTo(products, l.product, (r.saldo * Number(l.amount)) / lineSum);
      }
    }
    const productList = [...products.values()].sort(bySaldoDesc);
    const otherList = [...others.values()].sort(bySaldoDesc);
    // Cuadre al centavo contra el total de la tabla: los importes se redondean
    // para mostrarse, y el renglón más grande absorbe la diferencia. Así lo que
    // se lee en pantalla suma exactamente lo que dice el total. El centavo cae
    // en un producto (de ahí sale el prorrateo); "Otros cargos" son saldos
    // completos de documentos y quedan exactos.
    const items = [...productList, ...otherList];
    let acc = 0;
    for (const it of items) {
      it.saldo = round2(it.saldo);
      acc += it.saldo;
    }
    const diff = round2(round2(total) - round2(acc));
    const ajustables = productList.length ? productList : otherList;
    if (diff !== 0 && ajustables.length) {
      const biggest = ajustables.reduce((m, it) => (Math.abs(it.saldo) >= Math.abs(m.saldo) ? it : m), ajustables[0]!);
      biggest.saldo = round2(biggest.saldo + diff);
    }
    return {
      currency,
      products: productList,
      others: otherList,
      othersTotal: round2(otherList.reduce((s, o) => s + o.saldo, 0)),
      total: round2(total),
    };
  });
}

export type OutsideDoc = {
  name: string;
  concept: string;
  currency: string;
  saldo: number;
};

/**
 * Documentos del cliente que no son mercancía y que tampoco están en la tabla
 * de arriba: mora facturada (FI) y ajuste de tipo de cambio (ATC). No entran al
 * total del bloque — no se suman dos veces — pero se listan para que ningún
 * cargo desaparezca del documento.
 *
 * `rows` aquí son TODOS los renglones del bloque del cliente; el filtro de
 * pagadas se pasa aparte para que sea el mismo criterio de arriba.
 */
export function statementOutsideDocs(
  rows: Array<StatementRow & { kind: string; inv_class?: string | null }>,
  hidePaid: boolean,
): OutsideDoc[] {
  return rows
    .filter((r) => r.kind === "customer" && (r.inv_class || "product") !== "product")
    .filter((r) => !hidePaid || Math.abs(r.saldo) > 0.009)
    .map((r) => ({
      name: r.name,
      concept: r.origin || r.name,
      currency: r.currency || "MXN",
      saldo: round2(r.saldo),
    }))
    .sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo) || a.name.localeCompare(b.name, "es"));
}
