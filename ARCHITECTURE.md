# ARCHITECTURE.md — AgentChamber (fork de OpenChamber)

> Escrito por el architect de la compañía (DGX-513, 2026-10-06). Lo medido está fechado; si algo contradice el repo, se corrige en el mismo cambio. Repo: `pocharlies-org/openchamber` (público, fork de `openchamber/openchamber`). Checkouts de trabajo en el x86: `~/src/openchamber-fork` y `~/k8s/openchamber-fork` (este último con árbol de trabajo, medido 2026-10-08).

## 1. Qué es y clientes

AgentChamber es el fork de la compañía de OpenChamber: una UI web/escritorio/móvil para agentes de código, con dos motores de sesión lado a lado — **OpenCode** (nativo) y **Claude Code** (`packages/web/server/lib/claude`) — y la arquitectura preparada (sin código de ejecución) para un tercero (Codex). «Fork oficial» = fork oficial de la compañía; **no** implica respaldo de upstream (sin respuesta de Bohdan a 2026-09-30). MIT cubre el código, no la marca ni el scope `@openchamber/*`.

Un producto, un servidor, varios clientes. Todos hablan con el mismo servidor Node (`packages/web/server`) y pintan la misma UI React (`packages/ui`):

| Cliente | Dónde vive | Framework | Notas |
|---|---|---|---|
| Web (+ CLI `openchamber`) | `packages/web` (`src/` UI shell, `server/` Express, `bin/cli.js`) | React 19 + Vite, Express, vitest | Lo que sirve la compañía desde `~/.local/openchamber/current` |
| Escritorio mac/win/linux | `packages/electron` | Electron + electron-builder | Backend **en proceso**, nunca sidecar; build empaquetado carga `openchamber-ui://` |
| Móvil iOS/Android | `packages/mobile` | Capacitor | Empaqueta la superficie web móvil y **conecta a un servidor existente**; no lleva servidor |
| VS Code | `packages/vscode` | Extension host + webview | UI compartida vía puente de runtime |
| Paneles de terceros | `packages/sdk`, `packages/extensions` | SDK guest (iframe + `connectHost`) | `extensions` no es workspace de Bun |
| Docs | `packages/docs` | MDX | No es workspace |

**Lo que viaja entre clientes es el criterio de aceptación, no la implementación.** La lógica y la UI viven una vez en `packages/ui` (+ contratos `RuntimeAPIs`, `runtimeFetch`); cada runtime solo aporta su borde (Electron: IPC privilegiado; Capacitor: plugins nativos; VS Code: puente). Reimplementar una pantalla dentro de un cliente, o meter un webview de otra superficie, es un hallazgo. Un contrato compartido debe definir comportamiento para cada runtime aplicable (web, desktop, VS Code, hosted mobile, Capacitor).

## 2. Dependencias, en los dos sentidos

**Del fork hacia fuera**
- `openchamber/openchamber` (upstream): fuente de tags (`v2.1.0` hoy). Sync por `.github/workflows/upstream-sync.yml` + `docs/upstream-sync.md` (existe en `main`, DGX-517).
- `@opencode/client` (OpenCode 2.x): único acceso a OpenCode desde la UI, vía `opencodeClient` (`packages/ui/src/lib/opencode/`); las formas de wire no salen de ahí. No se toca `../opencode`.
- Claude Code CLI + Agent SDK (`listSessions`, transcript store) en el x86.
- Apple (App Store Connect/TestFlight) y Android keystore para móvil; credenciales **solo** en GitHub `environment` protegido (hoy 0 secretos Apple; Request IT abierta).

**De fuera hacia el fork (superficies que no se rompen)**
- **`~/.local/openchamber`** (la compañía y el visor lo consumen): `releases/<id>/` (instalación de `@openchamber/web`), symlinks `current` y `beta`, `.anterior`, `.lock`, `backups/`. Binario `current/bin/openchamber → ../lib/node_modules/@openchamber/web/bin/cli.js`. Quien publica una release actualiza el symlink; el rebrand **no** renombra ni mueve estas rutas ni el bin `openchamber` ni sus puertos. Un cambio de ruta/bin = entrada nueva junto a la vieja.
- **Ids de sesión**: `ses_ccc…` (sesión Claude) y `ses_ccs…` (subagente Claude); el prefijo es solo fallback, manda `metadata.backend` (`server/lib/claude/v2-wire.js`). No cambian.
- **Filing de Compañía**: `server/lib/claude/company-sessions.js` (`isCompanyClaudeSession`: patrones anclados a los prompts de despacho, cwd bajo `compania/` o `startupcompany/employees/`) estampa `metadata.company = true`; `server/lib/session-folders/auto-file.js` (`COMPANY_FOLDER_NAME = 'Compañía'`) escribe la carpeta en `sessions-directories.json` (`OPENCHAMBER_DATA_DIR`); la UI lo lee solo por `isCompanySession` (`packages/ui/src/components/session/sidebar/folders/companySessionFlag.ts`). Una sola regla; el hook de navegador `useCompanyAutoFolders` es legado. Los prompts de despacho de la compañía (`jira-epic-trigger`, supervisor, tech-lead) son un contrato implícito: cambiar sus aperturas rompe el filing.
- API HTTP `/api/session*`, `/api/engines`, `/api/claude/*`: la consumen UI, compañía y visor. La superficie Claude consumida son `POST /api/session/:id/prompt` y `POST /api/session/:id/interrupt` (`server/lib/claude/routes.js`) — no `/prompt_async` ni `/abort`, que no existen aquí.

