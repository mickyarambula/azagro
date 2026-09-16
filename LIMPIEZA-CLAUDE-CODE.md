# Limpieza de plugins y skills de Claude Code (15-sep-2026)

**Resultado:** Se liberaron **~64,800 tokens por sesión** (68,580 → 3,790 caracteres ≈ tokens). Esto explica por qué las sesiones se llenaban tan rápido con contexto innecesario.

Esto no es del ERP: es configuración **global** de la herramienta Claude Code en esta máquina (`~/.claude/`), no del repo. Se anota aquí, en el repo, solo para que no dependa de una conversación que se puede perder.

## Qué se encontró

- **1,389 skills sueltos** en `~/.claude/skills/` (66 MB), instalados en bloque el 14-abr-2026 por una herramienta externa llamada **Antigravity** (lo prueba `~/.claude/skills/.antigravity-install-manifest.json`, con `updatedAt: 2026-04-14T17:47:20Z`). Nada que ver con Azagro ni con ningún plugin de Claude Code — paquete comunitario genérico (advogado-criminal, activecampaign-automation, etc.). Claude Code lee **toda** subcarpeta de `~/.claude/skills/` en cada arranque de sesión, sin filtro posible por config.
- **19 plugins habilitados** en `~/.claude/settings.json` → `enabledPlugins`, de 5 marketplaces distintas. Dos de ellos eran el mismo software publicado dos veces: `vercel@claude-plugins-official` (v0.48.0, oficial) y `vercel-plugin@vercel` (v0.32.5, atrasado) — mismo repo (`github.com/vercel/vercel-plugin`), registraban el mismo `SessionStart` hook por duplicado.

## Qué se quitó

**11 plugins** (`/plugin uninstall <nombre>` en espíritu — se hizo a nivel de archivo: se sacaron de `enabledPlugins` en `settings.json`, de `installed_plugins.json`, y se borró su carpeta en `~/.claude/plugins/cache/`):

| Plugin | Motivo |
|---|---|
| `vercel-plugin@vercel` | Duplicado exacto de `vercel@claude-plugins-official`, versión vieja |
| `superpowers-chrome@superpowers-marketplace` | Automatización de Chrome redundante con `chrome-devtools-mcp` |
| `supabase@claude-plugins-official` | El proyecto usa Neon/PGLite, no Supabase |
| `atomic-agents@claude-plugins-official` | Framework de agentes genérico, sin relación con un ERP web |
| `code-modernization@claude-plugins-official` | Migración de legado COBOL/Java/.NET — Azagro es TanStack Start desde cero |
| `claude-api@anthropic-agent-skills` | Desarrollo con la API/SDK de Claude, no es lo que construye este repo |
| `example-skills@anthropic-agent-skills` | Skills de ejemplo del repo público de Anthropic, no para uso real |
| `document-skills@anthropic-agent-skills` | Generación de PDF/DOCX/PPTX, fuera del alcance de Azagro hoy |
| `superpowers-lab@superpowers-marketplace` | Add-ons experimentales sin uso comprobado |
| `superpowers-developing-for-claude-code@superpowers-marketplace` | Para construir plugins de Claude Code, no para desarrollar Azagro |
| `claude-code-setup@claude-plugins-official` | Ayudante de configuración inicial, ya cumplió su función |

**3 marketplaces** que quedaron sin ningún plugin instalado, removidas de `known_marketplaces.json` y de `extraKnownMarketplaces` en `settings.json` (y se borró su carpeta clonada en `~/.claude/plugins/marketplaces/`): `vercel`, `anthropic-agent-skills`, `superpowers-marketplace`.

**Los 1,389 skills sueltos**, movidos íntegros (no borrados) — ver "Respaldo y restauración" abajo.

**Limpieza de disco sin relación con contexto** (versiones de plugin ya reemplazadas, no referenciadas por ningún registro): `chrome-devtools-mcp/1.7.0` y `vercel/0.45.1` bajo `~/.claude/plugins/cache/claude-plugins-official/`.

## Qué se conservó (8 plugins, 2 marketplaces)

| Plugin | Por qué |
|---|---|
| `superpowers@claude-plugins-official` | Marco de trabajo que ya se sigue en cada sesión (brainstorming, systematic-debugging) |
| `vercel@claude-plugins-official` | Despliegue del proyecto; versión más nueva de los dos "vercel" |
| `claude-mem@thedotmack` | Motor detrás de la memoria automática de sesión (`MEMORY.md`) |
| `frontend-design@claude-plugins-official` | UI en React/Tailwind |
| `code-review@claude-plugins-official` | `/code-review ultra`, documentado en las instrucciones de sesión |
| `code-simplifier@claude-plugins-official` | Agente de limpieza de código |
| `chrome-devtools-mcp@claude-plugins-official` | Probar UI en navegador (CLAUDE.md lo pide) |
| `claude-md-management@claude-plugins-official` | El proyecto vive de CLAUDE.md/DECISIONES.md |

Marketplaces que quedan: `claude-plugins-official` (de donde vienen 7 de los 8) y `thedotmack` (de donde viene `claude-mem`).

## Respaldo y restauración de los skills sueltos

**No se borró nada — se movió.** El respaldo íntegro de los 1,389 skills queda en:

```
~/.claude/skills-backup-antigravity-todo
```

Es hermano de `~/.claude/skills` (que quedó vacío, `mkdir` limpio). No caduca ni se autolimpia; se queda ahí hasta que alguien lo borre a mano.

**Restaurar uno suelto** (aparece listado desde la siguiente sesión, sin reiniciar nada más):
```bash
cp -r ~/.claude/skills-backup-antigravity-todo/<nombre-del-skill> ~/.claude/skills/
```

**Deshacer todo el movimiento** (volver exactamente a como estaba):
```bash
rm -rf ~/.claude/skills && mv ~/.claude/skills-backup-antigravity-todo ~/.claude/skills
```

**Deshacer los plugins/marketplaces removidos:** hay una copia de los tres archivos de configuración tal como estaban antes, en:
```
~/.claude/backups/plugin-cleanup-20260915-192605/
  settings.json
  installed_plugins.json
  known_marketplaces.json
```
Para revertir, se reemplazan esos tres archivos por la copia y se vuelve a instalar cada plugin removido con `/plugin install <nombre>@<marketplace>` (las carpetas de caché sí se borraron, así que un `cp` simple de la config no basta para los plugins — sí basta para los skills sueltos, que nunca se borraron).

## Contexto liberado al arrancar sesión

Medido como el texto real que se inyecta en cada sesión (una línea `nombre: descripción` por skill — no el contenido completo de cada `SKILL.md`, que solo se carga si el skill se invoca):

| | Antes | Después |
|---|---|---|
| Skills sueltos (`~/.claude/skills`) | 1,389 skills — 229,686 caracteres | 0 |
| Skills de plugins habilitados | 154 skills (19 plugins) — 44,653 caracteres | 62 skills (8 plugins) — 15,154 caracteres |
| **Total** | **274,339 caracteres ≈ 68,580 tokens** | **15,154 caracteres ≈ 3,790 tokens** |

**Se liberaron aproximadamente 64,800 tokens por sesión** (≈94% de lo que este listado costaba) — el bulto de Antigravity era, por sí solo, 5 veces más caro que los 19 plugins juntos.

Esta cifra es solo el listado de nombre+descripción de skills; no incluye el listado de agentes ni las herramientas MCP de conectores de claude.ai (Gmail, Canva, ClickUp, etc.), que son un panel de configuración aparte y no se tocaron en esta limpieza.
