---
name: investigar-bloque
description: Pasada de solo lectura antes de construir cualquier bloque nuevo del ERP, y el punto de paro obligatorio antes de aplicar una migración. Úsala cuando pidan un bloque, una funcionalidad nueva o un cambio que toque dinero, kardex, cartera o esquema.
---

# Investigar un bloque antes de construirlo

Método de `METODOLOGIA-TRABAJO.md` § 3. Se saltó una vez en Cosecha y costó rehacer trabajo; en dos de cuatro veces la investigación encontró bugs más graves que el problema original.

## Paso 1 — Solo lectura

No escribes archivos, no corres migraciones, no propones código. Lees según la tabla "Qué leer antes de tocar código" de `CLAUDE.md`, y `MAPA.md` para ubicar funciones. Reportas tres cosas, en este orden:

1. **Lo que existe hoy.** Archivos y funciones citadas por nombre y línea (`src/lib/azagro.ts:1269`). Qué escribe cada camino, qué tabla toca, qué prueba lo vigila.
2. **Las decisiones que faltan.** Cada una como pregunta cerrada para el dueño, con las opciones reales y la consecuencia de cada una. Las de negocio son del dueño; las técnicas se deciden con el criterio de lo que debe ser, no de lo que es más fácil.
3. **Lo que no se pudo determinar leyendo.** Dicho explícitamente. Sin inventar.

Antes de reportar, revisa `ESTADO.md` § 2 y § 4: si la pregunta ya está ahí como ABIERTA, no se contesta en código. Si el dueño ya la cerró, está en `DECISIONES.md` — no la reabras.

Termina el reporte y **detente**. Un paso a la vez.

## Paso 3 — Punto de paro obligatorio (antes de cualquier migración o cambio de esquema)

Se muestra y se espera el OK. Nunca antes:

- **El SQL completo**, tal cual se va a aplicar. Solo aditivo: tablas nuevas y columnas nullable. Cero drops, renames o cambios de tipo — si hace falta una excepción, se pide con argumento y se demuestra que no rompe nada.
- Las opciones abiertas con su recomendación.
- **Qué cambia en el borrado de datos de prueba**: toda tabla nueva va en SE BORRA o SE CONSERVA de `scripts/purge-plan.mjs` (`scripts/erp-tablas-clasificadas.test.mjs` lo vigila).
- Cualquier cosa descubierta que no estaba en el prompt.

Recuerda cómo llega a producción: `npm run build` termina con `npm run db:migrate`, cada migración en su propia transacción. Si una falla a la mitad, las anteriores ya quedaron aplicadas y el código viejo sigue vivo.

## Principios que aplican mientras investigas

- **Un candado sin salida es peor que el bug que tapa.** Si algo hay que bloquear y no tiene camino legítimo alternativo, no se bloquea: se reporta y se resuelve primero. El orden importa: la salida se construye antes que el candado.
- **No inventar causas.** Cuando algo falla, ir al log real o a la base, no suponer.
- **Nada fuera de lo pedido sin preguntar**, aunque parezca obvio o sea una mejora clara.
- **Partir los bloques grandes.** Si crece, se corta, y se dice explícitamente qué NO va en este bloque.