## 3. Motores de sesión (el seam de proveedor)

Ya existe y es la abstracción canónica; **no se crea otra**:
- Servidor: `packages/web/server/lib/engines/engines.js` — `ENGINES` (declaración por motor: `capabilities` booleanas por operación + `models: providers|catalog`, `agents: agents|modes`, `commands: server|prompt`), `ENGINE_OPERATIONS`, `operationOfPath`, `sendUnsupportedOperation`, ruta `GET /api/engines`.
- Cliente: `packages/ui/src/lib/sessionEngine.ts` — `SessionEngine = 'opencode' | 'claude'`, `SESSION_ENGINE_INFO`, `useSessionEngine`, `EngineUnsupportedError`; tabla de respaldo que refleja la del servidor.
- Un motor no soportado responde con `UnsupportedOperationError` tipado, nunca reenvía al otro motor.

Dos adaptadores reales (OpenCode, Claude) → seam legítimo. Añadir Codex = una entrada nueva en `ENGINES` + tabla del cliente + módulo `server/lib/<motor>/` con su ruta; sin tocar la UI salvo copy. No hay motor Codex: `ENGINES` no tiene entrada `codex` ni existe `server/lib/codex/`; lo que queda de `codex` es lectura de cuota (`fetchCodexQuota`), no ejecución.

## 4. Stack

- Bun 1.4.2 (`packageManager`), Node ≥22, workspaces `packages/*`. TypeScript, React, Vite, Express, Tailwind/shadcn (`components.json`), Zustand (stores), Electron, Capacitor, Zod en el wire.
- Lint: ESLint (`eslint.config.js`), `oxlint` anti-slop (`lint:anti-slop`), `knip.json` (código muerto), `scripts/react-doctor.mjs`.
- No se añaden dependencias sin petición explícita (regla de `AGENTS.md`). Sin segundo sistema de estado ni segundo cliente HTTP.
- Releases/changelog: las notas las escribe el mantenedor al pedir changelog, en `changelog/unreleased.md`; no se tocan en PRs de feature.

## 5. Componentes compartidos (canónico → ruta)

| Cosa | Ruta canónica |
|---|---|
| Qué motor es una sesión y qué puede hacer | `packages/ui/src/lib/sessionEngine.ts` + `packages/web/server/lib/engines/engines.js` |
| Cliente OpenCode | `packages/ui/src/lib/opencode/client.ts` |
| Backend Claude | `packages/web/server/lib/claude/` (ver su `DOCUMENTATION.md`) |
| Detección de sesión de compañía | `server/lib/claude/company-sessions.js` → `companySessionFlag.ts` |
| Carpetas de sesión / filing | `server/lib/session-folders/auto-file.js`, `useSessionFoldersStore.ts` |
| Tipos de panel de terceros | `packages/sdk` (no copiar a `packages/ui`) |
| i18n | `packages/ui/src/lib/i18n/messages/*` (paridad Claude: `claude-parity.i18n.ts`) |
| Datos de iconos/sprites | `scripts/generate-*-sprite.mjs` |
| Concurrencia acotada (servidor) | `packages/web/server/lib/concurrency.js` (`mapWithConcurrency`; la de UI es `packages/ui/src/lib/concurrency.ts` y no se importa desde el servidor) → la usa `claude/runtime.js` |

Marca (tras DGX-514): `scripts/brand-allowlist.txt` (referencias históricas permitidas, motivo por entrada) + test que falla si crece sin revisión.

## 6. Cómo se construye aquí

- Estructura: lógica de UI en `packages/ui`, backend en `packages/web/server/lib/<dominio>/` con `DOCUMENTATION.md` por módulo cuando existe. Electron solo borde nativo. Antes de editar: `AGENTS.md`, skills del proyecto, `DOCUMENTATION.md` y README más cercanos.
- Reutilizar antes de crear: motor/capacidad → sección 3; filing → sección 5. Un helper nuevo que ya existe en `packages/ui/src/lib` es hallazgo.
- Tests junto al código (`*.test.ts|js|mjs`), con `bun:test` o `node:test` o vitest según el paquete (el framework se lee de los imports).

## 7. Tests y validaciones

