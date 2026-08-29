import { useEffect, useState } from "react";
import { getDocFile, listDocFiles, uploadDocFile } from "@/lib/erp/files";
import { humanError } from "@/lib/utils";

type Kind = "sale" | "purchase" | "invoice" | "request" | "rfq" | "cutover";

export function DocFiles({ kind, entityId }: { kind: Kind; entityId: number }) {
  const [rows, setRows] = useState<Array<{ id: number; filename: string; mime: string; created_at: string; bytes: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const d = await listDocFiles({ data: { kind, entityId } });
    setRows(d.rows);
  }
  useEffect(() => {
    void load().catch((e) => setError(humanError(e)));
  }, [kind, entityId]);

  return (
    <div className="mt-4 erp-card p-4">
      <h2 className="text-sm font-semibold">Archivos del folio</h2>
      <p className="mt-0.5 text-[12px] text-muted">CFDI, guía firmada, Excel de corte. Máximo ~4 MB.</p>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <ul className="mt-2 text-sm">
        {rows.map((f) => (
          <li key={f.id} className="flex items-center justify-between border-t border-line py-1.5 first:border-0">
            <span>{f.filename}</span>
            <button
              type="button"
              className="text-[12px] font-semibold text-accent"
              onClick={async () => {
                const d = await getDocFile({ data: { id: f.id } });
                const a = document.createElement("a");
                a.href = d.content.startsWith("data:") ? d.content : `data:${d.mime};base64,${d.content}`;
                a.download = d.filename;
                a.click();
              }}
            >
              Bajar
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="text-muted">Nada pegado todavía.</li>}
      </ul>
      <label className="erp-btn mt-3 inline-flex cursor-pointer">
        {busy ? "Subiendo…" : "Pegar archivo"}
        <input
          type="file"
          className="hidden"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setBusy(true);
            setError(null);
            try {
              const content = await new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result || ""));
                r.onerror = () => reject(new Error("No se pudo leer"));
                r.readAsDataURL(file);
              });
              await uploadDocFile({
                data: { kind, entityId, filename: file.name, mime: file.type || "application/octet-stream", content },
              });
              await load();
            } catch (err) {
              setError(humanError(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
    </div>
  );
}
