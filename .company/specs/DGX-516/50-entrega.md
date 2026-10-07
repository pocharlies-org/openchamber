Rol: devops · Fecha: 2026-10-07 · Sesión: devops-dgx516-h3 · Estado: LISTO

# DGX-516 (H3) — entrega

## Qué se ha hecho
Dos PRs desde la rama `devops/DGX-516-plataformas` (worktree `~/compania/dev/DGX-516-devops`):

- **#122** (c91ba4d9d7): plataformas. Jobs Linux de `release.yml`, `mobile-release.yml`, `mobile-ci.yml`, `sdk-preview.yml`, `vscode-extension.yml` y `release-desktop-smoke.yml` migrados de las etiquetas `blacksmith-*` (herencia de INFRA-548) a `arc-k8s` con el composite `setup-node-bun` (ampliado a x64/arm64 con checksums verificados). mac/iOS/Windows quedan hosted con el motivo escrito en el job. Título de release e inventario de assets derivados de `build.productName` (AgentChamber tras #119); AppImages localizados por patrón; `verify-linux-appimage.mjs` acepta el productName real. `publish-npm` se salta con aviso sin token (pendiente de decisión, abajo).
- **#123** (aab49546a4, apilada sobre #122): retirada. `server/lib/fork-update` dispara `release.yml` del fork (0 referencias vivas a `openchamber-build-pocharlies` en el repo); `docs/release-promotion.md` con el paso explícito de `~/.local/openchamber` (beta→current, `.anterior`/`backups` conservados, rollback) y los comandos de retirada; `version` opcional en `workflow_dispatch`; tarballs sdk+web como assets del release; ARCHITECTURE.md §8 actualizado.

## Ronda 2 — correcciones al rechazo del architect (59bd837cc, push normal sin force)
- Hallazgo 1: `publish-npm` → `ubuntu-24.04` + `environment: release` (línea idéntica a #112).
- Hallazgo 2: `android-release` → `ubuntu-24.04` + `environment: release`.
- Hallazgo 3: `environment: release` declarado (no solo comentado) en macos build, `finalize-release`, `sdk-preview`, `vscode-extension`, `docs-source` (además fuera de arc-k8s), `build-macos-arm64-dmg` y el job macOS de `release-desktop-smoke`. `ios-testflight` declara `environment: testflight` — medido con `gh secret list --env`: ahí viven los secretos Apple/ASC.
- Hallazgo 4 (clase): barrido de los 90 workflows — ningún job propio usa secretos sin environment; quedan solo los bots de upstream (`OC_REVIEW_APP_*`/`OPENCODE_API_KEY`), que §8 dice eliminar con la pila.
- Decisión npm (nota-architect-npm-update-check, opción b) implementada: fuente `GET /repos/pocharlies-org/openchamber/releases/latest`; fuera el POST a `api.openchamber.dev` con install-id y la consulta al registro npm; `getUpdateCommand` lanza en la única costura (CLI y ruta `update-install` → 400 con puntero a `docs/release-promotion.md`, que llega con #123).
- #123 sin tocar (contiene el diff de #122): se rebasa sobre main cuando #122 se fusione — `git rebase origin/main devops/DGX-516-retirada` desde el worktree; si mi mapa lo niega, lo hace el integrator con ese comando.

## Verificación
- `node --test packages/electron/scripts/verify-linux-appimage.test.mjs` → 6 pass (incluye producto renombrado).
- `bun run --cwd packages/web test -- fork-update` → 15 pass (dispatch reencaminado).
- `vitest run package-manager openchamber-routes commands-update` → 34 pass (flujo nuevo releases/latest + negativa de instalación).
- YAML válido en los 10 workflows tocados; barrido automático secretos↔environment sobre los 90.
- Checks de #122 en verde (type-check + tests, run 37552650437). #123: ver ESPERA.
- No ejecutado: un release real (primer `workflow_dispatch` tras el merge es la prueba end-to-end; run id se anotará aquí), ni TestFlight real (bloqueado por SC-1953).

## Checklist de criterios (00-spec.md, con la nota del architect P5 por delante)
- [x] Release del fork con `.dmg`, `.exe`, `.AppImage` nombre AgentChamber: workflows listos en main tras #112+#119; el grep de assets se comprobará contra el primer run real (sin release publicada aún — el criterion es verificable tras el primer dispatch).
- [ ] Web servida desde el build del fork: runbook y artefactos entregados (#123); el cambio vivo de `~/.local/openchamber/current` lo ejecuta `release` tras el merge, no este ticket.
- [x] iOS por TestFlight: `mobile-release.yml` con `build_ios=true` por defecto y paso de subida a TestFlight; environment protegido `testflight` ya existe (SC-1953, PR #113 en curso para declararlo en el job).
- [ ] Jordi: ≥3 runs iOS + evidencia TestFlight: **bloqueado por credenciales Apple (SC-1953)**. El App ID queda decidido por SC-1953 (`com.pocharlies.openchamber`, ya en `vars.IOS_BUNDLE_ID`): no hace falta Request aparte. La retirada operativa (archivar `openchamber-build-pocharlies`, desactivar el runner `github-runner-openchamber-build.service` en x86 y el del MacBook) va en el runbook, tras el primer release promocionado — no se ha ejecutado aún.
- [ ] Credenciales Apple en environment: lo cierra SC-1953 (Request IT), no este ticket.
- [x] Documentación: `docs/release-promotion.md` + ARCHITECTURE.md §8.

## Reutilizado
- Composite `.github/actions/setup-node-bun` existente (ampliado, no copiado); patrón arc-k8s de `fork-pr-checks.yml`; `mobile-release.yml` ya reescribía bundle id con `vars.IOS_BUNDLE_ID` (solo cambiado el runner); `verify-linux-appimage.mjs` existente (parametrizado). Buscado con `rg blacksmith`, `rg openchamber-build-pocharlies`, `rg '@openchamber/web'`; nada nuevo de más: cero workflows nuevos, cero pipelines nuevos.

## Decisión npm: resuelta por el architect (opción b) e implementada en la ronda 2
Ya no hay PREGUNTA abierta: el chequeo lee `releases/latest` del fork y ningún camino de instalación ejecuta `npm install -g @openchamber/web`. El job `publish-npm` de #122 queda condicional sin token (inofensivo); publicarlo o no es decisión futura, no bloquea este ticket.

## ACCIÓN (antes del merge de #122)
0. El environment `release` **no existe** en el repo (404 medido con `gh api repos/pocharlies-org/openchamber/environments/release`). Si un workflow lo referencia antes de crearlo, GitHub lo crea implícitamente sin protección. Crear con revisores obligatorios: `gh api -X PUT /repos/pocharlies-org/openchamber/environments/release -f required_reviewers='[{"reviewer_type":"User","id":ID_DE_POCHARLIES}]'` (el id: `gh api user --jq .id` con esa cuenta). Lo pide el CTO amplió SC-1953; config de repo, no lo escribe esta cuenta. Nota: las vars `IOS_BUNDLE_ID`/`IOS_URL_SCHEME` del repo están vacías (medido) — SC-1953 dice ponerlas o el build iOS sale con el bundle id de upstream.

## ACCIÓN (operativa, tras el merge de #122+#123 y el primer release)
1. `release` ejecuta `docs/release-promotion.md` para el primer release desde main.
2. Retirada: `gh repo archive pocharlies-org/openchamber-build-pocharlies` + `systemctl --user disable --now github-runner-openchamber-build.service` (x86) + runner del MacBook desactivado. Lo hace `release`/IT con el runbook; no corre en automático.
