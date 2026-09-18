import type { Sql } from "@/lib/db";

/**
 * Los cuatro circuitos del catálogo (los mismos que sembró la migración 0024
 * para las empresas que ya existían). Una empresa creada DESPUÉS de esa
 * migración nacía sin catálogo y no podía cotizar ("no está en el catálogo").
 * Idempotente: nunca pisa lo capturado. La comisión de apertura nace SIN
 * capturar (null, nunca 0): desde la migración 0026 vive solo en el catálogo
 * (la columna de Ajustes que la tenía ya no existe) y se captura en Ajustes →
 * Circuitos de financiamiento; hasta entonces cotizar a crédito por ASR se
 * detiene con su aviso (regla 9). **El ASR nace SIN elegir** (`enabled =
 * false`): "Contado" no necesita nada capturado y sí nace elegible; el
 * crédito (ASR) lo activa `saveCircuitCommission` en cuanto alguien captura
 * su comisión — nadie hereda un circuito de crédito que nadie configuró.
 */
export async function seedCircuits(sql: Sql, companyId: number) {
  await sql`
    insert into credit_circuits (company_id, code, name, commission_rate, financing_base, invoices_client, finances, enabled, sort_order)
    select cs.company_id, 'CONTADO', 'Contado', null, null, 'azagro', null, true, 1
    from company_settings cs where cs.company_id = ${companyId}
    on conflict (company_id, code) do nothing
  `;
  await sql`
    insert into credit_circuits (company_id, code, name, commission_rate, financing_base, invoices_client, finances, enabled, sort_order)
    select cs.company_id, 'ASR', 'Circuito ASR', null, 'costo_comision', 'azagro', 'santa_rosa', false, 2
    from company_settings cs where cs.company_id = ${companyId}
    on conflict (company_id, code) do nothing
  `;
  await sql`
    insert into credit_circuits (company_id, code, name, commission_rate, financing_base, invoices_client, finances, enabled, sort_order)
    select cs.company_id, 'SANTA_ROSA', 'Línea Santa Rosa', null, 'costo_margen', 'santa_rosa', 'santa_rosa', false, 3
    from company_settings cs where cs.company_id = ${companyId}
    on conflict (company_id, code) do nothing
  `;
  await sql`
    insert into credit_circuits (company_id, code, name, commission_rate, financing_base, invoices_client, finances, enabled, sort_order)
    select cs.company_id, 'PROPIA', 'Línea propia', null, null, 'azagro', 'azagro', false, 4
    from company_settings cs where cs.company_id = ${companyId}
    on conflict (company_id, code) do nothing
  `;
}
