import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LogoLockup } from "@/components/brand";
import { Field, FinanceNav } from "@/components/erp";
import { SearchSelect, asOpts } from "@/components/search-select";
import { SendButton } from "@/components/send-doc";
import { getLiveStatement, saveDocument } from "@/lib/erp/ops";
import { pctRate } from "@/lib/erp/credit";
import { statementByProduct, statementOutsideDocs } from "@/lib/erp/statement-products";
import { CONSOLIDADO_NOTE, PAPER_DASH, PAPER_PENDING, statementNotes, statementSendHeader, statementSendLine } from "@/lib/erp/doc-text";
import { logoSrc, printHtml, statementSheet } from "@/lib/print-doc";
import { listPartners } from "@/lib/azagro";
import { dateDMY, money, moneyIn, todayMx } from "@/lib/utils";

export const Route = createFileRoute("/statements")({ component: Page });

type Live = Awaited<ReturnType<typeof getLiveStatement>>;
type Block = Live["statements"][number];
type Row = Block["rows"][number];

const EC_HEADERS = [
  "Serie",
  "Folio",
  "Fecha",
  "Plazo",
  "Vencimiento",
  "Días vence",
  "Cargo",
  "Abonos",
  "Saldo",
  "Fecha pago",
  "Días vencidos",
  "Interés s/ días",
  "Comisión + FEGA",
  "Total int+FEGA",
  "Pronto pago (est.)",
];

const EC_HEADERS_USD = [...EC_HEADERS, "Ut. cambiaria"];

// El papel que sale de la empresa y el documento guardado NO llevan la
// columna de pronto pago: la bonificación se ofrece cuando conviene, no se
// anuncia en cada estado de cuenta, y su importe entre cargo y días despeja
// la tasa de costo. Solo en pantalla.
const EC_HEADERS_PAPER = EC_HEADERS.filter((h) => h !== "Pronto pago (est.)");
const EC_HEADERS_PAPER_USD = [...EC_HEADERS_PAPER, "Ut. cambiaria"];

function currencyName(cur: string) {
  return cur === "USD" ? "Dólar americano" : "Peso mexicano";
}

function productRows(block: Block, hidePaid: boolean) {
  return block.rows.filter((r) => {
    if (r.kind !== "customer") return false;
    if ((r.inv_class || "product") !== "product") return false;
    if (hidePaid && r.saldo <= 0.009) return false;
    return true;
  });
}

/**
 * Una factura que NO ha vencido no trae interés ni comisión ni FEGA: no
 * existen todavía. En su lugar se muestran los días que faltan y, aparte, la
 * estimación de pronto pago (lo que se le bonificaría si pagara al corte).
 *
 * `paper`: la versión que sale de la empresa. En pantalla la celda dice POR QUÉ
 * no hay número ("sin TIIE", "sin política", "sin mora"). En el papel, lo que
 * falta determinar dice "Pendiente de cálculo" (el cliente entiende que algo
 * viene) y lo que no se cobra sale como guion; el motivo real es nuestro. La
 * columna de pronto pago no va en el papel.
 */
function rowCells(r: Row, cur: string, withFx: boolean, paper = false) {
  const pend = (t: string) => (paper ? PAPER_PENDING : t);
  const nada = (t: string) => (paper ? PAPER_DASH : t);
  const cells = [
    r.serie || "—",
    r.folio || r.name,
    dateDMY(r.date),
    r.plazo ? String(r.plazo) : "—",
    dateDMY(r.due_date),
    r.vencido || r.diasPorVencer <= 0 ? String(r.daysVence ?? r.daysOverdue ?? 0) : `faltan ${r.diasPorVencer}`,
    moneyIn(r.cargo ?? r.amount, cur),
    r.abono ? moneyIn(r.abono, cur) : "—",
    moneyIn(r.saldo ?? r.residual, cur),
    r.fechaPago ? dateDMY(r.fechaPago) : r.fechaAbono ? dateDMY(r.fechaAbono) : "—",
    r.vencido ? String(r.daysVencidos ?? r.daysOverdue ?? 0) : "—",
    r.sinMora ? nada("sin mora") : r.sinTiie ? pend("sin TIIE") : !r.vencido ? "—" : Math.abs(r.interes) > 0.009 ? moneyIn(r.interes, cur) : "—",
    r.sinMora ? nada("sin mora") : r.sinTiie ? pend("sin TIIE") : !r.vencido ? "—" : r.sinPolitica ? pend("sin política") : r.comisionFega > 0.009 ? moneyIn(r.comisionFega, cur) : "—",
    r.sinMora ? nada("sin mora") : r.sinTiie ? pend("sin TIIE") : !r.vencido ? "—" : r.sinPolitica ? pend("sin política") : Math.abs(r.totalFinanciero) > 0.009 ? moneyIn(r.totalFinanciero, cur) : "—",
    ...(paper ? [] : [r.sinTiieBono ? "sin TIIE" : r.bonificacion > 0.009 ? moneyIn(r.bonificacion, cur) : "—"]),
  ];
  if (withFx) cells.push(Math.abs(r.utCambiaria) > 0.009 ? moneyIn(r.utCambiaria, cur) : "—");
  return cells;
}

