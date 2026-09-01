import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LogoLockup } from "@/components/brand";
import { Field, FinanceNav } from "@/components/erp";
import { SearchSelect, asOpts } from "@/components/search-select";
import { SendButton } from "@/components/send-doc";
import { getLiveStatement, saveDocument } from "@/lib/erp/ops";
import { pctRate } from "@/lib/erp/credit";
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
];

const EC_HEADERS_USD = [...EC_HEADERS, "Ut. cambiaria"];

function productRows(block: Block, hidePaid: boolean) {
  return block.rows.filter((r) => {
    if (r.kind !== "customer") return false;
    if ((r.inv_class || "product") !== "product") return false;
    if (hidePaid && r.saldo <= 0.009) return false;
    return true;
  });
}

function rowCells(r: Row, cur: string, withFx: boolean) {
  const cells = [
    r.serie || "—",
    r.folio || r.name,
    dateDMY(r.date),
    r.plazo ? String(r.plazo) : "—",
    dateDMY(r.due_date),
    String(r.daysVence ?? r.daysOverdue ?? 0),
    moneyIn(r.cargo ?? r.amount, cur),
    r.abono ? moneyIn(r.abono, cur) : "—",
    moneyIn(r.saldo ?? r.residual, cur),
    r.fechaPago ? dateDMY(r.fechaPago) : r.fechaAbono ? dateDMY(r.fechaAbono) : "—",
    String(r.daysVencidos ?? r.daysOverdue ?? 0),
    Math.abs(r.interes) > 0.009 ? moneyIn(r.interes, cur) : "—",
    r.comisionFega > 0.009 ? moneyIn(r.comisionFega, cur) : "—",
    Math.abs(r.totalFinanciero) > 0.009 ? moneyIn(r.totalFinanciero, cur) : "—",
  ];
  if (withFx) cells.push(Math.abs(r.utCambiaria) > 0.009 ? moneyIn(r.utCambiaria, cur) : "—");
  return cells;
}

function totalsCells(rows: Row[], cur: string, withFx: boolean) {
  const cargo = rows.reduce((s, r) => s + (r.cargo ?? Number(r.amount)), 0);
  const abono = rows.reduce((s, r) => s + r.abono, 0);
  const saldo = rows.reduce((s, r) => s + (r.saldo ?? Number(r.residual)), 0);
  const interes = rows.reduce((s, r) => s + r.interes, 0);
  const com = rows.reduce((s, r) => s + r.comisionFega, 0);
  const tot = rows.reduce((s, r) => s + r.totalFinanciero, 0);
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
  ];
  if (withFx) cells.push(moneyIn(fx, cur));
  return cells;
}

function ratesOf(st: Live | null) {
  const annual = (st?.policy.defaultTiie ?? 0) + (st?.policy.collectionSpread ?? 0.09);
  const commission = st?.policy.commissionRate ?? 0.01;
  const fega = st?.policy.fegaOnlyRate ?? 0.0204;
  const bundle = st?.policy.fegaBundle ?? st?.policy.fegaRate ?? 0.0304;
  return {
    commission: pctRate(commission),
    annual: pctRate(annual),
    fega: pctRate(fega),
    total: pctRate(bundle),
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
        currency: cur === "USD" ? "Dólar americano" : "Peso mexicano",
        headers: withFx ? EC_HEADERS_USD : EC_HEADERS,
        rows: rows.map((r) => rowCells(r, cur, withFx)),
        totals: totalsCells(rows, cur, withFx),
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
      notes: [
        "Compaq solo trae cargo, abono y saldo. Este papel le agrega plazo, fecha de pago, días, interés, comisión y FEGA — igual que el Excel de cartera.",
        "Interés = Cargo × (TIIE al vencimiento + 9%) × días vencidos / 360. Días negativos = pronto pago.",
        `Comisión ${ratesOf(st).commission} + FEGA ${ratesOf(st).fega} = ${ratesOf(st).total} sobre el cargo, una sola vez, factura FI.`,
        "Saldo = cargo − abonos. No se mezcla con intereses. Ut. cambiaria = USD × (TC pactado − TC pagado).",
      ].join("\n"),
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
      currency: cur === "USD" ? "Dólar americano" : "Peso mexicano",
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
      notes: "Totales por cliente y moneda, mismo papel que la hoja Consolidado del Excel de cartera.",
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
      EC_HEADERS.join(" | "),
      ...productRows(block, hidePaid).map((r) => rowCells(r, r.currency || "MXN", false).join(" | ")),
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
        Encabezado del papel: Comisión {rates.commission} · Tasa anual {rates.annual} (TIIE + 9%) · FEGA {rates.fega} · Total {rates.total}.
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
                extra={rows
                  .map((r) =>
                    `${r.serie || ""} ${r.folio || r.name}  ${dateDMY(r.date)}  plazo ${r.plazo || "—"}  cargo ${moneyIn(r.cargo, r.currency)}  abono ${r.abono ? moneyIn(r.abono, r.currency) : "—"}  saldo ${moneyIn(r.saldo, r.currency)}  ${r.daysVencidos} d  int ${moneyIn(r.interes, r.currency)}  C+FEGA ${moneyIn(r.comisionFega, r.currency)}`,
                  )
                  .join("\n")}
              />
            </div>
          </div>
        </header>
        <p className="mt-3 text-[12px] text-muted">
          Compaq no trae plazo, pago, mora ni FEGA. Aquí sí: interés = cargo × (TIIE al vencimiento + 9%) × días / 360 (con signo). Toca el interés para ver el desglose.
        </p>
        {currencies.map((cur) => {
          const set = rows.filter((r) => (r.currency || "MXN") === cur);
          const withFx = cur === "USD";
          const headers = withFx ? EC_HEADERS_USD : EC_HEADERS;
          const tot = totalsCells(set, cur, withFx);
          return (
            <div key={cur} className="mt-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-forest">
                Moneda: {cur === "USD" ? "Dólar americano" : "Peso mexicano"}
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
        {Object.keys(viewing.byProduct).length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-semibold">Por producto</h3>
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
              {Object.entries(viewing.byProduct).map(([name, amt]) => (
                <li key={name} className="flex justify-between border-b border-line py-1">
                  <span>{name}</span>
                  <span className="tabular-nums">{money(amt)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </article>
    </div>
  );
}
