/**
 * Errores de CloudTalk normalizados: código, categoría y mensaje en español que cita el original.
 * Categorías:
 * - credential: clave API incorrecta o revocada (401).
 * - permission: la clave o la cuenta no puede hacerlo (403: función no contratada, agente no online, límite de agentes…).
 * - not_found: no existe en la cuenta (404).
 * - input: CloudTalk rechazó los datos (400, 406, 409, 422).
 * - rate_limit: 60 peticiones/min por empresa (429).
 * - service: CloudTalk no responde o da 5xx / respuesta inesperada.
 * - unsupported: el conector no puede ejecutar esa operación.
 */
export type ErrorCategory = "credential" | "permission" | "not_found" | "input" | "rate_limit" | "service" | "unsupported" | "quota" | "guard" | "unknown";

export class CloudTalkError extends Error {
	override name = "CloudTalkError";
	constructor(
		readonly code: string,
		readonly category: ErrorCategory,
		message: string,
		readonly httpStatus?: number,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
	}
	toInfo(): ErrorInfo {
		return { code: this.code, category: this.category, message: this.message, ...(this.httpStatus ? { http_status: this.httpStatus } : {}), ...(this.details ? { details: this.details } : {}) };
	}
}

export interface ErrorInfo {
	code: string;
	category: ErrorCategory;
	message: string;
	http_status?: number;
	details?: Record<string, unknown>;
}

const clip = (s: unknown, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Extrae el mensaje de cualquiera de los sobres de error de CloudTalk (core, v1/Dialer, analytics). */
export function cloudTalkMessage(body: unknown): { message?: string; details?: Record<string, unknown> } {
	if (!body || typeof body !== "object") return typeof body === "string" && body.trim() ? { message: clip(body) } : {};
	const b = body as Record<string, any>;
	const rd = b.responseData;
	if (rd && typeof rd === "object") {
		const msg = rd.message ?? rd.error ?? (typeof rd.data === "string" ? rd.data : undefined);
		return { message: msg ? clip(msg) : undefined, ...(rd.data && typeof rd.data === "object" ? { details: { data: rd.data } } : {}) };
	}
	const msg = b.message ?? b.error ?? b.detail ?? b.title;
	const details: Record<string, unknown> = {};
	if (Array.isArray(b.subErrors) && b.subErrors.length) details.sub_errors = b.subErrors.slice(0, 20).map((x: unknown) => clip(typeof x === "string" ? x : JSON.stringify(x), 200));
	if (Array.isArray(b.errors) && b.errors.length) details.errors = b.errors.slice(0, 20).map((x: unknown) => clip(typeof x === "string" ? x : JSON.stringify(x), 200));
	if (b.correlationId) details.correlation_id = String(b.correlationId).slice(0, 80);
	return { message: msg ? clip(Array.isArray(msg) ? msg.join("; ") : msg) : undefined, ...(Object.keys(details).length ? { details } : {}) };
}

export function errorFromStatus(status: number, body: unknown, retryAfterSeconds?: number): CloudTalkError {
	const { message, details } = cloudTalkMessage(body);
	const quote = message ? ` CloudTalk: "${message}".` : "";
	if (status === 401) return new CloudTalkError("UNAUTHORIZED", "credential", `La clave API de CloudTalk no es válida o se ha revocado.${quote} Vuelve a conectar el conector con una clave activa.`, status, details);
	if (status === 403) return new CloudTalkError("FORBIDDEN", "permission", `CloudTalk no lo permite con esta cuenta o clave (permiso, función no contratada o estado del agente/número).${quote}`, status, details);
	if (status === 404) return new CloudTalkError("NOT_FOUND", "not_found", `No existe en tu cuenta de CloudTalk (o la función no está disponible en tu plan).${quote}`, status, details);
	if (status === 429)
		return new CloudTalkError(
			"RATE_LIMITED",
			"rate_limit",
			`CloudTalk limita a 60 peticiones por minuto por empresa (compartidas con tus otras integraciones).${retryAfterSeconds !== undefined ? ` Reintenta en ~${retryAfterSeconds} s.` : " Reintenta en un minuto."}${quote}`,
			status,
			details,
		);
	if ([400, 406, 409, 412, 415, 422].includes(status)) return new CloudTalkError(`INVALID_${status}`, "input", `CloudTalk rechazó los datos (HTTP ${status}).${quote}`, status, details);
	if (status >= 500) return new CloudTalkError(`SERVER_${status}`, "service", `CloudTalk respondió con un error interno (HTTP ${status}).${quote}`, status, details);
	return new CloudTalkError(`HTTP_${status}`, "unknown", `Respuesta inesperada de CloudTalk (HTTP ${status}).${quote}`, status, details);
}

export function errorInfo(e: unknown): ErrorInfo {
	if (e instanceof CloudTalkError) return e.toInfo();
	const err = e as { name?: string; message?: string };
	if (err?.name === "TimeoutError" || err?.name === "AbortError") return { code: "TIMEOUT", category: "service", message: "CloudTalk no respondió a tiempo." };
	if (err?.name === "TypeError") return { code: "NETWORK", category: "service", message: "No se pudo conectar con CloudTalk." };
	return { code: "ERROR", category: "unknown", message: clip(err?.message ?? e, 300) };
}
