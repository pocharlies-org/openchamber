Rol: developer · Fecha: 2026-10-07 · Sesión: fcd9317b-4bc2-4105-a2e8-cbab9308109f · Estado: LISTO

# DGX-514 · Rebrand AgentChamber

PR: https://github.com/pocharlies-org/openchamber/pull/119 (rama `developer/DGX-514-rebrand`, contra `main`). Incluye los assets de #116 (mismos ficheros); rebasar sobre main cuando #116 esté fusionada.
URL web para ux: servir la build de la rama con `bun run --cwd packages/web dev` (puerto que imprima) — sin login; pestaña, favicon y estado vacío con AgentChamber. (Pendiente que ux levante su instancia; no hay despliegue.)

## Qué se hizo
- `packages/ui/src/lib/brand.ts` (`BRAND_NAME`); 2049 literales de i18n pasan a `{brand}` (13 idiomas) y `formatMessage` lo inyecta; ~34 literales de UI/Electron por la constante.
- Electron: `productName` AgentChamber, `appId` com.pocharlies.agentchamber, `nsis.guid` = 103a64e2-d142-5f36-803b-284d778c8afd (UUID v5 del appId viejo con el namespace de electron-builder, leído de app-builder-lib 26.8.1), `.desktop` Name/Comment/Comment[es], AUMID, `brand.mjs`; `userData` fijado a la carpeta vieja `OpenChamber` para no perder ajustes al cambiar el nombre.
- Capacitor: `appName` AgentChamber, `appId` com.pocharlies.agentchamber; Info.plist (nombre y permisos), `app_name` de Android, `index.html`/`site.webmanifest`, `mask-icon` al acento #ee4f0c.
- Rombo en `OpenChamberLogo.tsx`; `--on-accent` en `design-system.css` (`--primary-foreground` lo usa).
- `scripts/brand-allowlist.txt` (639 ficheros, agrupados con motivo) + `scripts/brand-allowlist.test.mjs`.

## Rompe actualización in-place (declarado)
`appId` de Electron y Capacitor cambian: macOS y Linux no actualizan sobre la instalación vieja (reinstalar; datos conservados). Windows sí actualiza gracias a `nsis.guid` (sin probar aquí: riesgo residual para qa). iOS: se mantiene `vars.IOS_BUNDLE_ID` (com.pocharlies.openchamber) y los ids nativos de Xcode/Gradle sin tocar; migrar necesita App ID nuevo (IT, DGX-516). Detalle en `.company/changes/agentchamber-app-id.md`.

## Cómo verificar
- `grep -nE '"productName"|appId' packages/electron/package.json; grep -nE "appId|appName" packages/mobile/capacitor.config.ts`
- `git grep -il openchamber -- packages/ui/src packages/electron packages/mobile | grep -vxFf scripts/brand-allowlist.txt | wc -l` → 0 (medido)
- `node --test scripts/brand-allowlist.test.mjs` → 3/3
- `grep -n guid packages/electron/package.json`
- type-check y lint verdes; anti-slop solo con hallazgos previos de `config-v2.d.ts`.
- Tests completos: locales fallan `scripts/bump-version.test.mjs` (esperaba 1.24.0, recibe 1.23.1) y un test de bundles de ejemplos del sdk; no los toca este cambio (hipótesis: preexistentes); el resto en los checks de la PR.

## Checklist 00-spec.md
- [x] productName/appName/appIds propios
- [x] grep de marca = 0 con allowlist por ficheros con motivo y test
- [x] iconos en `packages/electron/resources/icons`, iOS y web (de #116)
- [x] `nsis.guid` fijado (prueba de actualización en Windows: residual de qa)
- [ ] iOS cabe en pantalla: lo mide qa con serve-sim (`CFBundleDisplayName` completo)
- [x] web: `<title>` AgentChamber (comprobar con curl en la instancia de ux)
- [x] contratos: no se tocan puertos, rutas de `~/.local/openchamber`, bin, ids de sesión/filing
- [ ] `nota-ux-revision.md`: de ux
- [x] documentación: `brand.ts`, `brand-allowlist.txt` y `.company/changes/agentchamber-app-id.md`; ARCHITECTURE.md ya describe la marca

## Reutilizado
- `formatMessage` (`lib/i18n/store.ts`) extendido con un valor por defecto, no un loader nuevo; `docs/brand/agentchamber/*` del designer (assets); `scripts/run-isolated-tests.mjs` ya recoge el test nuevo.
- Búsquedas: `rg -n "OpenChamber" packages/ui/src/lib/i18n`, `git grep -il openchamber -- <3 rutas>`, `rg "setName|userData" packages/electron`, `rg "com.openchamber.app"`.
- Nuevo: `brand.ts` y `brand.mjs` (dos bundles distintos, una constante cada uno), la allowlist y su test (lo pide el plan P3).
