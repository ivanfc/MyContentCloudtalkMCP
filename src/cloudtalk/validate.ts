import type { Operation, Param, Schema } from "./catalog";

/**
 * Validación de una llamada contra el esquema oficial del catálogo, antes de guardar el plan o de leer.
 * Objetivo: que nunca se envíen campos o parámetros inventados. Los campos no documentados se rechazan
 * salvo allowUndocumented (entonces pasan a avisos), porque el OpenAPI puede ir por detrás de la API real.
 */
export interface ValidationResult {
	errors: string[];
	warnings: string[];
	query: Record<string, unknown>;
	path: Record<string, string>;
}

const MAX_ERRORS = 30;

function typeOk(s: Schema, v: unknown): boolean {
	const types = (s.type ?? "").split("|").filter(Boolean);
	if (!types.length || types.includes("oneOf")) return true;
	return types.some((t) => {
		if (t === "string") return typeof v === "string";
		if (t === "integer") return typeof v === "number" && Number.isInteger(v);
		if (t === "number") return typeof v === "number" && Number.isFinite(v);
		if (t === "boolean") return typeof v === "boolean";
		if (t === "array") return Array.isArray(v);
		if (t === "object") return !!v && typeof v === "object" && !Array.isArray(v);
		if (t === "null") return v === null;
		return true;
	});
}

export function validateValue(s: Schema | undefined, v: unknown, at: string, out: { errors: string[]; warnings: string[] }, allowUndocumented: boolean, depth = 0) {
	if (!s || out.errors.length >= MAX_ERRORS || depth > 8) return;
	if (v === null) return; // La API admite null para "sin valor" en muchos campos (p. ej. outbound_number_id).
	if (!typeOk(s, v)) {
		out.errors.push(`${at}: se esperaba ${s.type}, llegó ${Array.isArray(v) ? "array" : typeof v}`);
		return;
	}
	if (s.enum && !s.enum.includes(v as never)) out.errors.push(`${at}: valor "${String(v).slice(0, 60)}" no permitido. Valores válidos: ${s.enum.map(String).join(", ")}`);
	if (typeof v === "string" && s.maxLength !== undefined && v.length > s.maxLength) out.errors.push(`${at}: máximo ${s.maxLength} caracteres (tiene ${v.length})`);
	if (typeof v === "number") {
		if (s.minimum !== undefined && v < s.minimum) out.errors.push(`${at}: mínimo ${s.minimum}`);
		if (s.maximum !== undefined && v > s.maximum) out.errors.push(`${at}: máximo ${s.maximum}`);
	}
	if (Array.isArray(v)) {
		if (s.maxItems !== undefined && v.length > s.maxItems) out.errors.push(`${at}: máximo ${s.maxItems} elementos (tiene ${v.length})`);
		v.forEach((x, i) => validateValue(s.items, x, `${at}[${i}]`, out, allowUndocumented, depth + 1));
		return;
	}
	if (v && typeof v === "object") {
		const obj = v as Record<string, unknown>;
		if (s.oneOf?.length && !s.properties) {
			// Unión: se aceptan las claves de cualquier variante.
			const known = new Set(s.oneOf.flatMap((x) => Object.keys(x.properties ?? {})));
			const merged: Schema = { type: "object", properties: Object.assign({}, ...s.oneOf.map((x) => x.properties ?? {})) };
			for (const k of Object.keys(obj)) if (!known.has(k)) (allowUndocumented ? out.warnings : out.errors).push(`${at}.${k}: campo no documentado en la API`);
			for (const k of Object.keys(obj)) if (known.has(k)) validateValue(merged.properties?.[k], obj[k], `${at}.${k}`, out, allowUndocumented, depth + 1);
			return;
		}
		if (s.properties) {
			for (const r of s.required ?? []) if (obj[r] === undefined) out.errors.push(`${at}.${r}: obligatorio`);
			for (const [k, x] of Object.entries(obj)) {
				const ps = s.properties[k];
				if (!ps) {
					if (s.additionalProperties) continue;
					(allowUndocumented ? out.warnings : out.errors).push(`${at}.${k}: campo no documentado en la API (válidos: ${Object.keys(s.properties).join(", ").slice(0, 400)})`);
					continue;
				}
				validateValue(ps, x, `${at}.${k}`, out, allowUndocumented, depth + 1);
			}
		}
	}
}

