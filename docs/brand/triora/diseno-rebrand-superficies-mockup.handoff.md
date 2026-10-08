Rol: designer · Fecha: 2026-10-06 · Sesión: fca43038-842a-4d2c-82a5-e556fcf2d3f7 · Estado: LISTO

# Handoff · rebrand AgentChamber, revisado tras `nota-ux-mockup.md`

Este handoff sustituye al del 2026-10-03. El canvas sigue siendo de baja fidelidad salvo el icono, que ya es el definitivo: todo icono que aparece en el canvas es un fichero entregado, embebido tal cual. Los de 16/24/29/32/38 px son el raster real.

## Dónde está

- **Canvas**: `docs/brand/triora/diseno-rebrand-superficies-mockup.dc.html`, en la rama `designer/DGX-514-assets` (PR en borrador #116 contra `main`: https://github.com/pocharlies-org/openchamber/pull/116). Hay una copia adjunta a DGX-513 con el mismo nombre. Se abre en el editor de Claude Design o en cualquier navegador. Para ver el otro tema, cambia `data-theme` del `<x-dc>` raíz.
- **Assets**: en sus **rutas finales**, en la misma rama. No hay carpeta intermedia de la que copiar. Para llevarlos a tu rama:
  `git fetch origin && git checkout origin/designer/DGX-514-assets -- packages/electron/resources/icons packages/web/public packages/mobile docs/brand`
- **Regenerarlos** (si hay que tocar el icono): `bun install` y luego `bun run brand:icons` (= `node scripts/build-brand-icons.mjs`) desde la raíz. Usa `sharp`, que ya es dependencia de la raíz. Hay una sola geometría para todos los ficheros. Comprobación de que es reproducible: `bun run brand:icons && git diff --exit-code -- packages docs/brand` (un salto de versión de `sharp` puede mover bytes de un PNG sin cambiar la imagen). `Assets.car` (macOS 26) sale aparte, en un Mac: `bun run --cwd packages/electron generate:macos-icon`. El de la rama ya está compilado con `actool` de Xcode (2026-10-06).

## Hallazgos de UX y cómo se cierran

| Hallazgo | Frame | Resolución |
|---|---|---|
| Bloqueante · iOS, etiqueta de 12 caracteres | F3 | `CFBundleDisplayName` = **«AgentChamber»**, sin nombre corto. Se dibuja el peor caso (iPhone SE con «Zoom de pantalla» o texto grande): «AgentCham…». Se acepta porque sigue empezando por «Agent», el icono es único y Spotlight, Ajustes y TestFlight enseñan el nombre entero. «Chamber» rompería la búsqueda «agent» y la coincidencia con TestFlight. Que en un iPhone estándar cabe entero es **hipótesis sin medir**: qa lo mide en el simulador (skill `serve-sim` del repo) en iPhone SE (3.ª gen.) con Zoom de pantalla y en iPhone 16. |
| Bloqueante · Windows, dos entradas en Inicio | F4 | Estado resuelto: **una sola entrada**, AgentChamber, en Inicio y en Aplicaciones instaladas. El `appId` cambia (decisión del architect), así que hace falta un mecanismo: `nsis.guid` = el GUID que electron-builder derivaba de `dev.openchamber.desktop`. Con eso el instalador ve a OpenChamber como la misma app, ejecuta su desinstalador en silencio conservando los datos y deja solo AgentChamber. Sin `nsis.guid` el frame F4 no se cumple. Lo implementa el developer; qa lo verifica en Windows o lo deja como riesgo residual en su veredicto. |
| Barra de tareas sin dibujar | F4 | Dibujada en oscuro y en claro: anclada y cerrada, abierta y en primer plano (píldora `--accent`), con tooltip. El mismo `.ico` de 24 px en las dos. Un ancla hecha antes de actualizar tiene que seguir funcionando con el icono nuevo. |
| Cabecera web por debajo de 640 px solo en nota | F1 | Dibujada a 390 px. **Corrección del mockup anterior**: la cabecera real (`packages/ui/src/components/layout/Header.tsx`) no lleva logo. Muestra el título de la sesión o del proyecto, y solo sin ninguno el nombre del producto (fallback de `currentSessionTitle`). Se dibuja como es: el rebrand solo cambia ese texto. En móvil la marca la llevan el icono de inicio, la pestaña y el estado vacío. |
| Botones táctiles de 44 px | F1, F5, F6 | `.btn.touch` (`min-height: 44px`, 15 px) y `.btn.block` (todo el ancho) en la web por debajo de 640 px y en iOS. En móvil, B1 lleva los botones apilados, el principal primero. Menú, nueva sesión y «más» de la cabecera móvil: 44 × 44. |
| Icono real verificado a 16/24/29 px | F0 | Raster real a 1:1 y ampliado ×6 sin suavizar, en pestaña clara y oscura. **Criterio de aceptación del icono:** a 16 px se distinguen el contorno del cubo y el rombo de color; a 24 y 29 px se leen las dos caras. Por debajo de 32 px el icono tiene tamaño óptico propio: trazo más grueso y rombo más grande. |
| `Comment` del `.desktop` en lenguaje interno | F4 | `Comment=Work with AI coding agents on your projects` y `Comment[es]=Trabaja con agentes de IA en tus proyectos de código`. |
| Token `--on-accent` | todos | Adoptado. En el canvas se declara una vez en `<helmet>`; en la plantilla va por PR en `pocharlies-org/dgx-infra`. |

Además, sin que lo pidiera UX: en iOS hoy se publica el **icono por defecto de Capacitor** (la X azul, en `AppIcon-512@2x.png` y en el splash). Este cambio lo sustituye. Si el bundle ID que llega a TestFlight (`vars.IOS_BUNDLE_ID`) no coincide con el de una build que el tester ya tenga, iOS la instala como otra app, sin los servidores guardados. Por eso F3 cambia el texto de «Qué probar» y F5 dice que en iOS se pasa de A a C sin B1.

## El icono

Se queda el cubo isométrico con la cara de arriba abierta, la cámara, para que quien venía de OpenChamber reconozca la silueta. Lo que cambia es el sello de OpenCode de la cara superior: pasa a ser un **rombo `--accent`**, el agente dentro de la cámara. Es la misma idea que ya usan el glifo de la bandeja de macOS (`tray/tray-glyph.svg`) y el icono de notificación de Android (`ic_stat_notify.xml`), y por eso esos dos **no cambian**.

Geometría (`scripts/build-brand-icons.mjs`, función `cube`): centro (cx, cy), arista e. Cara superior: T=(cx, cy−e), L=(cx−e·cos30, cy−e/2), F=(cx, cy), R=(cx+e·cos30, cy−e/2). El rombo es la cara superior escalada k = 0,5 sobre su centro (cx, cy−e/2); a 32 px o menos, k = 0,6.

**Logo dentro de la app (`packages/ui/src/components/ui/OpenChamberLogo.tsx`, del developer):** se conservan el cubo, la rejilla y la animación. Solo se sustituye el grupo «OpenCode logo on top face» por el rombo, en el viewBox 100 del componente:
`<path d="M50 14 L70.78 26 L50 38 L29.22 26 Z" fill={isDark ? '#ff5a1f' : '#ee4f0c'} />`
(es el `--accent` de la plantilla en cada tema: color de marca fijo, no el acento del tema de la UI). Renombrar el componente y su clave de i18n va con `brand.ts`.

## Assets entregados (rutas finales)

| Ruta | Tamaños | Notas |
|---|---|---|
| `packages/electron/resources/icons/icon.icns` | 16, 32, 64, 128, 256, 512, 1024 (icp4–icp6, ic07–ic14, PNG) | squircle oscuro; 16/32 con tamaño óptico |
| `…/icons/dev-icon.icns`, `dev-icon.png` | igual / 1024 | variante clara para las builds de desarrollo |
| `…/icons/icon.ico` | 16, 24, 32, 48, 64 (BMP 32 bits) + 128, 256 (PNG) | estilo Windows: transparente, borde oscuro; vale para la barra clara y la oscura |
| `…/icons/icon.png` · `app-icon.png` | 1024 · 512 | |
| `…/icons/app-icon.svg` · `icon-win.svg` | 1024 | Linux (`linux.icon`) · fuente de Windows |
| `…/icons/AppIcon.icon/Assets/app-icon-glyph-{dark 4,light 2}.png` | 1024 | capas de Icon Composer con los mismos nombres: `icon.json` no cambia |
| `…/icons/Assets.car` | — | compilado de `AppIcon.icon` con `actool` (Xcode, en el Mac) |
| `…/icons/tray/*` | — | sin cambios |
| `packages/web/public/favicon.svg` | 32 de viewBox | contorno `currentColor` que sigue `prefers-color-scheme`; rombo `.a` con `--accent` claro u oscuro |
| `…/public/favicon-16.png` · `favicon-32.png` · `favicon.png` | 16 · 32 · 64 | con fondo propio (squircle oscuro): se leen en cualquier barra |
| `…/public/apple-touch-icon{,-120x120,-152x152,-167x167,-180x180}.png`, `apple-touch-icon.svg` | 180, 120, 152, 167, 180 | a sangre, sin transparencia útil |
| `…/public/pwa-192.png` · `pwa-512.png` | 192 · 512 | `any` |
| `…/public/pwa-maskable-192.png` · `pwa-maskable-512.png` | 192 · 512 | el glifo cabe en la zona segura (círculo del 80 %) |
| `…/public/logo-{light,dark}-192x192.png`, `logo-{light,dark}-512x512.svg` | 192 · 512 | marca transparente para fondo claro y oscuro |
| `packages/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` | 1024, sin alfa | `Contents.json` sin cambios |
| `…/Splash.imageset/splash-2732x2732{,-1,-2}.png` + `-dark{,-1,-2}.png` + `Contents.json` | 2732 × 6 | claro y oscuro (`appearances: luminosity dark`); solo la marca, sin texto (HIG) |
| `packages/mobile/assets/icon-{only,foreground,background}.png` | 1024 | fuentes de Capacitor |
| `packages/mobile/android/app/src/main/res/mipmap-*/ic_launcher{,_round,_foreground,_background}.png` | 36, 48, 72, 96, 144, 192 | el foreground adaptativo respeta el inset del 16,7 % que pone `mipmap-anydpi-v26` |
| `…/res/values/ic_launcher_background.xml` | — | `#FFFFFF` pasa a `#101012` (`--bg` oscuro) |
| `…/res/drawable*/splash.png` | 11 tamaños | oscuro |

## Lo que sigue siendo del developer (no está en esta PR)

Los nombres y la configuración: `productName`, `appName`, appIds y bundle, `CFBundleDisplayName` «AgentChamber», `name`/`short_name`/`description` del manifest, `<title>` y `mask-icon` de `index.html`, `APP_TITLE` de `useWindowTitle.ts`, el fallback de `Header.tsx`, `Name`/`Comment`/`Comment[es]`/`Icon` del `.desktop`, `nsis.guid`, el flujo B1, el rombo de `OpenChamberLogo.tsx`, `app_name` de Android y el comentario de `ic_stat_notify.xml`. Todo pasa por `brand.ts` y la allowlist que fija el architect.

## Tokens usados (nombres de la plantilla)

`--bg`, `--surface`, `--surface-2`, `--text`, `--muted`, `--border`, `--accent` (CTA, foco, rombo del icono, píldora de la barra de tareas, pins) y `--accent-2` (hover del CTA). En el CSS del canvas no hay ningún color de la plantilla escrito a mano.

Tokens extra:
- `--on-accent` (**adoptado**): oscuro `var(--bg)` y claro `var(--text)`. Texto sobre `--accent`: 6,09:1 y 4,91:1, medido por UX. El blanco de `.cta` de la plantilla daba 3,12:1 y no pasaba AA. Va a la plantilla por PR en dgx-infra.
- `--danger: #e5484d` (propuesta): borde y punto de los errores, 4,39:1 y 3,91:1 como elemento no textual. Se declara una vez en `<helmet>`.

Los ficheros del icono llevan los valores de la plantilla escritos a mano, porque un PNG o un SVG suelto no puede leer `var()`:
- `--accent`: `#ff5a1f` oscuro y `#ee4f0c` claro.
- Fondo del squircle: `--surface-2` oscuro `#26262c` → `--bg` oscuro `#101012`; en claro, `#ffffff` → `--surface-2` claro `#eceae4`.
- Trazo: `#ffffff` o `--text` claro `#17171a`.
- Caras del `.ico` (`#3a3a41`, `#55555d`): no tienen token; solo existen en el icono, no en la UI.

## Componentes y estados

- `.btn` / `.btn.pri`: alto mínimo de 36 px; `.btn.touch` sube a 44 px (web por debajo de 640 px e iOS) y `.btn.block` lo pone a todo el ancho. Estados: normal, hover (`--accent-2` en el principal, `--bg` en el secundario), foco (anillo de 2 px `--accent` con 2 px de separación) y desactivado (opacidad 0,45). Texto del principal en `--on-accent`.
- `.err`: filete izquierdo de 4 px `--danger`, título, causa concreta y acciones. Nunca un error sin botón.
- `.hit`: zona táctil de 44 × 44 px en la cabecera móvil.
- `.taskbar` y `.slot`: barra de tareas de Windows con la ranura de 40 px y el icono de 24. Píldora `--muted` si está abierta y `--accent` si está en primer plano.
- `.ic` y `.px`: el icono real (SVG que escala / raster de verificación píxel a píxel).

## Layout

- Escala tipográfica (Archivo): 24 título · 15 sección · 14 título de pantalla · 13 cuerpo y botón (15 en táctil) · 12 secundario · 11 mono para etiquetas · 10 etiqueta de icono.
- Espaciado en pasos de 4: 8, 10, 12, 16, 20 y 24.
- Radios: 8 para campos, 9 para botones, 10 y 12 para ventanas y frames, 22 % para iconos y 28 para el teléfono.
- Breakpoint web: 640 px. Por debajo, objetivos de 44 px; la cabecera sigue siendo la de siempre (título con «…»).

## Variantes de tema

`data-theme="dark"` por defecto. En claro (`data-theme="light"`): los iconos maestros de marca, la prueba a tamaño real, la pestaña y el favicon claros, la ventana del dmg, el launch de iOS, la barra de tareas clara y B1 con los botones. El splash de iOS trae las dos variantes en el asset catalog.

## Decisiones con su motivo

- Se queda el cubo y cambia el sello por un rombo `--accent`: así hay continuidad para el usuario de OpenChamber, y la bandeja y la notificación de Android ya eran cubo + rombo.
- `CFBundleDisplayName` completo: coincide con TestFlight, Ajustes y Spotlight, y la búsqueda «agent» la encuentra. El peor caso truncado sigue siendo reconocible.
- Windows con `nsis.guid` fijado al GUID viejo: es la única forma de que un `appId` nuevo no deje dos apps instaladas.
- La cabecera no gana logo: el rebrand no rediseña pantallas, y la cabecera real nunca lo tuvo.
- Favicon PNG con fondo propio y SVG adaptativo: el PNG se lee en cualquier barra y el SVG sigue el tema como hasta ahora.
- Launch de iOS sin texto, en claro y en oscuro: lo pide la HIG y evita el fogonazo blanco en modo oscuro.
- Tamaño óptico por debajo de 32 px: los 16, 24 y 32 se generan aparte, no se reescalan del 1024.
- El fondo del dmg se queda (`#FFFCF0`): el rebrand no rediseña el instalador.

## Abierto para el plan

- El criterio de `00-spec.md` de DGX-514 dice `packages/electron/build/icon.{icns,ico,png}`, pero electron-builder lee `buildResources: resources/icons`. Los ficheros están ahí. El criterio debería decir `packages/electron/resources/icons`: es del tech-lead o del architect.
- El nombre en App Store Connect y TestFlight es un paso manual de quien tiene la cuenta (DGX-516).
