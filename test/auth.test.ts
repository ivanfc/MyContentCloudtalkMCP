import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthHandler, credentialProblem } from "../src/auth/handler";
import { bindStateToSession, createOAuthState } from "../src/auth/workers-oauth-utils";
import { FakeCloudTalk, MemoryKV } from "./helpers";

const ORIGIN = "https://cloudtalk-mcp.example.com";

function makeEnv(allowed = "*") {
	const completeAuthorization = vi.fn(async (_: unknown) => ({ redirectTo: "https://claude.ai/api/mcp/auth_callback?code=abc" }));
	const env = {
		OAUTH_KV: new MemoryKV(),
		STATE_KV: new MemoryKV(),
		OAUTH_PROVIDER: { completeAuthorization },
		GOOGLE_OAUTH_CLIENT_ID: "client",
		GOOGLE_OAUTH_CLIENT_SECRET: "secret",
		ALLOWED_EMAILS: allowed,
		BLOCKED_EMAILS: "malo@gmail.com",
		COOKIE_ENCRYPTION_KEY: "k",
		PUBLIC_BASE_URL: ORIGIN,
		CONTACT_EMAIL: "contacto@example.com",
	};
	return { env, completeAuthorization };
}

/** fetch global simulado: Google y CloudTalk. */
function stubNetwork(fake: FakeCloudTalk, user: { email: string; verified?: boolean }) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "g-token" });
			if (u.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) return Response.json({ sub: "g-123", email: user.email, email_verified: user.verified ?? true, name: "Ana" });
			return fake.fetch(u, init);
		}),
	);
}

async function login(env: any, email: string, verified = true, fake = new FakeCloudTalk()) {
	stubNetwork(fake, { email, verified });
	const oauthReqInfo = { clientId: "c1", redirectUri: "https://claude.ai/api/mcp/auth_callback", scope: [], state: "s", responseType: "code" };
	const { stateToken } = await createOAuthState(oauthReqInfo as any, env.OAUTH_KV);
	const { setCookie } = await bindStateToSession(stateToken);
	return AuthHandler.fetch(new Request(`${ORIGIN}/callback?code=x&state=${encodeURIComponent(stateToken)}`, { headers: { Cookie: setCookie.split(";")[0] } }), env);
}

function cookieValue(res: Response, name: string): string | undefined {
	for (const c of res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""]) {
		const m = c.match(new RegExp(`${name}=([^;]*)`));
		if (m?.[1]) return m[1];
	}
	return undefined;
}

async function startSetup(env: any, fake: FakeCloudTalk) {
	const res = await login(env, "ana@gmail.com", true, fake);
	expect(res.status).toBe(302);
	expect(res.headers.get("location")).toBe("/setup");
	const setup = cookieValue(res, "__Host-CLOUDTALK_SETUP")!;
	const page = await AuthHandler.fetch(new Request(`${ORIGIN}/setup`, { headers: { Cookie: `__Host-CLOUDTALK_SETUP=${setup}` } }), env);
	expect(page.status).toBe(200);
	const html = await page.text();
	const csrfCookie = cookieValue(page, "__Host-CSRF_TOKEN");
	const csrf = html.match(/name="csrf_token" value="([^"]+)"/)![1];
	return { setup, csrf, csrfCookie };
}

async function submit(env: any, s: Awaited<ReturnType<typeof startSetup>>, fields: Record<string, string>) {
	return AuthHandler.fetch(
		new Request(`${ORIGIN}/setup`, {
			method: "POST",
			body: new URLSearchParams({ csrf_token: s.csrf, ...fields }),
			headers: { Cookie: `__Host-CLOUDTALK_SETUP=${s.setup}; __Host-CSRF_TOKEN=${s.csrfCookie}`, "content-type": "application/x-www-form-urlencoded" },
		}),
		env,
	);
}

afterEach(() => vi.unstubAllGlobals());

describe("login con Google y registro de la clave de CloudTalk", () => {
	it("comprueba la clave contra CloudTalk antes de completar la autorización y la guarda en las props", async () => {
		const { env, completeAuthorization } = makeEnv();
		const fake = new FakeCloudTalk();
		const s = await startSetup(env, fake);
		const res = await submit(env, s, { key_id: fake.keyId, key_secret: fake.secret });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("claude.ai/api/mcp/auth_callback");
		expect(completeAuthorization).toHaveBeenCalledTimes(1);
		const props = (completeAuthorization.mock.calls[0][0] as { props: any }).props;
		expect(props).toMatchObject({ email: "ana@gmail.com", sub: "g-123", cloudtalk: { keyId: fake.keyId, secret: fake.secret, agentCount: 3 } });
		expect(fake.calls[0].url).toBe("https://my.cloudtalk.io/api/agents/index.json?limit=1");
		// La sesión de registro nunca contiene la clave.
		for (const v of env.OAUTH_KV.store.values()) expect(v.value).not.toContain(fake.secret);
	});

	it("una clave incorrecta no completa nada y permite reintentar", async () => {
		const { env, completeAuthorization } = makeEnv();
		const fake = new FakeCloudTalk();
		const s = await startSetup(env, fake);
		const res = await submit(env, s, { key_id: fake.keyId, key_secret: "incorrecta1" });
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("CloudTalk no acepta esa clave");
		expect(completeAuthorization).not.toHaveBeenCalled();
	});

	it("valida el formato de las credenciales", () => {
		expect(credentialProblem("ABC:DEF123", "secretoOK1")).toMatch(/Key ID/);
		expect(credentialProblem("ABCDEF123", "con espacio")).toMatch(/Secret/);
		expect(credentialProblem("ABCDEF123", "secretoOK1")).toBeUndefined();
	});

	it("deniega emails no verificados, bloqueados o fuera de la lista", async () => {
		expect((await login(makeEnv().env, "ana@gmail.com", false)).status).toBe(403);
		expect((await login(makeEnv().env, "malo@gmail.com")).status).toBe(403);
		expect((await login(makeEnv("ivan@mycontent.agency").env, "ana@gmail.com")).status).toBe(403);
		expect((await login(makeEnv("ivan@mycontent.agency").env, "ivan@mycontent.agency")).status).toBe(302);
	});

	it("sin sesión de registro, /setup caduca", async () => {
		const { env } = makeEnv();
		expect((await AuthHandler.fetch(new Request(`${ORIGIN}/setup`), env)).status).toBe(400);
	});

	it("páginas públicas con cabeceras de seguridad", async () => {
		const { env } = makeEnv();
		const home = await AuthHandler.fetch(new Request(`${ORIGIN}/`), env);
		expect(await home.text()).toContain(`${ORIGIN}/mcp`);
		expect(home.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(await (await AuthHandler.fetch(new Request(`${ORIGIN}/privacy`), env)).text()).toContain("disconnect_cloudtalk");
	});
});
