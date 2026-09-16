# Setup profesional de Claude Code para Azagro ERP

**Escrito:** 16-sep-2026 · **Piezas:** 1-6 (candado + red + agentes + índices + comando)

---

## Qué se construyó

Un entorno de desarrollo seguro y verificado para el ERP de Azagro, donde Claude ayuda a construir el sistema sin sorpresas. Cinco capas:

### 1. **Documentación adelgazada** (Pieza 1)
- `CLAUDE.md`: tabla "Qué leer antes de tocar código" en lugar de "lee todo". Cada tarea lee solo lo que necesita.
- `MAPA.md`: tabla de 12 líneas (Qué → Dónde). Full version cuando la usas.
- `migrations/README.md`: historial de cada migración (qué agregó, línea por línea).
- 4 skills nuevas: investigar-bloque, guia-de-prueba, cerrar-decision, red-de-seguridad.

**Por qué:** las primeras sesiones se atascaban leyendo documentos enteros. Ahora cada tarea llega al archivo que toca, sin ruido.

### 2. **Candado de producción** (Pieza 2)
Hooks de Bash (`candado-produccion.sh` + `red-de-seguridad.sh`) que bloquean cinco acciones peligrosas ANTES de que sucedan:
- `vercel env pull` — no bajar credenciales de Neon a mano
- `vercel link` — no ligar el proyecto real localmente
- `vercel --prod` o `vercel deploy --prod` — no desplegar sin PR review
- `npm run db:migrate -- --prod` — no forzar migraciones
- SQL directo (`psql ... UPDATE/INSERT/DELETE`) — no writes fuera del flujo de migraciones

Cada bloqueo ofrece salida legítima (ej: "si necesitas datos de prod, usa /importar").

**Por qué:** una línea equivocada borra años de cartera. Esto pasa silenciosamente en producción. El candado lo ve antes que Claude.

### 3. **Pruebas automáticas antes de commit** (Pieza 2)
`red-de-seguridad.sh` corre `npm test` + `npx tsc --noEmit` de verdad antes de cada commit. Si algo falla, bloquea y muestra la salida.

**Por qué:** 676 pruebas vigilan las reglas de "No romper" (dinero, kardex, reversas). Si una se rompe, el dueño lo sabe en 14 segundos, no una semana después en producción.

### 4. **Auditores especializados** (Pieza 4)
Dos sub-agentes sin llenar la sesión principal:

- **`investigador`** — pasada de solo lectura (paso 1) antes de construir. Reporta qué existe, qué decisiones faltan, qué no pudo determinar. No toca código.
- **`revisor-de-dinero`** — audita cambios que tocan dinero contra las 10 reglas de "No romper". PASA / PASA CON AVISOS / NO PASA.

**Por qué:** en Cosecha, la falta de investigación costó rehacer trabajo tres de cuatro veces. Investigar ANTES es barato; arreglarlo DESPUÉS es caro.

### 5. **Índices que se vigilan solos** (Pieza 6)
`ESTADO.md` § 0 e `DECISIONES.md` "Índice por tema" + prueba `erp-indice-docs.test.mjs` que falla si:
- Una pregunta abierta se cierra pero el índice no se actualiza
- Una decisión se agrega pero no sale en el índice
- El conteo de ABIERTAS ya no cuadra con el cuerpo

**Por qué:** un índice viejo es peor que ninguno. Manda a leer lo que no toca, o esconde una pregunta abierta. Esto lo evita npm test.

### 6. **Comando /retomar** (Pieza 5)
Escribe `/retomar` al arrancar una sesión. Lee últimos commits, si quedó algo sin subir, qué preguntas siguen abiertas, qué sigue en el producto. Genera reporte de ~200 palabras sin investigar.

**Por qué:** el dueño no tiene que re-explicar nada. Cada sesión nueva sabe dónde quedó.

---

## Cómo usarlo día a día

### Tarea nueva
1. **`/retomar`** — entiende dónde está el proyecto.
2. **Describe la tarea en español** — "agregar X", "arreglá Z", etc. Sin tecnicismos.
3. **Si hay decisión de negocio abierta** → skill `cerrar-decision` primero.
4. **Si es un bloque nuevo** → `/investigador investiga [bloque]` (pasada de lectura).
5. **Construye.**
6. **`npm test` pasa** → el candado ya lo verificó antes de commit.
7. **Si el output se ve** → skill `guia-de-prueba` (pasos numerados para que el dueño lo pruebe).
8. **skill `red-de-seguridad`** antes de decir "listo" (últimas verificaciones).

### Cambios que tocan dinero
Antes de commitear:
```
/revisor-de-dinero revisa <commit>
```
Sale: PASA / PASA CON AVISOS / NO PASA, con números.

