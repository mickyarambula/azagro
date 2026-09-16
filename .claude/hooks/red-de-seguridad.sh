#!/usr/bin/env bash
# Red de seguridad — hook PreToolUse sobre Bash.
#
# Se activa solo cuando el comando incluye un "git commit". Corre npm test y
# npx tsc --noEmit de verdad, y si algo falla bloquea el commit mostrando la
# salida real — la regla de METODOLOGIA-TRABAJO.md § 5: "ninguna prueba
# existente puede cambiar de resultado". Si todo pasa, no dice nada y deja
# que el commit siga su curso normal.
set -uo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

# Solo actúa si el comando trae un "git commit" real, aunque venga encadenado
# con && / ; / | (p. ej. "cd algo && git commit ...").
if ! printf '%s' "$cmd" | grep -qE '(^|&&|;|\|)[[:space:]]*git[[:space:]]+commit\b'; then
  exit 0
fi

if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  cd "$CLAUDE_PROJECT_DIR" || exit 0
fi

test_log="$(mktemp)"
tsc_log="$(mktemp)"
trap 'rm -f "$test_log" "$tsc_log"' EXIT

npm test > "$test_log" 2>&1
test_status=$?

npx tsc --noEmit > "$tsc_log" 2>&1
tsc_status=$?

if [ "$test_status" -ne 0 ] || [ "$tsc_status" -ne 0 ]; then
  test_tail="$(tail -n 150 "$test_log")"
  tsc_tail="$(tail -n 150 "$tsc_log")"
  reason="No se puede hacer commit: la red de seguridad encontró un problema.

--- npm test (código de salida $test_status) ---
$test_tail

--- npx tsc --noEmit (código de salida $tsc_status) ---
$tsc_tail

Corrige lo que falló y vuelve a intentar el commit. Si una prueba VIEJA cambió de resultado (no una nueva que agregaste), no se arregla la prueba: se para y se avisa qué se movió, antes de seguir (skill red-de-seguridad)."
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
fi

exit 0
