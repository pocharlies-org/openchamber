Rol: devops · Fecha: 2026-10-06 · Sesión: devops-dgx515-guarda · Estado: LISTO

# DGX-515 — entrega

PR: https://github.com/pocharlies-org/openchamber/pull/112 (rama `devops/DGX-513-guarda`, base `main` 529f2e3493 → head 26027317c4). CI en cola: run guarda 37512529061, duplicados 37512529703, PR review 37512529701.

## Qué se hizo

1. **README público**: banner AgentChamber al principio — fork oficial de la compañía de openchamber/openchamber (enlace), multi-agente OpenCode + Claude Code, MIT cubre código no marca, sin implicar respaldo de upstream. SECURITY.md: nota de fork con contacto security@e-dani.com.
2. **gitleaks**: rc=0 sobre árbol e historial (2495 commits) con `.gitleaks.toml`. Los 23 hallazgos son falsos positivos del historial de upstream (fixtures `0123456789abcdef` en tests de `spaces/` ya eliminados, un `x-api-key: space-window`, y el OAuth client id público de Linear) — comprobado valor a valor, sin `--redact`. **Ningún secreto real** ⇒ no hay `PARA SECURITY:` ni ticket de rotación. Rutas internas (`/home/dibanez`, `100.107.`, `.lan.e-dani.com`): 0.
3. **Guarda de workflows**: eliminados 9 heredados con secretos o `pull_request_target` — label-merge-conflict (único `pull_request_target` real), issue-intake, bot-help, bot-summarize, oc-integration, oc-review, opencode, opencode-smoke, stale. `pr-review.yml` y `duplicados.yml` NO se tocan: ya eran el reusable de la org tras #108 (sin secretos, `pull_request`). Jobs con secretos reales tras `environment: release` (release.yml ×3, mobile-release ×2, release-desktop-smoke, vscode-extension, build-macos-dmg) y `environment: website` (docs-source). mac/iOS/Windows ya llevaban comentario de motivo desde INFRA-548.
4. **Check automatizado**: `scripts/check-workflow-guard.mjs` (0 `pull_request_target`, 0 runner propio/hosted en `pull_request`, 0 secreto sin environment; parsea YAML con la librería `yaml` ya en el root) + `scripts/check-workflow-guard.test.mjs` con fixture malo (falla con las 3 violaciones) y bueno (pasa). Job `arc-k8s` en `.github/workflows/workflow-guard.yml` que además corre gitleaks con binario de checksum.

## Nota para el tech-lead

Decisión del architect (revisión PR #112): el job de guarda **se queda en
`workflow-guard.yml`** como workflow propio con check de nombre obligatorio; no
se mueve a `fork-pr-checks.yml`. Esta PR no toca ese fichero.

Ronda 1 del architect aplicada (head 26027317 → nuevo head): (1) el `if:` ya no
exime si está anclado a la propia PR; (2) el check de runners es **allowlist**
(en eventos de PR solo `arc-k8s` literal — caen `blacksmith-*`,
`${{ matrix.runner }}`, mapas y etiquetas futuras; los reusables solo de
`pocharlies-org/`), con cada forma de eludir añadida al fixture malo; (3)
`workflow-guard.yml` usa el composite `.github/actions/setup-node-bun` de la PR
#111 en vez de copiar los pasos de instalación.

**Pendiente de rebase sobre #111** (un solo rebase cuando se fusione, aviso del
tech-lead mediante): conflicto real en `.github/workflows` — borrar los 9
workflows que #111 ya elimina y re-aplicar los `environment:` sobre sus líneas.
Hasta ese rebase, el `- uses: ./.github/actions/setup-node-bun` de
`workflow-guard.yml` no existe en la rama y el CI de la rama fallará: esperado.
Los environments `release`/`website` con revisores los crea el CTO (ACCIÓN
pasada); sin ellos los jobs con secretos quedan en espera de aprobación.

