import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { CloudTalkClient } from "../cloudtalk/client";
import { errorInfo } from "../cloudtalk/errors";
import { contactEmail, isEmailAllowed } from "../config";
import { SERVICE_NAME, homePage, messagePage, oauthCompletePage, privacyPage, setupPage } from "../pages";
import {
	OAuthError,
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

/** Cuenta de CloudTalk registrada por el usuario. Va dentro de las props del grant, que el proveedor OAuth guarda cifradas. */
export interface CloudTalkRegistration {
	/** API Access Key ID (usuario de Basic Auth). */
	keyId: string;
	/** API Access Key Secret (contraseña de Basic Auth). */
	secret: string;
	registeredAt: string;
	/** Agentes que veía la clave al registrarla (solo informativo). */
	agentCount?: number;
}

/** Datos del usuario autenticado, cifrados dentro del grant/token y expuestos como props en el MCP. */
export type Props = {
	email: string;
	name: string;
	/** Identificador de Google (userId del grant): sirve para revocar sus grants en disconnect_cloudtalk. */
	sub: string;
	cloudtalk: CloudTalkRegistration;
};

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: Bindings }>();

const SETUP_COOKIE = "__Host-CLOUDTALK_SETUP";
const SETUP_TTL = 30 * 60;
const MAX_SETUP_ATTEMPTS = 8;

interface SetupSession {
	oauthReqInfo: AuthRequest;
	email: string;
	name: string;
	sub: string;
	attempts: number;
}

function baseUrl(c: { env: Bindings; req: { url: string } }) {
	return (c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(/\/$/, "");
}

app.get("/", (c) => homePage(baseUrl(c), contactEmail(c.env)));
app.get("/privacy", (c) => privacyPage(contactEmail(c.env)));
app.get("/robots.txt", () => new Response("User-agent: *\nAllow: /$\nAllow: /privacy\nDisallow: /\n", { headers: { "content-type": "text/plain" } }));

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) return c.text("Invalid request", 400);

	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie } = await bindStateToSession(stateToken);
		return redirectToGoogle(c.req.raw, c.env, stateToken, { "Set-Cookie": setCookie });
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();
	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description: "Conector MCP para gestionar tu propia cuenta de CloudTalk (llamadas, contactos, agentes, números, SMS, Dialer, VoiceAgent y webhooks) con planes que apruebas antes de aplicar.",
			name: SERVICE_NAME,
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();
		validateCSRFToken(formData, c.req.raw);
		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") return c.text("Missing state in form data", 400);
		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch {
			return c.text("Invalid state data", 400);
		}
		if (!state.oauthReqInfo?.clientId) return c.text("Invalid request", 400);

		const approvedClientCookie = await addApprovedClient(c.req.raw, state.oauthReqInfo.clientId, c.env.COOKIE_ENCRYPTION_KEY);
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);
		return redirectToGoogle(c.req.raw, c.env, stateToken, headers);
	} catch (error: any) {
		if (error instanceof OAuthError) return error.toResponse();
		console.error(JSON.stringify({ evt: "authorize_error", message: String(error?.message).slice(0, 120) }));
		return c.text("Internal server error", 500);
	}
});

function redirectToGoogle(request: Request, env: Env, stateToken: string, headers: HeadersInit = {}) {
	const upstream = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	upstream.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID);
	upstream.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
	// Solo identidad: no se pide ningún permiso sobre la cuenta de Google.
	upstream.searchParams.set("scope", "openid email profile");
	upstream.searchParams.set("response_type", "code");
	upstream.searchParams.set("prompt", "select_account");
	upstream.searchParams.set("state", stateToken);
	const responseHeaders = new Headers(headers);
	responseHeaders.set("location", upstream.href);
	return new Response(null, { status: 302, headers: responseHeaders });
}

app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;
	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) return error.toResponse();
		return c.text("Internal server error", 500);
	}
	if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request data", 400);
	const code = c.req.query("code");
	if (!code) return messagePage("Login cancelado", "No se recibió autorización de Google. Vuelve a conectar el conector desde tu cliente.", 400);

	const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: c.env.GOOGLE_OAUTH_CLIENT_ID,
			client_secret: c.env.GOOGLE_OAUTH_CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: new URL("/callback", c.req.url).href,
		}).toString(),
		signal: AbortSignal.timeout(10_000),
	});
	if (!tokenRes.ok) return messagePage("Error de login", "No se pudo completar el login con Google.", 502);
	const { access_token } = (await tokenRes.json()) as { access_token?: string };
	if (!access_token) return messagePage("Error de login", "Google no devolvió un token.", 502);
	const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) });
	if (!userRes.ok) return messagePage("Error de login", "No se pudo leer tu perfil de Google.", 502);
	const user = (await userRes.json()) as { sub: string; email?: string; email_verified?: boolean; name?: string };

	if (!user.sub || !user.email || !user.email_verified) return messagePage("Acceso denegado", "Tu cuenta de Google no tiene un email verificado.", 403);
	if (!isEmailAllowed(user.email, c.env.ALLOWED_EMAILS, c.env.BLOCKED_EMAILS)) return messagePage("Acceso denegado", `${user.email} no tiene acceso a este conector.`, 403);

	// Login correcto: la autorización NO se completa hasta registrar y comprobar la clave de CloudTalk (/setup).
	const token = crypto.randomUUID();
	const session: SetupSession = { oauthReqInfo, email: user.email.toLowerCase(), name: user.name ?? user.email, sub: user.sub, attempts: 0 };
	await c.env.OAUTH_KV.put(`setup:${token}`, JSON.stringify(session), { expirationTtl: SETUP_TTL });
	const headers = new Headers({ Location: "/setup" });
	if (clearSessionCookie) headers.append("Set-Cookie", clearSessionCookie);
	headers.append("Set-Cookie", `${SETUP_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SETUP_TTL}`);
	return new Response(null, { status: 302, headers });
});

