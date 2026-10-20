import { sanitizeText as esc } from "./auth/workers-oauth-utils";

export const SERVICE_NAME = "MyContent CloudTalk MCP";

const CSS = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#e7e5e4;--accent:#1d4ed8;--err:#b91c1c;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--accent:#60a5fa;--err:#f87171;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.6rem;margin:0 0 8px}h2{font-size:1.15rem;margin:28px 0 8px}
p,li{color:var(--fg)}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0}
label{display:block;font-weight:600;margin:14px 0 6px}input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{margin-top:18px;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:11px 18px;font:inherit;font-weight:600;cursor:pointer}
.err{border-color:var(--err);color:var(--err)}.ok{color:var(--ok)}code{font-family:ui-monospace,Menlo,monospace;font-size:.92em}a{color:var(--accent)}
footer{margin-top:40px;font-size:.9rem;color:var(--muted)}
`;

export function page(title: string, body: string, status = 200, headers: Record<string, string> = {}, head = ""): Response {
	const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="robots" content="index,follow">${head}<style>${CSS}</style></head><body><main>${body}<footer>${SERVICE_NAME} · <a href="/">Inicio</a> · <a href="/privacy">Privacidad</a></footer></main></body></html>`;
	return new Response(html, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			"cache-control": "no-store",
			...headers,
		},
	});
}

/** Finish the POST on our own origin before navigating to the OAuth callback. */
export function oauthCompletePage(redirectTo: string): Response {
	const target = esc(redirectTo);
	return page("CloudTalk conectado", `<h1>CloudTalk conectado</h1><p>Volviendo a tu asistente…</p><p><a href="${target}">Continuar al asistente</a></p>`, 200, {}, `<meta http-equiv="refresh" content="0;url=${target}">`);
}

export function homePage(base: string, contact: string): Response {
	return page(
		SERVICE_NAME,
		`<h1>${SERVICE_NAME}</h1>
<p>Conector MCP para gestionar <strong>tu propia cuenta de <a href="https://www.cloudtalk.io">CloudTalk</a></strong> desde Claude, Cowork, Codex u otro cliente MCP: historial e informes de llamadas, análisis de IA de cada llamada, contactos, agentes, grupos, números, SMS/WhatsApp, Dialer, VoiceAgent y webhooks. Todo cambio pasa por un plan que tú apruebas.</p>
<div class="card"><strong>URL del conector (MCP, Streamable HTTP):</strong><br><code>${esc(base)}/mcp</code></div>
<h2>Cómo empezar</h2>
<ol><li>Añade el conector en tu cliente con la URL de arriba.</li><li>Entra con tu cuenta de Google (email verificado).</li><li>Pega el <em>API Access Key ID</em> y el <em>Secret</em> de tu CloudTalk (Account → Settings → API Keys; solo los administradores pueden crearlas). Se comprueban al momento y se guardan cifrados.</li></ol>
<h2>Qué puede y qué no</h2>
<p>Usa solo la API oficial de CloudTalk (las 107 operaciones publicadas). Lo que la API no ofrece, como configurar call flows o comprar números, no se puede hacer desde aquí y el conector lo dice en lugar de simularlo.</p>
<h2>Seguridad</h2>
<ul><li>Cada cambio se prepara como plan con un resumen ANTES → DESPUÉS y solo se ejecuta con tu confirmación literal.</li><li>Borrados, cambios de enrutado de números, SMS, llamadas de VoiceAgent y webhooks exigen confirmación reforzada; los contactos salientes tienen tope diario.</li><li>Cada usuario solo opera con la cuenta de CloudTalk que registró.</li></ul>
<p class="muted">Servicio de MyContent. Contacto: <a href="mailto:${esc(contact)}">${esc(contact)}</a></p>`,
	);
}

