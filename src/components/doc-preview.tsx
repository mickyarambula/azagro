import { useEffect, useMemo, useRef, useState } from "react";
import { SendButton } from "@/components/send-doc";
import type { DocSend } from "@/lib/print-doc";

type Doc = { title: string; html: string; send?: DocSend };

function fileName(title: string) {
  return `${title.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-")}.html`;
}

export function DocPreviewHost() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  const blobUrl = useMemo(() => {
    if (!doc) return "";
    return URL.createObjectURL(new Blob([doc.html], { type: "text/html;charset=utf-8" }));
  }, [doc]);

  useEffect(() => {
    window.__azagroOpenDoc = (title, html, send) => {
      setHint(null);
      setDoc({ title, html, send });
    };
    return () => {
      delete window.__azagroOpenDoc;
    };
  }, []);

  useEffect(() => {
    if (!blobUrl) return;
    return () => URL.revokeObjectURL(blobUrl);
  }, [blobUrl]);

  if (!doc) return null;

  function download() {
    const a = link.current;
    if (a) {
      a.click();
      setHint("Si no bajó, usa «Abrir archivo» y en el navegador: Archivo → Guardar.");
      return;
    }
    const blob = new Blob([doc!.html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = fileName(doc!.title);
    el.rel = "noopener";
    el.target = "_blank";
    document.body.appendChild(el);
    el.click();
    el.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 20_000);
    setHint("Si no bajó, usa «Abrir archivo» y en el navegador: Archivo → Guardar.");
  }

  function print() {
    const html = doc!.html;
    const style = html.match(/<style>([\s\S]*?)<\/style>/i)?.[1] ?? "";
    const sheet = html.match(/<div class="sheet">([\s\S]*?)<\/div>\s*<\/body>/i)?.[1] ?? html;
    document.getElementById("azagro-print-root")?.remove();
    const wrap = document.createElement("div");
    wrap.id = "azagro-print-root";
    wrap.innerHTML = `<style>${style}</style><div class="sheet">${sheet}</div>`;
    document.body.appendChild(wrap);
    document.documentElement.classList.add("azagro-printing");
    const cleanup = () => {
      document.documentElement.classList.remove("azagro-printing");
      wrap.remove();
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.setTimeout(cleanup, 4000);
    try {
      window.print();
    } catch {
      setHint("Este visor bloquea imprimir. Abre el archivo y usa Imprimir → Guardar como PDF.");
      cleanup();
    }
  }

  const send = doc.send;

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-ink/50 p-3 noprint">
      <div className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-cream shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <p className="truncate text-sm font-semibold">{doc.title}</p>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <button type="button" className="erp-btn h-8 text-[12px]" onClick={() => setDoc(null)}>
              Cerrar
            </button>
            <a ref={link} className="erp-btn h-8 text-[12px] leading-8" href={blobUrl} download={fileName(doc.title)} target="_blank" rel="noreferrer">
              Abrir archivo
            </a>
            <button type="button" className="erp-btn h-8 text-[12px]" onClick={download}>
              Descargar
            </button>
            {send ? (
              <SendButton
                title={send.title || "Documento"}
                number={send.number || doc.title}
                party={send.party || ""}
                partnerId={send.partnerId}
                email={send.email}
                phone={send.phone}
                extra={send.extra}
                label="Enviar"
              />
            ) : null}
            <button type="button" className="erp-btn-primary h-8 text-[12px]" onClick={print}>
              Imprimir / PDF
            </button>
          </div>
        </div>
        {hint ? <p className="border-b border-line px-4 py-2 text-[12px] text-muted">{hint}</p> : null}
        <iframe ref={frame} title={doc.title} className="h-[72vh] w-full bg-white" srcDoc={doc.html} />
      </div>
    </div>
  );
}