function setupToken(req: Request): string | undefined {
	const cookies = (req.headers.get("Cookie") ?? "").split(";").map((s) => s.trim());
	const c = cookies.find((x) => x.startsWith(`${SETUP_COOKIE}=`));
	const v = c?.slice(SETUP_COOKIE.length + 1);
	return v && /^[0-9a-f-]{36}$/.test(v) ? v : undefined;
}

async function loadSession(env: Bindings, req: Request): Promise<{ token: string; session: SetupSession } | undefined> {
	const token = setupToken(req);
	if (!token) return undefined;
	const raw = await env.OAUTH_KV.get(`setup:${token}`);
	return raw ? { token, session: JSON.parse(raw) as SetupSession } : undefined;
}

const expired = () => messagePage("Sesión caducada", "La sesión de registro ha caducado o no existe. Vuelve a conectar el conector desde tu cliente (Claude, Cowork, Codex…).", 400);

app.get("/setup", async (c) => {
	const s = await loadSession(c.env, c.req.raw);
	if (!s) return expired();
	const { token, setCookie } = generateCSRFProtection();
	return setupPage({ email: s.session.email, csrfToken: token, contact: contactEmail(c.env) }, [setCookie]);
});

/** Formato de las credenciales: ASCII imprimible sin espacios; el ID no puede llevar ":" (separador de Basic Auth). */
export function credentialProblem(keyId: string, secret: string): string | undefined {
	if (!/^[\x21-\x7e]{6,200}$/.test(keyId) || keyId.includes(":")) return "El API Access Key ID no tiene un formato válido (cópialo de Account → Settings → API Keys, sin espacios).";
	if (!/^[\x21-\x7e]{6,300}$/.test(secret)) return "El API Access Key Secret no tiene un formato válido (cópialo sin espacios; CloudTalk solo lo muestra al crear la clave).";
	return undefined;
}

app.post("/setup", async (c) => {
	const form = await c.req.raw.formData();
	let clearCsrf: string;
	try {
		clearCsrf = validateCSRFToken(form, c.req.raw).clearCookie;
	} catch (e) {
		if (e instanceof OAuthError) return messagePage("Formulario caducado", "Recarga la página de registro e inténtalo de nuevo.", 400);
		throw e;
	}
	const s = await loadSession(c.env, c.req.raw);
	if (!s) return expired();
	const { token, session } = s;

	const keyId = String(form.get("key_id") ?? "").trim();
	const secret = String(form.get("key_secret") ?? "").trim();
	const retry = async (error: string) => {
		session.attempts++;
		await c.env.OAUTH_KV.put(`setup:${token}`, JSON.stringify(session), { expirationTtl: SETUP_TTL });
		const csrf = generateCSRFProtection();
		return setupPage({ email: session.email, csrfToken: csrf.token, keyId: keyId.slice(0, 200), error, contact: contactEmail(c.env) }, [csrf.setCookie]);
	};
	if (session.attempts >= MAX_SETUP_ATTEMPTS) {
		await c.env.OAUTH_KV.delete(`setup:${token}`);
		return messagePage("Demasiados intentos", "Has superado el número de intentos. Vuelve a conectar el conector desde tu cliente.", 429);
	}
	const problem = credentialProblem(keyId, secret);
	if (problem) return retry(problem);

	// Llamada de prueba: listar 1 agente. Confirma que la clave es válida y devuelve cuántos agentes ve.
	let agentCount: number | undefined;
	try {
		const r = await new CloudTalkClient({ keyId, secret }).call("agents_index", { query: { limit: 1 } });
		const n = Number((r.data as { itemsCount?: unknown })?.itemsCount);
		agentCount = Number.isFinite(n) ? n : undefined;
	} catch (e) {
		const info = errorInfo(e);
		console.log(JSON.stringify({ evt: "setup_rejected", code: info.code }));
		return retry(info.category === "credential" ? "CloudTalk no acepta esa clave (ID o secreto incorrectos, o clave revocada)." : `La comprobación ha fallado: ${info.message}`);
	}

	const props: Props = {
		email: session.email,
		name: session.name,
		sub: session.sub,
		cloudtalk: { keyId, secret, registeredAt: new Date().toISOString(), ...(agentCount !== undefined ? { agentCount } : {}) },
	};
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: session.email },
		props,
		request: session.oauthReqInfo,
		scope: session.oauthReqInfo.scope,
		userId: session.sub,
	});
	await c.env.OAUTH_KV.delete(`setup:${token}`);
	console.log(JSON.stringify({ evt: "setup_ok", agents: agentCount ?? null }));
	// A cross-origin 302 after a form POST is blocked by form-action 'self' in Chromium.
	const response = oauthCompletePage(redirectTo);
	response.headers.append("Set-Cookie", clearCsrf);
	response.headers.append("Set-Cookie", `${SETUP_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`);
	return response;
});

export { app as AuthHandler };
