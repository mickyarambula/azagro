---
description: Retoma el trabajo en Azagro sin que el dueño tenga que re-explicar nada — últimos commits, si quedó algo sin subir, qué preguntas siguen abiertas y qué sigue en el producto.
---

Vas a orientarte antes de tocar nada. Reúne esto, en este orden, y repórtalo en español, corto, sin jerga — el que lo lee puede ser el dueño, no solo tú en una sesión nueva:

1. **`git log -8 --format='%ad %s' --date=short`** — los últimos 8 commits, para ver qué se construyó y cuándo.
2. **`git status --short`** — si hay algo sin commitear, dilo primero y con todas sus letras: "quedó trabajo sin guardar de la sesión pasada" no es un detalle menor.
3. **`git log origin/main..HEAD --oneline`** (si falla por no haber remoto configurado, dilo y sigue) — si hay commits locales que no llegaron a GitHub, o sea que Vercel no los tiene.
4. **`CLAUDE.md` § "Siguiente"** — qué es lo que sigue en el producto, según el propio repo.
5. **`ESTADO.md` § 0** (el índice) — cuántas preguntas ABIERTAS hay hoy en § 2 y cuántos puntos "sin contestar" en § 4. No las listes todas; nombra las 2 o 3 más relacionadas con lo que diga el punto 4 de este comando.
6. **Las últimas 3-5 filas de la tabla de `DECISIONES.md`** — qué decidió el dueño más recientemente, por si la sesión pasada se quedó esperando una respuesta.

Con eso, entrega un reporte de máximo ~200 palabras, en este orden:

- **Dónde quedamos:** una o dos frases, con la fecha del último commit.
- **Pendiente sin subir**, solo si lo hay.
- **Lo que sigue:** según § "Siguiente" de CLAUDE.md, con la pieza o el paso exacto (no "seguir trabajando").
- **Si hay una decisión del dueño pendiente** que bloquee ese siguiente paso, dilo y cita la pregunta por su clave (`ESTADO.md`).
- **Qué modelo usar** para ese siguiente paso, según `METODOLOGIA-TRABAJO.md` § 8.

No propongas código todavía. No hagas la pasada de investigación completa (eso es la skill `investigar-bloque`, o el sub-agente `investigador`, cuando el dueño diga "adelante" con el paso concreto) — este comando es solo para llegar orientado, no para empezar a construir.
