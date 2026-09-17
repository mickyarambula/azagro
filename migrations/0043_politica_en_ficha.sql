-- 0043: la política de cobro vive en la ficha del cliente (Decisión 73,
-- hallazgo #21 de la auditoría, 17-sep-2026). Antes la decidía el código por
-- el nombre del grupo (group_name = 'Grupo SL' → GRUPO_SL, lo demás →
-- ESTANDAR). Aditiva: una columna nullable. Vacío = sin política en la ficha;
-- un pedido a crédito de ese cliente pide elegirla (Decisiones 68-69), nunca
-- la supone.
alter table partners add column if not exists policy_code text;

-- Siembra ÚNICA, como el catálogo siembra límite y plazo (solo al crear, regla
-- 9): los socios que hoy son «Grupo SL» arrancan con GRUPO_SL — lo que el
-- código venía aplicándoles — si esa política existe en su empresa. Nadie más
-- recibe política: ESTANDAR era la omisión del código, no un pacto con el
-- cliente, y ahora se captura en la ficha. Idempotente (solo donde es null).
update partners p
   set policy_code = 'GRUPO_SL'
 where p.policy_code is null
   and p.group_name = 'Grupo SL'
   and exists (select 1 from credit_policies cp where cp.company_id = p.company_id and cp.code = 'GRUPO_SL');
