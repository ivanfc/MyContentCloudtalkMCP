export function parseList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** ALLOWED_EMAILS="*" = abierto a cualquier cuenta de Google con email verificado. BLOCKED_EMAILS corta el acceso a alguien concreto. */
export function isEmailAllowed(email: string | undefined, allowed: string | undefined, blocked?: string): boolean {
	if (!email) return false;
	const e = email.toLowerCase();
	if (parseList(blocked).map((x) => x.toLowerCase()).includes(e)) return false;
	const list = parseList(allowed).map((x) => x.toLowerCase());
	return list.includes("*") || list.includes(e);
}

export function contactEmail(env: { CONTACT_EMAIL?: string }): string {
	return env.CONTACT_EMAIL || "privacidad@example.com";
}

/** Entero de una variable de entorno con valor por defecto. */
export function envInt(env: Record<string, unknown>, key: string, def: number): number {
	const raw = String(env[key] ?? "").trim();
	const v = Number(raw);
	return raw !== "" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : def;
}
