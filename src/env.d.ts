// Secretos del Worker (wrangler secret put). No aparecen en wrangler.jsonc, así que se declaran aquí.
interface __Secrets {
	GOOGLE_OAUTH_CLIENT_ID: string;
	GOOGLE_OAUTH_CLIENT_SECRET: string;
	/** Cifra la cookie de clientes aprobados y es la clave HMAC de los seudónimos de usuario. */
	COOKIE_ENCRYPTION_KEY: string;
}
interface Env extends __Secrets {}
declare namespace Cloudflare {
	interface Env extends __Secrets {}
}
