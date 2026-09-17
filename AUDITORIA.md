# Auditoría completa del ERP — 16-sep-2026

Documento vivo de la auditoría pedida por el dueño el 16-sep-2026: "operación
real y escenarios diferentes, con pruebas y todo — bugs, errores, lo que
falte, mejoras y nuevas implementaciones para hacer un sistema de primera".

Cómo se lee: § 1 es lo que ya se sabía antes de auditar. § 2 en adelante lo
llena la auditoría por fases. Cada hallazgo lleva archivo:línea, el escenario
real que lo dispara, y si toca decisión del dueño (entonces va a `ESTADO.md`
como pregunta, no se contesta en código — regla de `CLAUDE.md`).

Fases:

| Fase | Qué | Estado |
|---|---|---|
| 1 | Barrido en paralelo por 12 lentes + escenarios reales, verificación adversarial de cada hallazgo (3 jueces), síntesis y crítico de completitud | en curso |
| 2 | Pruebas que reproduzcan cada bug confirmado (PGlite donde se pueda), en rojo antes de tocar código | pendiente |
| 3 | Arreglos, en orden de riesgo de dinero, con red de seguridad y guía de prueba | pendiente |
| 4 | Mejoras e implementaciones nuevas: propuesta al dueño, decisiones a `DECISIONES.md`, construcción por bloques | pendiente |

---

## 1. Anotado antes de la auditoría (16-sep-2026)

### 1.1 Defecto conocido, sin corregir: `useAccess()` fuera del `AppShell` en cuatro pantallas

Al reconstruir el inicio se encontró y corrigió este defecto en `index.tsx`:
un componente de ruta que renderiza `<AppShell>` y llama `useAccess()` en el
MISMO componente nunca recibe el contexto de permisos — `AccessProvider` vive
dentro de `AppShell` y solo alcanza a sus hijos. Resultado: rol vacío, ningún
permiso, y lo que dependa de `access.can()` / `access.role` se esconde o se
comporta como "sin permiso". El patrón correcto ya existía documentado en
`purchases.tsx` (`CloseShortPurchaseButton`) y ahora también en `index.tsx`
(`InicioBody`).

El mismo patrón (AppShell=1, Outlet=0, `useAccess()` en el componente de la
ruta) aparece en:

| Archivo | Dónde llama `useAccess()` | Verificado en navegador |
|---|---|---|
| `src/routes/settings.tsx` | `Page`, línea ~25 (`can`, `role`) | No |
| `src/routes/users.tsx` | `Page`, línea ~39 (`can`) | No |
| `src/routes/importar.tsx` | línea ~381 (`role`) — la sección "Datos de prueba" | No |
| `src/routes/quotes.tsx` | `Page`, línea ~129 (`isAdmin`) | No |

Se detectó por estructura de código; falta comprobar en cada una si el efecto
es cosmético o bloquea algo real. Entra a la fase 1 como hallazgo a verificar
y a la fase 3 como arreglo (el mismo que ya se hizo dos veces).

### 1.2 Estado operativo al 16-sep-2026 (resumen para el dueño)

Para seguir operando en **doble facturación (ASR)** — el circuito con el que
se ha operado todo hasta hoy — el sistema cubre el día a día: pedidos,
entregas y recepciones parciales, facturación por entrega, cobranza, mora,
pronto pago, cancelaciones y las cuatro reversas, corte inicial (saldos,
existencias, bancos), borrado de datos de prueba, bitácora.

Lo que falta y sí es operativo (de `ESTADO.md` § 2, ABIERTAS):

- **H6 — Unidades de medida.** Una sola unidad por producto; comprar en una
  y vender en otra no se puede.
- **H4c — Devolución a proveedor.** No existe; la FP se queda viva.
- **L8a — Costo en ajuste de inventario.** Entra al promedio sin preguntar.
- **H3 — "Sesión D".** Barrido de uso real, sin fecha.
- **H5 — Lotes y caducidad.** Diferido a propósito.

Lo que solo importa al activar el circuito **lineal** (Santa Rosa factura al
cliente) y hoy no bloquea: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.8, 4.10, D-B, D-C.

Menores: 4.13 (Reportes sin módulo de permiso propio), H4f (candado sin salida
en un caso raro de reversa de devolución vieja).

Falta también el **archivo real del export de Compaq** (H8a) para cotejar el
formato del corte.

---

## 2. Hallazgos de la fase 1

_(la llena la auditoría)_