function totalsCells(rows: Row[], cur: string, withFx: boolean, paper = false) {
  const cargo = rows.reduce((s, r) => s + (r.cargo ?? Number(r.amount)), 0);
  const abono = rows.reduce((s, r) => s + r.abono, 0);
  const saldo = rows.reduce((s, r) => s + (r.saldo ?? Number(r.residual)), 0);
  const interes = rows.reduce((s, r) => s + r.interes, 0);
  const com = rows.reduce((s, r) => s + r.comisionFega, 0);
  const tot = rows.reduce((s, r) => s + r.totalFinanciero, 0);
  const bono = rows.reduce((s, r) => s + r.bonificacion, 0);
  const fx = rows.reduce((s, r) => s + r.utCambiaria, 0);
  const cells = [
    "",
    "Total",
    "",
    "",
    "",
    "",
    moneyIn(cargo, cur),
    moneyIn(abono, cur),
    moneyIn(saldo, cur),
    "",
    "",
    moneyIn(interes, cur),
    moneyIn(com, cur),
    moneyIn(tot, cur),
    ...(paper ? [] : [moneyIn(bono, cur)]),
  ];
  if (withFx) cells.push(moneyIn(fx, cur));
  return cells;
}

// Las tasas del encabezado salen de Ajustes tal cual llegan en el estado de
// cuenta; sin estado de cuenta se muestran guiones, nunca un número de
// respaldo. La TIIE no es una sola: cada renglón usa la de su vencimiento
// (tabla), por eso la tasa anual se describe y no se suma aquí.
function ratesOf(st: Live | null) {
  if (!st) return { commission: "—", annual: "—", fega: "—", total: "—" };
  const p = st.policy;
  return {
    commission: pctRate(p.commissionRate),
    annual: `TIIE al vencimiento + ${pctRate(p.collectionSpread)}`,
    fega: pctRate(p.fegaOnlyRate),
    total: pctRate(p.fegaBundle),
  };
}

function printStatement(block: Block, asOf: string, legal: string, st: Live | null, hidePaid: boolean) {
  const all = productRows(block, hidePaid);
  const from = all[0] ? dateDMY(all.reduce((m, r) => (r.date < m ? r.date : m), all[0]!.date)) : undefined;
  const sections = (["MXN", "USD"] as const)
    .map((cur) => {
      const rows = all.filter((r) => (r.currency || "MXN") === cur);
      const withFx = cur === "USD";
      return {
        currency: currencyName(cur),
        headers: withFx ? EC_HEADERS_PAPER_USD : EC_HEADERS_PAPER,
        rows: rows.map((r) => rowCells(r, cur, withFx, true)),
        totals: totalsCells(rows, cur, withFx, true),
      };
    })
    .filter((s) => s.rows.length);
  printHtml(
    `EC ${block.partner.name}`,
    statementSheet({
      logoSrc: logoSrc(),
      legalName: legal,
      rfc: st?.policy.rfc,
      party: block.partner.legal_name || block.partner.name,
      partyCode: block.partner.code,
      asOf: dateDMY(asOf),
      periodFrom: from,
      rates: ratesOf(st),
      sections,
      // Texto que sale de la empresa: solo lo que el cliente necesita para
      // comprobar la cuenta (src/lib/erp/doc-text.ts).
      notes: statementNotes(ratesOf(st)),
    }),
    {
      title: "Estado de cuenta",
      number: `corte ${dateDMY(asOf)}`,
      party: block.partner.name,
      partnerId: block.partner.id,
    },
    { landscape: true },
  );
}