| Qué | Comando |
|---|---|
| Todo | `bun run test` (= `node scripts/run-isolated-tests.mjs scripts` + sdk + ui + vscode + electron + web) |
| UI | `bun run --cwd packages/ui test` (cada fichero en su proceso: singletons de módulo; no mezclar en uno) |
| Web/servidor | `bun run --cwd packages/web test` (vitest + supertest) |
| Tipos | `bun run type-check` |
| Lint | `bun run lint`, `bun run lint:anti-slop` |
| Changelog | `bun run changelog:check` |
| Sync de upstream | `node --test scripts/upstream-sync.test.mjs` |
| Guarda de workflows (llega con #112) | `node --test scripts/check-workflow-guard.test.mjs` |

La suite web tiene fallos heredados de upstream; la puerta de PR del fork usa `vitest --changed` en web y suite completa en ui (ver `fork-pr-checks.yml`).

## 8. CI/CD y despliegue

- **Regla de la org**: CI genérico en runners **ARC `arc-k8s`** (skill `ci-runners-arc`); la imagen no trae node ni bun (se instalan con checksum, patrón en `.github/workflows/fork-pr-checks.yml`). `ubuntu-latest`/`macos-*`/`windows-*` solo con motivo escrito en el workflow (firmar iOS/mac y empaquetar Windows requieren SO propio; repo público = minutos hosted gratis) y **nunca** con secretos en eventos de PR. El paso node+bun canónico es el composite `.github/actions/setup-node-bun` (lo usan `fork-pr-checks.yml` y `upstream-sync.yml`); `release.yml`, `mobile-release.yml`, `sdk-preview.yml`, `vscode-extension.yml` y `mobile-ci.yml` aún llevan etiquetas `blacksmith-*` heredadas (seguimiento DGX-516).
- **Repo público + runners de casa = ejecución remota por PR externa.** Guarda (DGX-515): 0 `runs-on: self-hosted|macbook|x86` en `pull_request`; 0 `pull_request_target` con secretos; todo job con secretos o runner propio tras `environment` con aprobación manual; aprobación obligatoria de workflows de colaboradores externos en la config del repo; un check automatizado con test de fixture que falla si reaparece.
- Workflows de upstream (bots `pr-review`, `pr-intake`, `label-merge-conflict`, `issue-intake`, `oc-review`…) usan secretos de upstream (`OC_REVIEW_APP_*`, `ZHIPU_API_KEY`) y `pull_request_target`: se eliminan del fork (commit de la pila), no se editan línea a línea.
- **Troncos hoy (medido 2026-10-06, tras DGX-517)**: `main` es la línea propia — la pila v2.1.0 se fusionó en `main` por la PR 111, y `fork-pr-checks.yml` apunta a `main`. La pila ya no es una rama viva: `stack-v2.1.0` (`build/v2.1.0-metrics`, ce23059867) queda solo como historia. Antes de eso `main` era espejo del de upstream y la línea propia vivía en `build/v2.0.1-metrics`. El repo no es GitOps: no hay ArgoCD; PR contra `main`, nunca push directo.
- Release hoy: el workflow de build vive fuera, en `openchamber-build-pocharlies` (privado, runner del MacBook), que publica `releases/<id>` en `~/.local/openchamber`. DGX-516 lo sustituye por `release.yml`/`mobile-release.yml` del fork y lo retira. `current` solo cambia por paso explícito de la release.
- Sync de upstream (`upstream-sync.yml` + `docs/upstream-sync.md`, DGX-517): `schedule` + `workflow_dispatch(dry_run)`, `arc-k8s`, rebase/cherry-pick de la pila propia sobre el último tag, run en `failure` si hay conflicto, issue con ficheros en conflicto y lista de commits propios. `GITHUB_TOKEN` **no puede empujar cambios a `.github/workflows/`**: la decisión (escrita en `docs/upstream-sync.md`) es **solo-reporte cuando el tag toca `.github/workflows`** — el run publica el reporte y el push queda a mano. Un token de GitHub App en `environment: upstream-sync` (aprobación manual) para empujar también esos casos queda como mejora.

## 9. Decisiones y trampas

- Un solo motor-seam (sección 3); `AgentProvider` (DGX-518) es nombre/alias documentado de ese seam, no un segundo.
- El `appId` móvil y el `productName` de Electron cambian con el rebrand (DGX-514); lo consumido por la compañía (`~/.local/openchamber`, bin, puertos, ids de sesión/filing) no.
- `mobile-release.yml` ya soporta bundle id propio (`vars.IOS_BUNDLE_ID`, `IOS_URL_SCHEME`): el rebrand iOS usa esa variable, no sed ad hoc.
- Release/ejecución en el x86: ver sección 2; nunca editar `~/.local/openchamber` a mano.
- Un `.jsonl` de transcript no se lee entero: `readFile` sobre un transcript es hallazgo (DGX-671: OOM en bucle con 5.066 transcripts / 7,2 GB). `transcript-sidecar.js` lee por líneas y la lista de sesiones Claude se construye con `LIST_BUILD_CONCURRENCY`.
- Pendiente para el architect: añadir el árbol de decisiones de marca cuando Bohdan conteste.
