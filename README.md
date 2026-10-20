# mycontent-cloudtalk-mcp

Servidor MCP remoto para que cualquier usuario gestione **su propia cuenta de [CloudTalk](https://www.cloudtalk.io)** desde Claude (claude.ai, Cowork, Claude Code), Codex u otro cliente MCP.

- URL del conector: `https://cloudtalk-mcp.mycontent.academy/mcp` (Streamable HTTP; `/sse` heredado).
- Cloudflare Workers + `McpAgent` (Durable Object) + OAuth 2.1 (`@cloudflare/workers-oauth-provider`) con login de Google.
- Patrón de planes en dos fases similar a [MyContentGoogleMCP](https://github.com/ivanfc/MyContentGoogleMCP) y MCP-Sendy: confirmación literal, re-lectura del estado antes de aplicar, cerrojo contra doble aplicación, auditoría por usuario, cuota diaria en un Durable Object y logs JSON sin datos personales. Este MCP tiene Worker, KV, cliente OAuth y token de despliegue propios.
- Cobertura: **las 107 operaciones** del OpenAPI oficial de CloudTalk (v1.7). Ver [API-COVERAGE.md](API-COVERAGE.md).

Estado: **0.1.0**. 61 tests unitarios y 3 pruebas de integración de solo lectura superadas contra una cuenta real el 20-10-2026 (ver «Validado»).

## Cómo funciona el acceso (multiusuario)

1. El usuario añade el conector y acepta el cliente (pantalla de consentimiento del Worker).
2. Login con Google (solo `openid email profile`; email verificado obligatorio). `ALLOWED_EMAILS="*"`: cualquiera con cuenta de Google puede conectarse, porque **solo puede operar con la clave de CloudTalk que él mismo aporte**. `BLOCKED_EMAILS` corta a alguien concreto; para cerrarlo a una lista, pon los emails en `ALLOWED_EMAILS`.
3. **La autorización OAuth no se completa todavía.** El Worker muestra `/setup`, donde el usuario pega el *API Access Key ID* y el *Secret* de su CloudTalk (Account → Settings → API Keys; solo administradores). La clave viaja del navegador al Worker por POST; nunca pasa por el chat.
4. Se comprueba con una llamada de prueba (`agents_index?limit=1`). Solo entonces `completeAuthorization` guarda `{email, name, sub, cloudtalk: {keyId, secret}}` en las **props del grant**, que el proveedor OAuth cifra con una clave derivada del token del usuario.
5. Cada usuario opera solo con la cuenta de sus props: ninguna herramienta acepta una clave como argumento. Para cambiar de cuenta de CloudTalk: `disconnect_cloudtalk` y volver a conectar.
6. `disconnect_cloudtalk` (confirmación `"DISCONNECT"`): borra planes pendientes y revoca **todos** los grants del usuario (ahí vive la clave).

La API de CloudTalk es por empresa: lo que ve el conector es lo que ve la clave (todos los agentes, llamadas y contactos de esa cuenta).

## API de CloudTalk

- Basic Auth (ID de clave : secreto) en todos los hosts. Cuatro hosts, fijados en el catálogo: `my.cloudtalk.io/api` (core), `analytics-api.cloudtalk.io/api` (detalle de llamada), `api.cloudtalk.io/v1` (Conversation Intelligence, VoiceAgent, Dialer, webhooks) y `platform-api.cloudtalk.io/api` (CueCards).
- En la API core `PUT` crea y `POST` actualiza (al revés de lo habitual); las respuestas van en `{responseData: …}` y algunos errores llegan con HTTP 200 dentro del sobre (el cliente los detecta, igual que `success:false` en SMS).
- **Límite: 60 peticiones/minuto por empresa**, compartidas con cualquier otra integración de esa cuenta (respuesta 429 y cabeceras `X-CloudTalkAPI-*`). El cliente reintenta una vez las lecturas si la espera es ≤ 5 s; las escrituras nunca se reintentan.
- Fuente del contrato: `https://help.cloudtalk.io/api-reference/openapi.json`, copiado byte a byte en `spec/cloudtalk-openapi.json` (sha256 `184b4fa8…d964`, publicado el 19-10-2026). `developers.cloudtalk.io` no era accesible desde el entorno de desarrollo; la copia procede del archivo público de [api-evangelist/cloudtalk](https://github.com/api-evangelist/cloudtalk), cuyo registro de descarga indica `match: byte-identical` con el documento del proveedor.
- `scripts/build-catalog.mjs` convierte el spec en `src/cloudtalk/catalog.json` (operaciones, hosts, parámetros, esquemas de body). La CI lo regenera y falla si difiere. Para actualizar: sustituir el spec, regenerar, `node scripts/coverage-md.mjs`, revisar `src/plans/policy.ts`.

## Herramientas (22)

| Herramienta | Tipo | Qué hace |
|---|---|---|
| `describe_api_operation(operation?, filter?, tag?)` | catálogo | Las 107 operaciones: búsqueda y esquema exacto (parámetros, campos del body, obligatorios, enums) y su barrera. No llama a CloudTalk. |
| `api_read(operation, path_params?, query?, all_pages?, max_items?)` | lectura | **Cualquier** GET del catálogo, validado contra el esquema; paginación page/limit o cursor. |
| `check_connection` | lectura | Prueba la clave; latencia, agentes visibles y estado del límite por minuto. |
| `get_account_overview` | lectura | Agentes (disponibilidad, extensión, números), grupos, números (a qué están conectados) y estadísticas en vivo de hoy por grupo. |
| `list_calls(filtros, max_calls)` | lectura | Historial compacto: fecha, tipo, contestada, conversación, espera, números, agente, contacto, coste, etiquetas, notas, enlace. |
| `get_call_report(filtros, group_by, max_calls)` | lectura | Informe agregado por agente, día, hora, número, tipo o contacto: llamadas, contestadas, perdidas, tasa de respuesta, minutos, medias y coste. Dice si es parcial. |
| `get_call(call_id, parts[])` | lectura | Detalle (call flow, tiempos, etiquetas, valoración) + Conversation Intelligence: resumen, sentimiento, ratio hablar/escuchar, temas, smart notes, transcripción. Lo no disponible se informa con su motivo. |
| `find_contacts`, `get_contact` | lectura | Búsqueda y ficha (con notas, actividades y últimas llamadas opcionales). |
| `get_capabilities`, `get_quota_usage` | lectura | Qué permite y qué no, barreras, límites y uso de hoy. |
| `plan_api_call(operation, path_params?, query?, body?, allow_undocumented_fields?)` | plan | **Cualquier** escritura del catálogo (PUT/POST/PATCH/DELETE), validada contra el esquema, con lectura del estado ANTES y la barrera de la operación. |
| `plan_create_contact` | plan | Contacto con teléfonos E.164, emails, etiquetas, atributos y URLs externas; rechaza duplicados por teléfono salvo `allow_duplicate`. |
| `plan_update_contact` | plan | Modifica sin perder datos: **fusiona** teléfonos y emails (CloudTalk reemplaza las listas completas en `edit`) y añade/quita etiquetas por sus endpoints. Solo envía lo que cambia. |
| `plan_send_sms` | plan | SMS o WhatsApp desde un número **de la cuenta** (se comprueba) a 1–20 destinatarios; uno a uno con resultado individual. Siempre APPLY-ELEVATED. |
| `plan_make_call` | plan | Click-to-call: comprueba agente y permiso de salientes, avisa si no está online. |
| `apply_plan`, `preview_plan`, `list_pending_plans`, `cancel_plan`, `get_audit_log` | planes | Ejecutar con confirmación literal, revisar, retomar, descartar y auditar (solo lo propio). |
| `disconnect_cloudtalk(confirm)` | escritura | Borra la clave y los planes y revoca los grants. |

## Barreras

Política (la misma que Google Ads): **todo lo que permite la API se puede hacer por el MCP**, con dos niveles de confirmación.

1. **Dos fases siempre.** Ningún `plan_*` escribe. El plan valida contra el esquema oficial (rechaza parámetros y campos inventados), lee el estado del objeto afectado (ANTES) y guarda su hash; se guarda **cifrado** (AES-GCM con clave derivada de la clave de CloudTalk del usuario) 24 h, o 2 h si contacta a terceros. `apply_plan` exige `APPLY <id>` o `APPLY-ELEVATED <id>`, vuelve a leer el estado y **aborta si cambió**, reclama el plan en un cerrojo global (`PlanLock`) junto con la cuota (un solo uso aunque haya dos llamadas simultáneas) y ejecuta paso a paso.
2. **APPLY-ELEVATED**: borrados (contactos, agentes, grabaciones, notas, actividades, etiquetas, campañas, VoiceAgents, bases de conocimiento, webhooks, lista negra); `numbers_edit`/`numbers_clear` (enrutado de llamadas entrantes); alta de agentes (licencia); cambios de email, salientes o límite de gasto de un agente (solo si cambian de verdad); SMS/WhatsApp; llamadas de VoiceAgent; crear webhooks, cambiar su URL o eventos y rotar su secreto (datos personales a sistemas externos); activar campañas del Dialer; `bulk_contacts` con borrados. Lista exacta en [API-COVERAGE.md](API-COVERAGE.md) y en `src/plans/policy.ts` (un test impide que diverjan).
3. **APPLY**: todo lo demás (contactos, notas, actividades, etiquetas, lista negra, scripts, encuestas, CueCards, llamada click-to-call…). Desvincular (quitar etiquetas, sacar un agente de un grupo, desvincular una base de conocimiento, archivar un script) no es un borrado.
4. **Bloqueo duro** opcional: `HARD_BLOCKED_OPERATIONS` (ids o `tag:<Área>`), vacío por defecto.
5. **Resultados honestos**: `ok:true` solo si todo se hizo; cada llamada devuelve `DONE`, `FAILED`, `UNKNOWN` (error de red o 5xx tras enviar una escritura: puede haberse aplicado, no se reintenta) o `NOT_ATTEMPTED`.
6. **Cuota diaria** (UTC) por usuario y global: peticiones (`QUOTA_USER_CALLS` 5.000 / `QUOTA_GLOBAL_CALLS` 100.000) y contactos salientes: SMS, llamadas y VoiceAgent (`QUOTA_USER_OUTREACH` 100 / `QUOTA_GLOBAL_OUTREACH` 2.000).
7. **Auditoría** por usuario (12 meses): plan, operaciones, IDs, nombres de los campos enviados (no sus valores), resultado y error por paso. **Logs**: una línea JSON por llamada (herramienta, usuario seudonimizado, resultado, ms), sin argumentos.

## Lo que la API de CloudTalk no permite (y el MCP no simula)

Call flows/IVR/horarios/colas, comprar o portar números, crear o borrar grupos, roles y permisos, facturación, informes agregados oficiales (los calcula `get_call_report`), descargar el audio de grabaciones (`get_call` da enlace y transcripción) y subir ficheros a bases de conocimiento (usar `create_knowledge_base` con texto o URL).

## Puesta en marcha

Configuración de la instancia de MyContent, completada el 20-10-2026:

1. **KV**: creados el 20-10-2026 (`mycontent-cloudtalk-mcp-OAUTH_KV` `b13c54c66e4a419bad6dfe8761dfca9b`, `mycontent-cloudtalk-mcp-STATE_KV` `c6b45876e05242e698c6a2b3995744c9`) y ya puestos en `wrangler.jsonc`.
2. **Google OAuth**: usar el cliente web propio «MyContent CloudTalk MCP» del proyecto Google Cloud «MyContent», separado del cliente de Sendy. Sus URI de redirección son `https://cloudtalk-mcp.mycontent.academy/callback` y `http://localhost:8790/callback` (para `wrangler dev`). Scopes: `openid email profile`.
3. **Secretos del Worker** (solo en Cloudflare; la CI no los sincroniza):
   ```bash
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY
   ```
4. **GitHub** → Settings → Environments → `production`: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, Workers KV Storage:Edit, Workers Routes:Edit, Zone:Read en `mycontent.academy`) y `CLOUDFLARE_ACCOUNT_ID`. Opcional para la integración: `CLOUDTALK_TEST_KEY_ID`, `CLOUDTALK_TEST_SECRET`.
5. Merge a `main` → la CI prueba, despliega y comprueba que `/mcp` sin token da 401 y que existen los metadatos OAuth.
6. claude.ai → Settings → Connectors → *Add custom connector* → `https://cloudtalk-mcp.mycontent.academy/mcp`. En Claude Code: `claude mcp add --transport http cloudtalk https://cloudtalk-mcp.mycontent.academy/mcp`.

## Desarrollo

```bash
npm ci
npm run type-check
npm test                       # 61 tests: catálogo, validación, cliente, barreras, planes, informes, OAuth, contrato MCP
node scripts/build-catalog.mjs # regenerar el catálogo desde spec/
node scripts/coverage-md.mjs   # regenerar API-COVERAGE.md
npx wrangler dev               # requiere .dev.vars (ver .dev.vars.example)
CLOUDTALK_TEST_KEY_ID=... CLOUDTALK_TEST_SECRET=... npm run integration   # cuenta real, solo lectura (~10 peticiones)
```

## Validado

- **Integración real:** `npm run integration` con una clave exclusiva «MyContent CloudTalk MCP - test»: 3/3 pruebas superadas. La clave no está en el repositorio.
- **Fechas de llamadas:** una llamada conocida del historial apareció con el filtro `date_from`/`date_to` centrado en su `started_at` UTC; las ventanas desplazadas −2 y +2 horas no la devolvieron. En esta cuenta, el filtro se interpreta en UTC.
- **Contactos:** `contacts_index` devuelve filas con `Contact`, `ContactNumber`, `ContactEmail` y `ContactAttribute`, sin etiquetas por fila (incluso filtrando por etiqueta). `contacts_show` devuelve `Contact`, `ExternalUrl`, `ContactNumber`, `ContactEmail`, `Tag` y `ContactAttribute`; `Tag` contiene objetos con `name`. `find_contacts.tags` es `null` cuando el listado no incluye etiquetas; `get_contact` permite consultarlas. `plan_update_contact` lee `Tag` para evitar duplicados y detectar eliminaciones.
- **Conversation Intelligence:** CloudTalk indica en esta cuenta que las llamadas de agentes humanos requieren CI y no se procesan. `/v1/ai/calls/{id}/summary` respondió HTTP 404 con código `NOT_FOUND` en una llamada reciente y en otra grabada.
- **Edición de contacto:** se creó un contacto temporal con teléfono y email ficticios (HTTP 201), se editó solo `title` (HTTP 200) y ambos campos siguieron presentes al releerlo. Se borró el contacto (HTTP 200) y su consulta posterior devolvió 404.
- **Claude:** el cliente OAuth propio completó `/setup`; el conector figura conectado y `check_connection` funcionó desde Claude. La etiqueta temporal `MCP_TEST` se creó por `plan_api_call` → `apply_plan` (HTTP 201) y se borró por otro plan `APPLY-ELEVATED` (HTTP 200). La lectura posterior de etiquetas confirmó que no existe.