function printConsolidado(list: Block[], asOf: string, legal: string, st: Live | null) {
  const headers = ["Cliente", "Cargo", "Abonos", "Saldo", "Interés s/ días", "Comisión + FEGA", "Total int+FEGA"];
  const sections = (["MXN", "USD"] as const).map((cur) => {
    const rows = list
      .map((b) => {
        const tot = b.byCurrency?.find((c) => c.currency === cur);
        if (!tot || Math.abs(tot.cargo) < 0.009) return null;
        return [
          b.partner.name,
          moneyIn(tot.cargo, cur),
          moneyIn(tot.abono, cur),
          moneyIn(tot.saldo, cur),
          moneyIn(tot.interes, cur),
          moneyIn(tot.comisionFega, cur),
          moneyIn(tot.totalFinanciero, cur),
        ];
      })
      .filter((r): r is string[] => r != null);
    const sum = list.reduce(
      (acc, b) => {
        const tot = b.byCurrency?.find((c) => c.currency === cur);
        if (!tot) return acc;
        acc.cargo += tot.cargo;
        acc.abono += tot.abono;
        acc.saldo += tot.saldo;
        acc.interes += tot.interes;
        acc.comisionFega += tot.comisionFega;
        acc.totalFinanciero += tot.totalFinanciero;
        return acc;
      },
      { cargo: 0, abono: 0, saldo: 0, interes: 0, comisionFega: 0, totalFinanciero: 0 },
    );
    return {
      currency: currencyName(cur),
      headers,
      rows,
      totals: [
        "Total",
        moneyIn(sum.cargo, cur),
        moneyIn(sum.abono, cur),
        moneyIn(sum.saldo, cur),
        moneyIn(sum.interes, cur),
        moneyIn(sum.comisionFega, cur),
        moneyIn(sum.totalFinanciero, cur),
      ],
    };
  });
  printHtml(
    `EC consolidado ${asOf}`,
    statementSheet({
      logoSrc: logoSrc(),
      legalName: legal,
      rfc: st?.policy.rfc,
      party: "Consolidado",
      asOf: dateDMY(asOf),
      rates: ratesOf(st),
      sections,
      notes: CONSOLIDADO_NOTE,
    }),
    undefined,
    { landscape: true },
  );
}