export function privacyPage(contact: string): Response {
	return page(
		`Privacidad · ${SERVICE_NAME}`,
		`<h1>Política de privacidad</h1>
<p class="muted">Última actualización: 20 de octubre de 2026.</p>
<h2>Responsable</h2><p>MyContent. Contacto: <a href="mailto:${esc(contact)}">${esc(contact)}</a>.</p>
<h2>Qué datos guardamos</h2>
<ul>
<li><strong>Tu identidad de Google</strong>: email (verificado), nombre e identificador de cuenta. Sirve para saber quién eres y aislar tus datos de los de otros usuarios.</li>
<li><strong>ID y secreto de tu clave API de CloudTalk</strong>. Se guardan <strong>cifrados</strong> dentro de tu autorización OAuth (solo se descifran con tu sesión). Nunca se escriben en logs ni se devuelven en respuestas.</li>
<li><strong>Planes pendientes</strong> (máx. 24 h; los que contactan a terceros, 2 h), cifrados con una clave derivada de tu clave de CloudTalk. Pueden contener los datos del cambio que pediste (p. ej. un contacto o el texto de un SMS).</li>
<li><strong>Registro de auditoría</strong> (12 meses): qué operación aplicaste, cuándo, sobre qué ID y con qué resultado, y los nombres de los campos enviados. No guarda sus valores (teléfonos, textos…).</li>
<li><strong>Contadores de uso diario</strong> para aplicar los límites.</li>
<li><strong>Logs técnicos</strong>: herramienta usada, resultado y duración, con tu usuario seudonimizado. Sin argumentos, sin teléfonos ni claves.</li>
</ul>
<h2>Para qué</h2><p>Solo para ejecutar lo que pides contra tu cuenta de CloudTalk. No vendemos ni cedemos datos. Los datos de tus llamadas y contactos viven en CloudTalk; aquí solo pasan de forma transitoria.</p>
<h2>Dónde</h2><p>En Cloudflare (Workers, KV y Durable Objects).</p>
<h2>Cómo borrarlos</h2>
<ul><li>Desde el chat: herramienta <code>disconnect_cloudtalk</code>. Borra tu clave, tus planes pendientes y revoca todas tus autorizaciones del conector.</li>
<li>Por email a <a href="mailto:${esc(contact)}">${esc(contact)}</a> para borrar además tu auditoría.</li>
<li>Recomendado: revoca la clave en CloudTalk (Account → Settings → API Keys) si dejas de usar el conector.</li></ul>
<h2>Base jurídica</h2><p>Ejecución del servicio que solicitas. Si envías SMS o lanzas llamadas a terceros, tú eres responsable de tener base legal para contactarles.</p>`,
	);
}

export function setupPage(opts: { email: string; csrfToken: string; keyId?: string; error?: string; contact: string }, setCookie: string[]): Response {
	const body = `<h1>Conecta tu CloudTalk</h1>
<p>Has entrado como <strong>${esc(opts.email)}</strong>. Último paso: la clave API de tu cuenta de CloudTalk.</p>
${opts.error ? `<div class="card err" role="alert">${esc(opts.error)}</div>` : ""}
<form method="post" action="/setup" class="card" autocomplete="off">
<input type="hidden" name="csrf_token" value="${esc(opts.csrfToken)}">
<label for="kid">API Access Key ID</label>
<input id="kid" name="key_id" type="text" required minlength="6" maxlength="200" placeholder="p. ej. ABCDEFGHIJ1234" value="${esc(opts.keyId ?? "")}">
<label for="ksecret">API Access Key Secret</label>
<input id="ksecret" name="key_secret" type="password" required minlength="6" maxlength="300" placeholder="Solo se muestra al crear la clave">
<p class="muted">En CloudTalk: Account → Settings → API Keys (solo administradores). Si perdiste el secreto, revoca la clave y crea otra. Recomendado: una clave propia para este conector, para poder revocarla sin afectar a otras integraciones.</p>
<button type="submit">Comprobar y conectar</button>
</form>
<h2>Qué hacemos con esto</h2>
<ul>
<li>Comprobamos la clave con una llamada de prueba (listar un agente) antes de guardar nada.</li>
<li>Se guarda <strong>cifrada</strong> dentro de tu autorización OAuth; nunca en logs ni en respuestas del chat.</li>
<li>Solo se usa para las acciones que pidas, y cada cambio exige tu confirmación.</li>
<li>Para borrarla: herramienta <code>disconnect_cloudtalk</code> en el chat (o escribe a ${esc(opts.contact)}). <a href="/privacy">Política de privacidad</a>.</li>
</ul>`;
	const h = new Headers();
	for (const c of setCookie) h.append("set-cookie", c);
	const res = page("Conecta tu CloudTalk", body, opts.error ? 400 : 200);
	h.forEach((v, k) => res.headers.append(k, v));
	return res;
}

export function messagePage(title: string, message: string, status: number): Response {
	return page(title, `<h1>${esc(title)}</h1><div class="card"><p>${esc(message)}</p></div>`, status);
}
