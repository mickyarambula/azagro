/** Documento formal: se abre en el visor del ERP (no en about:blank). */

export type DocSend = {
  title?: string;
  number?: string;
  party?: string;
  partnerId?: number;
  email?: string | null;
  phone?: string | null;
  extra?: string;
};

declare global {
  interface Window {
    __azagroOpenDoc?: (title: string, html: string, send?: DocSend) => void;
  }
}

export function printHtml(title: string, body: string, send?: DocSend, opts?: { landscape?: boolean }) {
  const page = opts?.landscape
    ? "@page { size: letter landscape; margin: 10mm; }"
    : "@page { size: letter; margin: 14mm; }";
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>
  ${page}
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { font-family: "DM Sans", ui-sans-serif, system-ui, sans-serif; color: #14201c; margin: 0; background: #fff; }
  .sheet { max-width: 1100px; margin: 0 auto; padding: 18px 20px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #1f6b3a; padding-bottom: 14px; }
  img.logo { height: 52px; }
  .co { text-align: right; font-size: 11px; line-height: 1.45; color: #4b5c56; }
  .co strong { display: block; color: #14201c; font-size: 13px; }
  h1 { font-size: 18px; margin: 18px 0 4px; letter-spacing: 0.04em; text-transform: uppercase; }
  .meta { font-size: 12px; color: #4b5c56; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: #4b5c56; border-bottom: 1px solid #d8e0dc; padding: 6px 4px; }
  td { border-bottom: 1px solid #eef1ef; padding: 8px 4px; vertical-align: top; }
  .r { text-align: right; font-variant-numeric: tabular-nums; }
  .tot { margin-top: 12px; text-align: right; font-size: 16px; font-weight: 700; }
  .note { margin-top: 22px; font-size: 11px; color: #4b5c56; line-height: 1.5; white-space: pre-line; }
  .sign { margin-top: 36px; font-size: 12px; }
  table.wide { font-size: 10.5px; }
  table.wide th, table.wide td { padding: 5px 3px; white-space: nowrap; }
  table.wide td:first-child, table.wide th:first-child { white-space: normal; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 28px; margin: 16px 0; font-size: 13px; }
  .grid2 .k { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: #4b5c56; }
  .grid2 .v { font-weight: 600; border-bottom: 1px solid #d8e0dc; min-height: 22px; }
  .signs { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; margin-top: 40px; font-size: 12px; }
  .signs p { border-top: 1px solid #14201c; padding-top: 8px; min-height: 64px; }
  .signs img { max-height: 72px; display: block; margin-top: 6px; }
  .guia-banner { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin: 18px 0 6px; }
  .guia-banner h1 { margin: 0; font-size: 22px; letter-spacing: 0.12em; }
  .folio { text-align: right; }
  .folio .k { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: #4b5c56; }
  .folio .n { font-size: 22px; font-weight: 700; letter-spacing: 0.04em; }
  .signs4 { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; margin-top: 36px; }
  .signbox { border: 1px solid #14201c; min-height: 122px; padding: 8px 10px; font-size: 12px; }
  .signbox .k { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; }
  .signbox .who { margin-top: 6px; font-size: 11px; }
  .signbox img { max-height: 62px; max-width: 100%; display: block; margin-top: 8px; }
  .signbox .obs { margin-top: 8px; white-space: pre-line; font-size: 11px; }
  .rates { display: flex; flex-wrap: wrap; gap: 18px; margin: 10px 0 14px; font-size: 12px; }
  .rates span { color: #4b5c56; }
  .rates strong { color: #14201c; }
  .cur-h { margin: 16px 0 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #1f6b3a; }
  .totline td { font-weight: 700; border-top: 1px solid #14201c; border-bottom: none; }
  @media print { .noprint { display: none !important; } body { background: #fff; } }
</style></head><body>
<div class="sheet">${body}</div>
</body></html>`;

  if (typeof window !== "undefined" && window.__azagroOpenDoc) {
    window.__azagroOpenDoc(title, html, send);
    return;
  }
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/\s+/g, "-")}.html`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadHtml(title: string, body: string) {
  const w = window.open("", "_blank");
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
  const blob = new Blob(
    [
      `<!doctype html><html lang="es"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>body{font-family:DM Sans,system-ui,sans-serif;padding:24px}</style></head><body>${body}</body></html>`,
    ],
    { type: "text/html;charset=utf-8" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/\s+/g, "-")}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
  void html;
  void w;
}

export function escapeHtml(s: string) {
  return Array.from(s)
    .map((ch) => {
      if (ch === "&") return "&#38;";
      if (ch === "<") return "&#60;";
      if (ch === ">") return "&#62;";
      if (ch === '"') return "&#34;";
      if (ch === "'") return "&#39;";
      return ch;
    })
    .join("");
}

export function letterhead(opts: {
  logoSrc: string;
  legalName: string;
  rfc?: string;
  phone?: string;
  title: string;
  number: string;
  partyLabel: string;
  party: string;
  meta: string[];
  headers?: string[];
  rows: Array<{ left?: string; mid?: string; qty?: string; unit?: string; amount?: string; cells?: string[] }>;
  total: string;
  totalLabel?: string;
  hideTotal?: boolean;
  compact?: boolean;
  notes?: string;
  sign?: string;
}) {
  const meta = opts.meta.filter(Boolean).map(escapeHtml).join(" · ");
  const headers = opts.headers ?? ["Descripción", "Cantidad", "P. unitario", "Importe"];
  const rows = opts.rows
    .map((r) => {
      const cells = r.cells ?? [r.left ?? "", r.qty ?? "", r.unit ?? "", r.amount ?? ""];
      return `<tr>${cells
        .map((c, i) => `<td class="${i === 0 ? "" : "r"}">${escapeHtml(String(c ?? ""))}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  const head = headers
    .map((h, i) => `<th class="${i === 0 ? "" : "r"}">${escapeHtml(h)}</th>`)
    .join("");
  const tot = opts.hideTotal
    ? ""
    : `<p class="tot">${escapeHtml(opts.totalLabel ?? "Total")} ${escapeHtml(opts.total)}</p>`;
  return `
    <div class="top">
      <img class="logo" src="${opts.logoSrc}" alt="Azagro"/>
      <div class="co">
        <strong>${escapeHtml(opts.legalName)}</strong>
        ${opts.rfc ? `RFC ${escapeHtml(opts.rfc)}<br/>` : ""}
        ${opts.phone ? escapeHtml(opts.phone) : ""}
      </div>
    </div>
    <h1>${escapeHtml(opts.title)} ${escapeHtml(opts.number)}</h1>
    <p class="meta">${escapeHtml(opts.partyLabel)}: <strong>${escapeHtml(opts.party)}</strong><br/>${meta}</p>
    <table class="${opts.compact ? "wide" : ""}">
      <thead><tr>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${tot}
    ${opts.notes ? `<p class="note">${escapeHtml(opts.notes)}</p>` : ""}
    ${opts.sign ? `<p class="sign">${escapeHtml(opts.sign)}</p>` : ""}
  `;
}

/** Guía de carga: mismo papel que usa el fletero (folio, línea, chofer, marca, placas). */
export function guiaSheet(opts: {
  logoSrc: string;
  legalName: string;
  folio: string;
  fecha: string;
  cliente: string;
  lineaFletera: string;
  chofer: string;
  marca: string;
  placas: string;
  origen: string;
  destino: string;
  expediente?: string;
  rows: Array<{ product: string; qty: string; uom: string }>;
  signature?: string;
  signedName?: string;
  observaciones?: string;
}) {
  const field = (k: string, v: string) =>
    `<div><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v || "—")}</div></div>`;
  const first = opts.rows[0];
  const producto = opts.rows.length <= 1
    ? (first?.product || "—")
    : opts.rows.map((r) => r.product).join(", ");
  const cantidad = opts.rows.length <= 1
    ? (first ? `${first.qty} ${first.uom}`.trim() : "—")
    : opts.rows.map((r) => `${r.qty} ${r.uom}`.trim()).join(" · ");
  const extraTable =
    opts.rows.length > 1
      ? `<table>
      <thead><tr><th>Producto</th><th class="r">Cantidad</th><th class="r">Unidad</th></tr></thead>
      <tbody>${opts.rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.product)}</td><td class="r">${escapeHtml(r.qty)}</td><td class="r">${escapeHtml(r.uom)}</td></tr>`,
        )
        .join("")}</tbody>
    </table>`
      : "";
  const signImg = opts.signature ? `<img src="${opts.signature}" alt="Firma"/>` : "";
  const who = opts.signedName ? `<div class="who">${escapeHtml(opts.signedName)}</div>` : "";
  const obs = opts.observaciones ? `<div class="obs">${escapeHtml(opts.observaciones)}</div>` : "";
  return `
    <div class="top">
      <img class="logo" src="${opts.logoSrc}" alt="Azagro"/>
      <div class="co">
        <strong>${escapeHtml(opts.legalName)}</strong>
      </div>
    </div>
    <div class="guia-banner">
      <h1>Guía de carga</h1>
      <div class="folio">
        <div class="k">Folio</div>
        <div class="n">${escapeHtml(opts.folio)}</div>
      </div>
    </div>
    <div class="grid2">
      ${field("Fecha", opts.fecha)}
      ${field("Línea fletera", opts.lineaFletera)}
      ${field("Cliente", opts.cliente)}
      ${field("Chofer", opts.chofer)}
      ${field("Origen", opts.origen)}
      ${field("Marca de carro", opts.marca)}
      ${field("Producto", producto)}
      ${field("Placas", opts.placas)}
      ${field("Cantidad", cantidad)}
      ${field("Destino", opts.destino)}
    </div>
    ${opts.expediente ? `<p class="meta">Expediente: <strong>${escapeHtml(opts.expediente)}</strong></p>` : ""}
    ${extraTable}
    <div class="signs4">
      <div class="signbox"><div class="k">Recibe</div>${who}${signImg}</div>
      <div class="signbox"><div class="k">Sello</div></div>
      <div class="signbox"><div class="k">Observaciones</div>${obs}</div>
      <div class="signbox"><div class="k">Firma</div></div>
    </div>
  `;
}

/** Estado de cuenta completo: Compaq + columnas del Excel de cartera. */
export function statementSheet(opts: {
  logoSrc: string;
  legalName: string;
  rfc?: string;
  party: string;
  partyCode?: string;
  asOf: string;
  periodFrom?: string;
  rates: { commission: string; annual: string; fega: string; total: string };
  sections: Array<{
    currency: string;
    headers: string[];
    rows: Array<string[]>;
    totals: string[];
  }>;
  notes?: string;
}) {
  const period = opts.periodFrom
    ? `Del ${escapeHtml(opts.periodFrom)} al ${escapeHtml(opts.asOf)}`
    : `Corte al ${escapeHtml(opts.asOf)}`;
  const sections = opts.sections
    .filter((s) => s.rows.length)
    .map((s) => {
      const head = s.headers
        .map((h, i) => `<th class="${i < 2 ? "" : "r"}">${escapeHtml(h)}</th>`)
        .join("");
      const body = s.rows
        .map(
          (cells) =>
            `<tr>${cells
              .map((c, i) => `<td class="${i < 2 ? "" : "r"}">${escapeHtml(c)}</td>`)
              .join("")}</tr>`,
        )
        .join("");
      const tot = `<tr class="totline">${s.totals
        .map((c, i) => `<td class="${i < 2 ? "" : "r"}">${escapeHtml(c)}</td>`)
        .join("")}</tr>`;
      return `<p class="cur-h">Moneda: ${escapeHtml(s.currency)}</p>
        <table class="wide"><thead><tr>${head}</tr></thead><tbody>${body}${tot}</tbody></table>`;
    })
    .join("");
  return `
    <div class="top">
      <img class="logo" src="${opts.logoSrc}" alt="Azagro"/>
      <div class="co">
        <strong>${escapeHtml(opts.legalName)}</strong>
        ${opts.rfc ? `RFC ${escapeHtml(opts.rfc)}<br/>` : ""}
        Saldo de documentos por cliente
      </div>
    </div>
    <h1>Estado de cuenta</h1>
    <p class="meta">Cliente: <strong>${escapeHtml(opts.party)}</strong>
      ${opts.partyCode ? ` · ${escapeHtml(opts.partyCode)}` : ""}<br/>${period}</p>
    <div class="rates">
      <div><span>Comisión</span> <strong>${escapeHtml(opts.rates.commission)}</strong></div>
      <div><span>Tasa anual</span> <strong>${escapeHtml(opts.rates.annual)}</strong></div>
      <div><span>FEGA</span> <strong>${escapeHtml(opts.rates.fega)}</strong></div>
      <div><span>Total</span> <strong>${escapeHtml(opts.rates.total)}</strong></div>
    </div>
    ${sections}
    ${opts.notes ? `<p class="note">${escapeHtml(opts.notes)}</p>` : ""}
  `;
}

export function logoSrc() {
  if (typeof window === "undefined") return "/brand/azagro-logo.png";
  return `${window.location.origin}/brand/azagro-logo.png`;
}

