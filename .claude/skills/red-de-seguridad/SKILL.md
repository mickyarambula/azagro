---
name: red-de-seguridad
description: Verificación obligatoria antes de dar por terminado cualquier cambio del ERP: pruebas en verde, typecheck limpio, ninguna prueba existente cambia de resultado, y motor congelado comparado al centavo cuando se toca dinero. Úsala antes de decir "listo", antes de commitear y antes de escribir la guía de prueba.
---

# Red de seguridad

`METODOLOGIA-TRABAJO.md` § 5. En Azagro los datos son de prueba, inventados: no hay anclas numéricas reales. La red es otra: **el comportamiento anterior no se mueve sin que alguien lo decida**.

## Siempre, antes de decir "listo"

1. `npm test` — todas en verde. Hoy son 676; el número solo puede subir.
2. `npx tsc --noEmit` — limpio.
3. **Ninguna prueba existente cambió de resultado.** Si para que pase hubo que editar una prueba vieja, esa es la señal de que el comportamiento anterior se movió: **ahí se para** y se le dice al dueño qué se movió y por qué, antes de seguir. No se "arregla" la prueba.
4. Si se tocó `CLAUDE.md`: `erp-permissions.test.mjs` vigila frases de la regla 10.
5. Si se agregó una tabla: `erp-tablas-clasificadas.test.mjs` exige que esté en SE BORRA o SE CONSERVA de `scripts/purge-plan.mjs`.
6. Si se tocó texto que sale de la empresa: `erp-documento-limpio.test.mjs`.
7. Ningún número de negocio en `src/`: `erp-sin-numeros.test.mjs`.

**Verificar, no afirmar:** se pega la salida real (`ℹ pass 676` / `ℹ fail 0`), no "las pruebas pasan".

## Cuando se toca dinero (precio, financiamiento, mora, cartera, P&L, kardex)

Además de lo anterior, **motor congelado**:

1. Antes de cambiar nada, se copia el motor de hoy (la función pura: `pricing.ts`, `credit.ts`, `ladder.ts`, `reports.ts`, lo que aplique) dentro de un archivo de prueba, congelado.
2. Después del cambio, esa prueba corre el motor viejo y el nuevo sobre cientos o miles de casos generados y compara **al centavo**.
3. Los casos que sí deben cambiar se listan explícitamente con su razón (la decisión que lo pide); todo lo demás tiene que ser idéntico.

Ejemplos en el repo, se copia ese patrón: `scripts/erp-circuito-lineal.test.mjs` (+2,000 casos del motor ASR, idéntico al centavo tras el paso 3), `scripts/erp-reportes-circuito.test.mjs` (+1,000 casos del P&L).

## Lo que se entrega al terminar

- **Archivos tocados y por qué**, uno por renglón.
- **La corrida de la red**: salida real de `npm test` y `tsc`; si hubo motor congelado, cuántos casos y cuántos idénticos.
- **Guía de prueba para el dueño** (skill `guia-de-prueba`).
- **Qué modelo conviene para lo que sigue**, según `METODOLOGIA-TRABAJO.md` § 8.

El commit va a `main` sin PR, un solo commit por pieza, y lo pide el dueño. Hasta que el deploy de Vercel termina, el código no está arriba.
