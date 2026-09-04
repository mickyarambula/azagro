import { chargesCaptured, policyChargesInterest, type PolicyCharges } from "@/lib/erp/credit";

/**
 * Quién está en cada política de cobro (panel de Ajustes, solo lectura).
 *
 * La política NO vive en el cliente: vive en cada documento (el pedido la elige
 * al nacer y su factura la hereda). Así que "cuántos clientes tiene Estándar"
 * solo se puede contestar mirando las facturas abiertas: un cliente con
 * documentos de dos políticas aparece en las dos, y se dice.
 *
 * Se cuenta lo que sigue debiendo (saldo > 0) y solo mercancía, la misma
 * población del estado de cuenta: las FI de mora y los ajustes de TC no se
 * negocian, se derivan.
 *
 * Los renglones son EXCLUYENTES entre sí. Un documento cuya política no tiene
 * contestadas las dos preguntas no cuenta para esa política: cae en el renglón
 * "sin política capturada", que es el que importa — esos son exactamente los
 * que hoy se detienen al cobrar y salen marcados en el estado de cuenta.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

const CURRENCY_ORDER = ["MXN", "USD"];

function currencyRank(cur: string) {
  const i = CURRENCY_ORDER.indexOf(cur);
  return i < 0 ? CURRENCY_ORDER.length : i;
}

/** Una fila de la consulta: política × cliente × moneda. */
export type PolicyUsageInput = {
  policyCode: string;
  partnerId: number;
  partnerCode: string;
  partnerName: string;
  groupName: string;
  currency: string;
  invoices: number;
  saldo: number;
};

export type PolicyMoney = { currency: string; invoices: number; saldo: number };

export type PolicyClient = {
  id: number;
  code: string;
  name: string;
  group: string;
  invoices: number;
  byCurrency: PolicyMoney[];
  /** Qué códigos traen sus documentos (importa en el renglón sin capturar). */
  policyCodes: string[];
};

export type PolicyUsageRow = {
  /** Código de la política, o "" para el renglón de los que no la tienen capturada. */
  code: string;
  name: string;
  captured: boolean;
  commission: boolean | null;
  fega: boolean | null;
  /** Falso en «Sin mora»: esos documentos no generan interés. */
  chargesInterest: boolean;
  clients: number;
  invoices: number;
  byCurrency: PolicyMoney[];
  clientsList: PolicyClient[];
};

export const SIN_POLITICA = "";

function sortCurrencies(list: PolicyMoney[]) {
  return list.sort((a, b) => currencyRank(a.currency) - currencyRank(b.currency) || a.currency.localeCompare(b.currency));
}

function addMoney(list: PolicyMoney[], currency: string, invoices: number, saldo: number) {
  const prev = list.find((m) => m.currency === currency);
  if (prev) {
    prev.invoices += invoices;
    prev.saldo += saldo;
  } else {
    list.push({ currency, invoices, saldo });
  }
}

export function groupPolicyUsage(
  rows: PolicyUsageInput[],
  policies: Array<{ code: string; name: string } & PolicyCharges>,
): PolicyUsageRow[] {
  const byCode = new Map(policies.map((p) => [p.code, p]));
  const buckets = new Map<string, PolicyUsageRow>();
  const clients = new Map<string, Map<number, PolicyClient>>();

  const bucket = (code: string) => {
    let b = buckets.get(code);
    if (!b) {
      const pol = byCode.get(code);
      b = {
        code,
        name: code === SIN_POLITICA ? "Sin política capturada" : (pol?.name ?? code),
        captured: code !== SIN_POLITICA,
        commission: pol?.commission ?? null,
        fega: pol?.fega ?? null,
        chargesInterest: code === SIN_POLITICA ? true : policyChargesInterest(code),
        clients: 0,
        invoices: 0,
        byCurrency: [],
        clientsList: [],
      };
      buckets.set(code, b);
      clients.set(code, new Map());
    }
    return b;
  };

  // Un renglón por política del catálogo, aunque no tenga a nadie: ver un cero
  // también es información. Y siempre el renglón de los que no la tienen
  // capturada, aunque esté vacío — que esté vacío es la buena noticia.
  for (const p of policies) bucket(p.code);
  bucket(SIN_POLITICA);

  for (const r of rows) {
    const pol = byCode.get(r.policyCode);
    // Sin las dos preguntas contestadas el documento no cuenta para su
    // política: se detiene al cobrar, y ahí es donde hay que verlo.
    const key = pol && chargesCaptured(pol) ? r.policyCode : SIN_POLITICA;
    const b = bucket(key);
    b.invoices += r.invoices;
    addMoney(b.byCurrency, r.currency || "MXN", r.invoices, r.saldo);

    const map = clients.get(key)!;
    let c = map.get(r.partnerId);
    if (!c) {
      c = {
        id: r.partnerId,
        code: r.partnerCode,
        name: r.partnerName,
        group: r.groupName,
        invoices: 0,
        byCurrency: [],
        policyCodes: [],
      };
      map.set(r.partnerId, c);
    }
    c.invoices += r.invoices;
    addMoney(c.byCurrency, r.currency || "MXN", r.invoices, r.saldo);
    const etiqueta = r.policyCode || "(sin política)";
    if (!c.policyCodes.includes(etiqueta)) c.policyCodes.push(etiqueta);
  }

  const out = [...buckets.values()];
  for (const b of out) {
    const list = [...clients.get(b.code)!.values()];
    for (const c of list) {
      sortCurrencies(c.byCurrency);
      for (const m of c.byCurrency) m.saldo = round2(m.saldo);
      c.policyCodes.sort();
    }
    // El cliente que más debe, primero: es con quien se negocia.
    list.sort((a, b2) => saldoTotalOrden(b2) - saldoTotalOrden(a) || a.name.localeCompare(b2.name, "es"));
    b.clientsList = list;
    b.clients = list.length;
    sortCurrencies(b.byCurrency);
    for (const m of b.byCurrency) m.saldo = round2(m.saldo);
  }
  // Orden: las políticas como vienen del catálogo, y el renglón sin capturar
  // al final (es el que se lee después de los otros, no un caso más).
  const orden = new Map(policies.map((p, i) => [p.code, i]));
  return out.sort(
    (a, b) => (a.code === SIN_POLITICA ? 1 : 0) - (b.code === SIN_POLITICA ? 1 : 0) ||
      (orden.get(a.code) ?? 0) - (orden.get(b.code) ?? 0),
  );
}

/**
 * Solo para ordenar la lista de clientes de un renglón. NO es un total: mezclar
 * monedas en pantalla está prohibido, y por eso este número no se muestra.
 */
function saldoTotalOrden(c: PolicyClient) {
  return c.byCurrency.reduce((s, m) => s + m.saldo, 0);
}
