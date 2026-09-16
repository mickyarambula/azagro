#!/usr/bin/env bash
# Candado de producción — hook PreToolUse sobre Bash.
#
# Lee el comando que Claude Code está a punto de ejecutar (llega por stdin,
# en JSON) y lo bloquea si toca producción de verdad: bajar credenciales de
# Neon, ligar el proyecto de Vercel, o desplegar/migrar directo contra
# producción por Terminal. Si el comando es inofensivo, no hace nada y lo
# deja pasar (silencioso, para no estorbar el trabajo normal).
#
# Cada bloqueo nombra la salida legítima, como pide METODOLOGIA-TRABAJO.md:
# "un candado sin salida es peor que el bug que tapa".
set -uo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

# Un comando real empieza al inicio de una línea, o después de && ; | — nunca
# en medio de una frase. Esto evita falsos positivos cuando el texto
# "vercel env pull" aparece dentro de un mensaje de commit o un comentario,
# en vez de ser un comando de verdad. (Se encontró este caso en la práctica
# el 16-sep-2026, verificando este mismo hook: el mensaje de commit que
# describía el candado disparó el candado.)
ANCHOR='(^|&&|;|\|)[[:space:]]*'

block() {
  local razon="$1"
  jq -n --arg reason "$razon" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# 1. Bajar credenciales reales de producción a este equipo
if printf '%s' "$cmd" | grep -qE "${ANCHOR}vercel[[:space:]]+env[[:space:]]+pull"; then
  block "Candado de producción: 'vercel env pull' baja credenciales reales (DATABASE_URL de Neon) a este equipo. Salida legítima: para consultar producción, usa un script de solo lectura como scripts/erp-fp-sin-recibir.mjs o scripts/erp-facturas-repetidas.mjs, corrido por el dueño con su propio DATABASE_URL — nunca bajado aquí."
fi

# 2. Ligar esta copia local al proyecto real de Vercel
if printf '%s' "$cmd" | grep -qE "${ANCHOR}vercel[[:space:]]+link\\b"; then
  block "Candado de producción: 'vercel link' liga esta copia local al proyecto real de Vercel. Salida legítima: los deploys ya están conectados por GitHub (push a main); no hace falta ligar nada a mano."
fi

# 3. Deploy directo a producción por Terminal
if printf '%s' "$cmd" | grep -qE "${ANCHOR}vercel([[:space:]]+deploy)?[[:space:]]+.*--prod\\b"; then
  block "Candado de producción: un deploy a producción por Terminal se salta la revisión de Miguel. Salida legítima: el commit va a 'main' (git push) y Vercel despliega solo; 'npm run build' ya termina corriendo las migraciones."
fi

# 4. Migración forzada contra producción
if printf '%s' "$cmd" | grep -qE "${ANCHOR}npm[[:space:]]+run[[:space:]]+db:migrate.*--prod"; then
  block "Candado de producción: las migraciones se aplican solas en cada deploy de Vercel (npm run build → npm run db:migrate), nunca a mano contra producción. Salida legítima: sube el commit a main y deja que el deploy las aplique."
fi

# 5. SQL de escritura directo contra Neon con psql, fuera del flujo de migraciones.
# Se ancla a un comando psql real (no basta con que "DATABASE_URL" aparezca
# en el texto) y exige un verbo de escritura en la misma línea.
if printf '%s' "$cmd" | grep -qE "${ANCHOR}psql\\b" \
   && printf '%s' "$cmd" | grep -qiE '\b(update|delete|insert|drop|truncate|alter)\b'; then
  block "Candado de producción: esto parece SQL de escritura directo contra la base real con psql. Salida legítima: los cambios de esquema van en migrations/*.sql (solo aditivas) y se aplican con el deploy; para escribir datos se usa una pantalla de la app. Para consultar (solo lectura), un script como scripts/erp-fp-sin-recibir.mjs."
fi

exit 0