### Decisión del dueño
En cuanto decide (una pregunta de `ESTADO.md`):
```
/cerrar-decision — DECISIÓN N, describe la decisión
```
Actualiza DECISIONES.md, mueve la pregunta en ESTADO.md, advierte si toca "No romper".

---

## Cómo deshacer cada pieza

Si algo no funciona, reverting es una línea:

| Pieza | Para deshacer |
|-------|---|
| 1. Documentación | `git revert 80dc596` — vuuelve CLAUDE.md al viejo tamaño, borra MAPA.md, skills. |
| 2. Candado + red | `git revert 775e21d` — quita hooks, `candado-produccion.sh`, `red-de-seguridad.sh`. Commit vuelve al honor system. |
| 4. Agentes | `git revert 0d003c6` — borra `.claude/agents/`, `/investigador` y `/revisor-de-dinero` ya no existen. |
| 6. Índices | `git revert e8301bf` — quita § 0 de ESTADO.md, "Índice por tema" de DECISIONES.md, la prueba `erp-indice-docs.test.mjs`. |
| 5. /retomar | `git revert 60411c8` — quita `.claude/commands/retomar.md`. |

Cada revert es independiente; no quiebra el resto. El único que toca infraestructura compartida es el candado (si lo quitas, vuelves al honor system de pruebas).

---

## Cómo replicarlo en AgroCiclo / Cosecha

Estos proyectos pueden copiar piezas:

### Mínimo (lo que aconsejo)
- Pieza 2 (candado de producción): bloquea errores humanos.
- Pieza 6 (índices con vigilancia): impide documentación vieja.
- Pieza 5 (comando /retomar): retoma sin re-explicar.

Eso es `~50 líneas de JSON + 200 líneas de scripts`.

### Completo
- Las piezas 1-6, tal cual.
- Adaptar `MAPA.md` a la arquitectura de cada proyecto.
- Crear skills propias si el negocio lo pide (ej: "cerrar-riesgo" para finanzas).

### Qué NO copiar
- Los sub-agentes `investigador` y `revisor-de-dinero` son específicos de Azagro (tienen CLAUDE.md hardcoded, reglas de "No romper"). Para otro proyecto, escribir sus propios agentes.

---

## Lo que protege este setup

Cuatro cosas que pueden salir mal en un ERP, ahora con barrera:

| Riesgo | Lo que falla sin setup | Lo que pasa ahora |
|--------|---|---|
| **Credenciales a mano** | Dev descarga Neon a desarrollo local, las deja ahí, se suben a GitHub sin querer. | Candado bloquea `vercel env pull` con mensaje "usa /importar en lugar". |
| **Datos de prueba en prod** | Un commit prueba que pasó localmente pero en prod rompe un número de negocio. | 676 pruebas + revisor-de-dinero lo ven antes de commitear. |
| **Documentación vieja** | Una pregunta se cierra en el código pero ESTADO.md sigue diciendo "abierta". Sesión nueva lee lo viejo. | `npm test` falla si el índice no cuadra. |
| **Sorpresas de dinero** | Una tasa, un margen, un plazo, aparece como número en el código (regla 9 violada) y el revisor de dinero automático no lo ve. | `revisor-de-dinero` audita contra reglas de "No romper" + motores congelados al centavo. |

---

## Modelos que se usan aquí

| Modelo | Cuándo | Por qué |
|--------|--------|---------|
| **Sonnet** (sesión principal) | Construcción, decisiones | Razona bien bajo restricción. |
| **Haiku** | Redacción pura (SETUP.md, guías), configuración | Rápido, suficiente para texto. |
| **Fable** | `revisor-de-dinero` (auditoría) | Tool use fácil, veredictos seguros. |
| **Opus** (no en use ahora) | Si la tarea es "entiende el ERP completo" | Caro si no lo necesitas; sesión principal con Sonnet es suficiente. |

---

## Siguientes pasos (producto, no infraestructura)

Esto es del CLAUDE.md § "Siguiente":

1. **Paso 4 de PARCIALES** — reversa por entrega (`chainForDelivery` hoy bloquea por estado, va a bloquearse por evento).
2. **Paso 5 de PARCIALES** — devolución y P&L con varias facturas.
3. **Pasos 6 y 7** — reversas de recepción y FV.
4. Después: **CSV de Compaq** — saldos + existencias + bancos.
5. **Operación en paralelo** — pruebas reales aquí mientras Compaq sigue timbrando.

---

## Contacto

Si algo del setup no funciona:
- Hooks falla → `/hooks` abre la UI de hooks, edita o deshabilita.
- Sub-agente no existe → restart la sesión (pone en cache config nuevos).
- Una prueba cambió de resultado → `npm test` muestra qué; skill `red-de-seguridad` lo cuenta.
- Índice desfasado → `npm test` falla con mensaje exacto de qué no cuadra.

**No es un bug del setup; es una característica.** Fallamos temprano, con mensajes claros.