function coerceQuery(p: Param, raw: unknown): { value?: unknown; error?: string } {
	if (raw === undefined || raw === null || raw === "") return {};
	const t = p.type ?? "string";
	if (t === "integer" || t === "number") {
		const n = typeof raw === "number" ? raw : Number(String(raw).trim());
		if (!Number.isFinite(n) || (t === "integer" && !Number.isInteger(n))) return { error: `${p.name}: se esperaba ${t === "integer" ? "un entero" : "un número"}` };
		if (p.minimum !== undefined && n < p.minimum) return { error: `${p.name}: mínimo ${p.minimum}` };
		if (p.maximum !== undefined && n > p.maximum) return { error: `${p.name}: máximo ${p.maximum}` };
		return { value: n };
	}
	if (t === "boolean") {
		if (raw === true || raw === "true") return { value: "true" };
		if (raw === false || raw === "false") return { value: "false" };
		return { error: `${p.name}: se esperaba true o false` };
	}
	const s = Array.isArray(raw) ? raw.map(String) : String(raw);
	if (p.enum && !(Array.isArray(s) ? s : [s]).every((x) => p.enum!.includes(x))) return { error: `${p.name}: valores válidos ${p.enum.join(", ")}` };
	return { value: s };
}

export function validateCall(op: Operation, input: { path_params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown }, allowUndocumented = false): ValidationResult {
	const out: ValidationResult = { errors: [], warnings: [], query: {}, path: {} };
	for (const p of op.path_params) {
		const v = input.path_params?.[p.name];
		if (v === undefined || v === null || String(v).trim() === "") out.errors.push(`path_params.${p.name}: obligatorio`);
		else if (!/^[A-Za-z0-9_.:@+=-]{1,128}$/.test(String(v).trim()) || [".", ".."].includes(String(v).trim())) out.errors.push(`path_params.${p.name}: formato no válido`);
		else out.path[p.name] = String(v).trim();
	}
	for (const k of Object.keys(input.path_params ?? {})) if (!op.path_params.some((p) => p.name === k)) out.errors.push(`path_params.${k}: esta operación no tiene ese parámetro de ruta${op.path_params.length ? ` (tiene: ${op.path_params.map((p) => p.name).join(", ")})` : ""}`);
	for (const [k, raw] of Object.entries(input.query ?? {})) {
		const p = op.query_params.find((x) => x.name === k);
		if (!p) {
			out.errors.push(`query.${k}: parámetro no documentado${op.query_params.length ? ` (válidos: ${op.query_params.map((x) => x.name).join(", ")})` : " (esta operación no admite parámetros de consulta)"}`);
			continue;
		}
		const c = coerceQuery(p, raw);
		if (c.error) out.errors.push(`query.${c.error}`);
		else if (c.value !== undefined) out.query[k] = c.value;
	}
	for (const p of op.query_params) if (p.required && out.query[p.name] === undefined) out.errors.push(`query.${p.name}: obligatorio`);
	if (op.body) {
		if (input.body === undefined || input.body === null) {
			if (op.body.required_body || op.body.required?.length) out.errors.push(`body: obligatorio para ${op.id}${op.body.required?.length ? ` (campos obligatorios: ${op.body.required.join(", ")})` : ""}`);
		} else validateValue(op.body, input.body, "body", out, allowUndocumented);
	} else if (input.body !== undefined && input.body !== null && !(typeof input.body === "object" && !Array.isArray(input.body) && !Object.keys(input.body as object).length)) {
		out.errors.push(`body: ${op.id} no admite body`);
	}
	return out;
}
