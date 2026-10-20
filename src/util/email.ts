/** Validación práctica de emails (no RFC completo): lo que aceptan en la práctica los proveedores de correo y los CRM. */
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeEmail(raw: string): string {
	return String(raw ?? "").trim().toLowerCase();
}

export function emailProblem(raw: string): string | undefined {
	const e = normalizeEmail(raw);
	if (!e) return "vacío";
	if (e.length > 254) return "demasiado largo";
	if (!EMAIL_RE.test(e)) return "formato inválido";
	const [local, domain] = e.split("@");
	if (local.length > 64) return "parte local demasiado larga";
	if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return "puntos mal colocados";
	if (!/\.[a-z]{2,}$/i.test(domain) && !/\.xn--[a-z0-9-]+$/i.test(domain)) return "dominio sin extensión válida";
	return undefined;
}

export interface EmailTriage<T> {
	valid: T[];
	invalid: { email: string; reason: string }[];
	duplicates: string[];
}

/** Separa válidos, inválidos y duplicados (por email normalizado; se queda el primero). */
export function triage<T>(items: T[], getEmail: (t: T) => string): EmailTriage<T> {
	const seen = new Set<string>();
	const out: EmailTriage<T> = { valid: [], invalid: [], duplicates: [] };
	for (const it of items) {
		const raw = getEmail(it);
		const problem = emailProblem(raw);
		if (problem) {
			out.invalid.push({ email: String(raw ?? "").slice(0, 120), reason: problem });
			continue;
		}
		const e = normalizeEmail(raw);
		if (seen.has(e)) {
			out.duplicates.push(e);
			continue;
		}
		seen.add(e);
		out.valid.push(it);
	}
	return out;
}

/** Enmascara un email para resúmenes: i***@d***.com */
export function maskEmail(email: string): string {
	const [l, d] = normalizeEmail(email).split("@");
	if (!d) return "***";
	const dot = d.lastIndexOf(".");
	return `${l.slice(0, 1)}***@${d.slice(0, 1)}***${dot > 0 ? d.slice(dot) : ""}`;
}