function Page() {
  const [partners, setPartners] = useState<Awaited<ReturnType<typeof listPartners>>>([]);
  const [partnerId, setPartnerId] = useState(0);
  const [group, setGroup] = useState("");
  const [asOf, setAsOf] = useState(() => todayMx());
  const [st, setSt] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [viewId, setViewId] = useState<number | null>(null);
  const [showZero, setShowZero] = useState(false);
  const [hidePaid, setHidePaid] = useState(false);
  const [openFormula, setOpenFormula] = useState<number | null>(null);

  useEffect(() => {
    void listPartners().then(setPartners);
  }, []);

  async function load() {
    setError(null);
    try {
      setSt(
        await getLiveStatement({
          data: {
            partnerId: group ? undefined : partnerId || undefined,
            groupName: group || undefined,
            asOf,
          },
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }

  useEffect(() => {
    void load();
  }, [partnerId, group, asOf]);

  const groups = useMemo(() => {
    const s = new Set(partners.map((p) => (p as { group_name?: string }).group_name).filter(Boolean));
    return [...s] as string[];
  }, [partners]);

  function sendMailto(block: Block, asOfDate: string | undefined, legal: string | undefined) {
    const to =
      block.contacts.find((c) => c.is_billing && c.email)?.email ||
      block.contacts.find((c) => c.email)?.email ||
      block.partner.email;
    const rates = ratesOf(st);
    const body = [
      `Estado de cuenta ${block.partner.legal_name || block.partner.name} (${block.partner.code})`,
      `Corte ${asOfDate} · ${legal}`,
      `Comisión ${rates.commission} · Tasa anual ${rates.annual} · FEGA ${rates.fega} · Total ${rates.total}`,
      ``,
      `Saldo: ${money(block.ar)}`,
      ``,
      EC_HEADERS_PAPER.join(" | "),
      ...productRows(block, hidePaid).map((r) => rowCells(r, r.currency || "MXN", false, true).join(" | ")),
    ].join("\n");
    void saveDocument({
      data: {
        kind: "statement",
        title: `EC ${block.partner.name} ${asOfDate}`,
        partnerId: block.partner.id,
        body,
      },
    });
    const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(
      `Estado de cuenta ${block.partner.name} — ${asOfDate}`,
    )}&body=${encodeURIComponent(body)}`;
    window.location.href = href;
  }

  const list = st?.statements ?? [];
  const visible = showZero ? list : list.filter((b) => b.ar > 0.009);
  const allOn = visible.length > 0 && visible.every((b) => picked[b.partner.id]);
  const viewing = list.find((b) => b.partner.id === viewId);
  const rates = ratesOf(st);

  return (
    <AppShell>
      <FinanceNav current="statements" />
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Estados de cuenta</h1>
        <p className="text-sm text-muted">
          El papel que se manda al cliente: lo que Compaq lanza (cargo, abono, saldo) más plazo, fecha de pago, días, interés, comisión y FEGA — igual que el Excel de cartera. MXN y USD aparte.
        </p>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <Field label="Corte">
            <input className="erp-input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <Field label="Grupo">
            <select
              className="erp-input"
              value={group}
              onChange={(e) => {
                setGroup(e.target.value);
                if (e.target.value) setPartnerId(0);
              }}
            >
              <option value="">Todos</option>
              {groups.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </Field>
          <Field label="Cliente">
            <SearchSelect
              value={partnerId ? String(partnerId) : ""}
              options={asOpts(partners.filter((p) => p.is_customer), (p) => p.id, (p) => `${p.code}  ${p.name}`)}
              onChange={(v) => setPartnerId(Number(v) || 0)}
              allowEmpty
              emptyLabel="Todos"
              placeholder="Buscar cliente…"
              disabled={!!group}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="erp-btn"
            onClick={() => {
              list.filter((b) => picked[b.partner.id]).forEach((b) => sendMailto(b, st?.asOf, st?.policy.legalName));
              setMsg("Listo para enviar");
            }}
          >
            Enviar seleccionados
          </button>
          <button type="button" className="erp-btn" onClick={() => setShowZero((v) => !v)}>
            {showZero ? "Ocultar sin saldo" : "Mostrar sin saldo"}
          </button>
          {group ? (
            <button
              type="button"
              className="erp-btn"
              onClick={() => printConsolidado(list, st?.asOf ?? asOf, st?.policy.legalName || "AZ INSUMOS AGRICOLAS SA DE CV", st)}
            >
              Consolidado
            </button>
          ) : null}
          <button
            type="button"
            className="erp-btn-primary"
            onClick={() => {
              const shown = list.filter((b) => picked[b.partner.id] || b.partner.id === viewId);
              const target = shown[0] ?? list[0];
              if (!target) return;
              printStatement(target, st?.asOf ?? asOf, st?.policy.legalName || "AZ INSUMOS AGRICOLAS SA DE CV", st, hidePaid);
            }}
          >
            Documento / PDF
          </button>
        </div>
      </div>

      <p className="mb-3 text-[12px] text-muted">
        Encabezado del papel: Comisión {rates.commission} · Tasa anual {rates.annual} · FEGA {rates.fega} · Total {rates.total}.
        La tasa de cada factura usa la TIIE de su vencimiento.
      </p>

      <div className="mb-6 overflow-x-auto erp-card">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={allOn}
                  onChange={(e) => {
                    const on = e.target.checked;
                    const next: Record<number, boolean> = {};
                    for (const b of list) next[b.partner.id] = on;
                    setPicked(next);
                  }}
                />
              </th>
              <th className="px-3 py-3 font-medium">Cliente</th>
              <th className="px-3 py-3 font-medium">Envío</th>
              <th className="px-3 py-3 font-medium">Plazo</th>
              <th className="px-3 py-3 text-right font-medium">Vencido</th>
              <th className="px-3 py-3 text-right font-medium">Saldo</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {visible.map((block) => {
              const overdue = block.rows.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + Number(r.residual), 0);
              const email =
                block.contacts.find((c) => c.is_billing && c.email)?.email ||
                block.contacts.find((c) => c.email)?.email ||
                block.partner.email;
              return (
                <tr key={block.partner.id} className="border-t border-line">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={!!picked[block.partner.id]}
                      onChange={(e) => setPicked((p) => ({ ...p, [block.partner.id]: e.target.checked }))}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <span className="font-medium">{block.partner.name}</span>
                    <span className="ml-2 text-[11px] text-muted">{block.partner.code}</span>
                  </td>
                  <td className="px-3 py-3 text-muted">{email ? `Email: ${email}` : "Email: —"}</td>
                  <td className="px-3 py-3">{block.partner.payment_days ? `Net ${block.partner.payment_days}` : "Por pedido"}</td>
                  <td className={`px-3 py-3 text-right tabular-nums ${overdue ? "text-warn" : "text-muted"}`}>{money(overdue)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{money(block.ar)}</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" className="erp-btn-primary h-8 text-[12px]" onClick={() => setViewId(block.partner.id)}>
                      Ver
                    </button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted">
                  {list.length === 0
                    ? "Sin saldos al corte. Aparecen al entregar y facturar pedidos. Los saldos Compaq 2024–2026 no se pegan aquí."
                    : "Nadie con saldo. Usa «Mostrar sin saldo» para ver el catálogo."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {viewing && (
        <StatementView
          viewing={viewing}
          st={st}
          asOf={asOf}
          hidePaid={hidePaid}
          setHidePaid={setHidePaid}
          openFormula={openFormula}
          setOpenFormula={setOpenFormula}
          onClose={() => setViewId(null)}
          rates={rates}
        />
      )}
    </AppShell>
  );
}

function StatementView({
  viewing,
  st,
  asOf,
  hidePaid,
  setHidePaid,
  openFormula,
  setOpenFormula,
  onClose,
  rates,
}: {
  viewing: Block;
  st: Live | null;
  asOf: string;
  hidePaid: boolean;
  setHidePaid: (v: boolean) => void;
  openFormula: number | null;
  setOpenFormula: (n: number | null) => void;
  onClose: () => void;
  rates: ReturnType<typeof ratesOf>;
}) {
  const rows = productRows(viewing, hidePaid);
  const currencies = ["MXN", "USD"].filter((c) => rows.some((r) => (r.currency || "MXN") === c));
  // El bloque "Por producto" se arma con los MISMOS renglones que la tabla:
  // un solo criterio de filtrado y, por lo tanto, el mismo total.
  const blocks = statementByProduct(rows);
  const outside = statementOutsideDocs(viewing.rows, hidePaid);

  return (
    <div className="fixed inset-0 z-50 grid place-items-start overflow-y-auto bg-ink/40 p-4 pt-[6vh]" onClick={onClose}>
      <article className="mb-8 w-full max-w-[1180px] erp-card p-5" onClick={(e) => e.stopPropagation()}>
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
          <div>
            <LogoLockup height="h-12" className="mb-3" />
            <p className="text-xs font-semibold tracking-widest text-forest">{st?.policy.legalName}</p>
            <h2 className="text-lg font-semibold">{viewing.partner.legal_name || viewing.partner.name}</h2>
            <p className="text-sm text-muted">
              {viewing.partner.code} · corte {dateDMY(st?.asOf)} · Comisión {rates.commission} · Tasa {rates.annual} · FEGA {rates.fega}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted">Saldo</p>
            <p className="text-2xl font-semibold tabular-nums">{money(viewing.ar)}</p>
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" className="erp-btn" onClick={onClose}>Cerrar</button>
              <button
                type="button"
                className="erp-btn"
                onClick={() => setHidePaid(!hidePaid)}
              >
                {hidePaid ? "Ver pagadas" : "Ocultar pagadas"}
              </button>
              <button
                type="button"
                className="erp-btn"
                onClick={() => printStatement(viewing, st?.asOf ?? asOf, st?.policy.legalName || "AZ INSUMOS AGRICOLAS SA DE CV", st, hidePaid)}
              >
                Documento
              </button>
              <SendButton
                title="Estado de cuenta"
                number={`corte ${st?.asOf ?? ""}`}
                party={viewing.partner.name}
                partnerId={viewing.partner.id}
                email={viewing.partner.email}
                phone={viewing.partner.phone}
                total={viewing.ar}
                extra={[statementSendHeader(rates), ...rows.map((r) => statementSendLine(r))].join("\n")}
              />
            </div>
          </div>
        </header>
        <p className="mt-3 text-[12px] text-muted">
          Compaq no trae plazo, pago, mora ni FEGA. Aquí sí: interés = cargo × ({rates.annual}) × días vencidos / 360, y solo desde el día que vence. Toca el interés para ver el desglose.
        </p>
        <p className="mt-1 text-[12px] text-muted">
          Lo que todavía no vence no lleva interés, ni comisión, ni FEGA: sale el saldo, su vencimiento y los días que faltan. «Pronto pago (est.)» es una estimación
          aparte —lo que se bonificaría si pagara en la fecha del corte— a tasa de costo (TIIE de la emisión + spread ASR), no a la de cobro, y solo si el pago cae
          antes del umbral de pronto pago de Ajustes ({st?.policy.earlyPayDays ?? "—"} d).
        </p>
        {rows.some((r) => r.sinTiie) ? (
          <p className="mt-2 rounded-md border border-danger bg-cream px-3 py-2 text-[12px] text-danger">
            {rows.filter((r) => r.sinTiie).length} documento(s) sin TIIE en la tabla para su vencimiento: interés y comisión/FEGA sin calcular (no se estiman). Captura la TIIE en Ajustes → Tabla TIIE.
          </p>
        ) : null}
        {rows.some((r) => r.sinPolitica) ? (
          <p className="mt-2 rounded-md border border-danger bg-cream px-3 py-2 text-[12px] text-danger">
            {rows.filter((r) => r.sinPolitica).length} documento(s) vencido(s) con una política de cobro que todavía no dice si cobra comisión y si cobra FEGA
            ({[...new Set(rows.filter((r) => r.sinPolitica).map((r) => r.politicaNombre || r.politicaCode || "(sin política)"))].join(", ")}):
            no se cobra ninguna de las dos y la factura de intereses se detiene. Captúralo en Ajustes → Políticas de cobro.
          </p>
        ) : null}
        {rows.some((r) => r.sinTiieBono) ? (
          <p className="mt-2 rounded-md border border-warn bg-cream px-3 py-2 text-[12px] text-warn">
            {rows.filter((r) => r.sinTiieBono).length} documento(s) sin TIIE en la tabla para su fecha de emisión: la estimación de pronto pago no se calcula (no se inventa tasa). Captúrala en Ajustes → Tabla TIIE.
          </p>
        ) : null}
        {currencies.map((cur) => {
          const set = rows.filter((r) => (r.currency || "MXN") === cur);
          const withFx = cur === "USD";
          const headers = withFx ? EC_HEADERS_USD : EC_HEADERS;
          const tot = totalsCells(set, cur, withFx);
          return (
            <div key={cur} className="mt-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-forest">
                Moneda: {currencyName(cur)}
              </h3>
              <div className="mt-1 overflow-x-auto">
                <table className="w-full min-w-[1100px] text-left text-[12px]">
                  <thead className="text-[10px] uppercase tracking-wide text-muted">
                    <tr>
                      {headers.map((h) => (
                        <th key={h} className={`py-1 font-medium ${h === "Serie" || h === "Folio" ? "" : "text-right"}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {set.map((r) => (
                      <Fragment key={r.id}>
                        <tr className="border-t border-line">
                          {rowCells(r, cur, withFx).map((c, i) => (
                            <td
                              key={`${r.id}-${i}`}
                              className={`py-1.5 tabular-nums ${i < 2 ? "text-left font-medium" : "text-right"} ${
                                i === 11 && r.daysVencidos > 0 ? "text-warn" : ""
                              }`}
                            >
                              {i === 11 ? (
                                <button
                                  type="button"
                                  className="underline decoration-dotted"
                                  onClick={() => setOpenFormula(openFormula === r.id ? null : r.id)}
                                >
                                  {c}
                                </button>
                              ) : (
                                c
                              )}
                            </td>
                          ))}
                        </tr>
                        {openFormula === r.id && (
                          <tr className="bg-paper">
                            <td colSpan={headers.length} className="px-3 py-3">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Cálculo</p>
                              <p className="mt-1 font-mono text-[13px]">{r.formula}</p>
                              <ul className="mt-2 space-y-1 text-[12px] text-muted">
                                {r.formulaLines.map((l) => (
                                  <li key={l}>{l}</li>
                                ))}
                              </ul>
                              {r.dateErrors.map((e) => (
                                <p key={e} className="mt-1 text-[12px] text-danger">{e}</p>
                              ))}
                              {r.dateWarnings.map((e) => (
                                <p key={e} className="mt-1 text-[12px] text-warn">{e}</p>
                              ))}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                    <tr className="border-t border-ink/40">
                      {tot.map((c, i) => (
                        <td key={`t-${i}`} className={`py-2 text-[12px] font-semibold tabular-nums ${i < 2 ? "" : "text-right"}`}>{c}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
        {(blocks.length > 0 || outside.length > 0) && (
          <>
            <h3 className="mt-5 text-sm font-semibold">Por producto — saldo pendiente</h3>
            <p className="mt-1 text-[12px] text-muted">
              El mismo saldo de la tabla de arriba, repartido entre los productos a prorrata del importe de cada partida
              (no es la venta del periodo). Mismo criterio que arriba:{" "}
              {hidePaid ? "las pagadas también están ocultas aquí" : "las pagadas también se incluyen aquí"}.
            </p>
            {blocks.map((b) => (
              <div key={b.currency} className="mt-3">
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-forest">
                  Moneda: {currencyName(b.currency)}
                </h4>
                <table className="mt-1 w-full text-left text-[13px]">
                  <tbody>
                    {b.products.map((p) => (
                      <tr key={`p-${p.concept}`} className="border-t border-line">
                        <td className="py-1.5 pr-6">{p.concept}</td>
                        <td className="w-40 py-1.5 text-right tabular-nums">{moneyIn(p.saldo, b.currency)}</td>
                      </tr>
                    ))}
                    {b.others.length > 0 && (
                      <Fragment key="otros">
                        <tr className="border-t border-line">
                          <td className="py-1.5 pr-6">
                            Otros cargos <span className="text-muted">(no son mercancía)</span>
                          </td>
                          <td className="w-40 py-1.5 text-right tabular-nums">{moneyIn(b.othersTotal, b.currency)}</td>
                        </tr>
                        {b.others.map((o) => (
                          <tr key={`o-${o.concept}`}>
                            <td className="py-1 pl-5 pr-6 text-[12px] text-muted">
                              {o.concept}
                              {o.docs > 1 ? ` · ${o.docs} documentos` : ""}
                            </td>
                            <td className="w-40 py-1 text-right text-[12px] text-muted tabular-nums">
                              {moneyIn(o.saldo, b.currency)}
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    )}
                    <tr className="border-t border-ink/40">
                      <td className="py-2 pr-6 font-semibold">
                        Total en {b.currency === "USD" ? "dólares" : "pesos"}{" "}
                        <span className="font-normal text-muted">= saldo de la tabla de arriba</span>
                      </td>
                      <td className="w-40 py-2 text-right font-semibold tabular-nums">
                        {moneyIn(b.total, b.currency)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ))}
            {outside.length > 0 && (
              <div className="mt-4">
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-forest">
                  Otros cargos facturados aparte
                </h4>
                <p className="mt-1 text-[12px] text-muted">
                  No son mercancía y tampoco están en la tabla de arriba: cada uno es su propio documento, así que no
                  entran en el total. La mora que todavía no se factura ya sale arriba, en «Interés s/ días».
                </p>
                <table className="mt-1 w-full text-left text-[13px]">
                  <tbody>
                    {outside.map((d) => (
                      <tr key={`f-${d.name}`} className="border-t border-line">
                        <td className="py-1.5 pr-6">
                          <span className="font-medium">{d.name}</span>
                          {d.concept && d.concept !== d.name ? <span className="text-muted"> · {d.concept}</span> : null}
                        </td>
                        <td className="w-40 py-1.5 text-right tabular-nums">{moneyIn(d.saldo, d.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </article>
    </div>
  );
}