## Checklist de criterios (00-spec.md)

- [x] Repo público y fork: `gh api repos/pocharlies-org/openchamber --jq '[.visibility,.fork,.parent.full_name]|@tsv'` → `public true openchamber/openchamber` (verificado 2026-10-06).
- [x] README: `AgentChamber` ×3, `fork de` ×2, `officially endorsed` ×0. **LICENSE = 2 en `main`**: la línea propia (stack) trae los otros 4 (`packages/sdk/LICENSE`, ghostty ×3) vía DGX-517; esta PR no elimina ninguno. El criterio de 6 se cumple sobre la línea fusionada.
- [x] Sin secretos ni rutas internas: gitleaks rc=0 (con allowlist documentada en `.gitleaks.toml`), `git grep` de rutas internas = 0. Sin secreto real en historial ⇒ sin rotación.
- [x] Guarda de workflows: 0 `pull_request_target` (las 3 menciones restantes son comentarios que dicen «NUNCA pull_request_target» en duplicados.yml/pr-review.yml), 0 runner propio/hosted en `pull_request`, secretos tras `environment`, CI Linux en `arc-k8s`.
- [ ] Config del repo: no la escribe esta cuenta — **ACCIÓN:** abajo.
- [x] Check automatizado con test de fixture, en job `arc-k8s` (hoy `workflow-guard.yml`; ver nota DGX-517).
- [x] Documentación: README y SECURITY.md actualizados (arriba).

## Verificación (para qa)

```
node scripts/check-workflow-guard.mjs            # OK sobre los 10 workflows
node --test scripts/check-workflow-guard.test.mjs # 4/4
gitleaks detect --source . --no-banner --redact   # rc=0
git grep -nE '/home/dibanez|100\.107\.|\.lan\.e-dani\.com' -- . ':!node_modules'  # vacío
grep -c AgentChamber README.md                    # 3
```

## Reutilizado

- Patrón de runner `arc-k8s` + instalación Node/Bun con checksum: copiado de `fork-pr-checks.yml` (rama `build/v2.0.1-metrics`) porque aún no está en `main`; al converger con DGX-517 extraer a composite action (anotado en el YAML).
- Patrón de check con test `scripts/*.test.mjs` (ej. `scripts/profile-browser-session-load.test.mjs`) y `node:test`; patrón de fixture inline como los tests del repo.
- Librería YAML: `yaml` ^2.8.1, ya dependencia raíz (`package.json:147`) — ninguna dependencia nueva.
- `pr-review.yml` / `duplicados.yml` (reusables de la org, #108) — reutilizados como puerta, no reescritos.
- Comentario «fuera de pool» de INFRA-548 en jobs hosted — conservado, no duplicado.

## ACCIÓN (config del repo — no la puede escribir esta cuenta)

1. `gh api -X PUT repos/pocharlies-org/openchamber/actions/permissions/workflows -f can_approve_pull_request_reviews=true` — hoy está en `false` (medido con `gh api repos/pocharlies-org/openchamber/actions/permissions/workflows`); activa la aprobación obligatoria de workflows de colaboradores externos.
2. Crear los environments que referencia la PR con aprobación manual y revisores (Dani + security):
   `gh api -X PUT repos/pocharlies-org/openchamber/environments/release` y `.../environments/website`, y en cada uno `gh api -X PUT repos/pocharlies-org/openchamber/environments/<nombre>/reviewers -f reviewers[][type]=User -f reviewers[][id]=<user-id>` (hoy `total_count: 0`).

### Rescate
Sesión CTO: la sesión despachante de DGX-513 (uuid no propagado al encargo)
Agente: devops (rama devops/DGX-513-guarda)
Reanudar la sesión: cd ~/compania/dev/DGX-513-devops
Continuar el subagente: desde la sesión del tech-lead, mensaje a devops DGX-515
Transcript: el .meta.json bajo subagents/ de esa sesión
