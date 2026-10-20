import { ALLOWED_HOSTS, type Operation, getOperation } from "./catalog";
import { CloudTalkError, errorFromStatus } from "./errors";
import { MAX_FILE_BYTES, parseUploadFile } from "./binary";
import { b64 } from "../util/crypto";

export const CLOUDTALK_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Espera máxima ante un 429 en una lectura antes de reintentar una vez. */
const MAX_RATE_WAIT_MS = 5_000;
export const USER_AGENT = "MyContent-CloudTalk-MCP/0.1.0 (+https://cloudtalk-mcp.mycontent.academy)";

export interface CloudTalkCredentials {
	keyId: string;
	secret: string;
}

export interface ClientOptions {
	fetch?: typeof fetch;
	/** Cuota: se llama antes de cada petición HTTP a CloudTalk. Lanza si no hay cuota. */
	beforeRequest?: () => Promise<void>;
	timeoutMs?: number;
	/** Espera entre reintentos (solo lecturas). */
	retryDelayMs?: number;
	now?: () => number;
}

export interface CallInput {
	path?: Record<string, string | number>;
	query?: Record<string, unknown>;
	body?: unknown;
}

export interface RateInfo {
	limit?: number;
	remaining?: number;
	reset_at_utc?: string;
}

export interface CallResult {
	status: number;
	/** Cuerpo sin el sobre `responseData` de la API core (las demás APIs no lo usan). */
	data: unknown;
	rate?: RateInfo;
}

export interface AudioData {
	kind: "audio";
	data: string;
	mimeType: "audio/wav";
	bytes: number;
}

export function isAudioData(data: unknown): data is AudioData {
	return !!data && typeof data === "object" && (data as AudioData).kind === "audio";
}

/** Valor de parámetro de ruta seguro: sin barras, puntos relativos ni espacios. */
const SAFE_SEGMENT = /^[A-Za-z0-9_.:@+=-]{1,128}$/;

export function buildUrl(op: Operation, input: CallInput = {}): string {
	let path = op.path;
	for (const p of op.path_params) {
		const v = input.path?.[p.name];
		if (v === undefined || v === null || String(v).trim() === "") throw new CloudTalkError("MISSING_PATH_PARAM", "input", `Falta el parámetro de ruta "${p.name}" para ${op.id}.`);
		const s = String(v).trim();
		if (!SAFE_SEGMENT.test(s) || s === "." || s === "..") throw new CloudTalkError("BAD_PATH_PARAM", "input", `El parámetro de ruta "${p.name}" no es válido.`);
		path = path.replace(`{${p.name}}`, encodeURIComponent(s));
	}
	if (/\{[^}]+\}/.test(path)) throw new CloudTalkError("MISSING_PATH_PARAM", "input", `Faltan parámetros de ruta en ${op.path}.`);
	const url = new URL(op.host.replace(/\/$/, "") + path);
	if (!ALLOWED_HOSTS.has(url.hostname) || url.protocol !== "https:") throw new CloudTalkError("BAD_HOST", "unsupported", "Host no permitido.");
	for (const [k, v] of Object.entries(input.query ?? {})) {
		if (v === undefined || v === null || v === "") continue;
		if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
		else url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
	}
	return url.toString();
}

function basicAuth(c: CloudTalkCredentials): string {
	const bytes = new TextEncoder().encode(`${c.keyId}:${c.secret}`);
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return `Basic ${btoa(s)}`;
}

async function readLimited(res: Response): Promise<string> {
	const len = Number(res.headers.get("content-length") ?? "0");
	if (len > MAX_BODY_BYTES) throw new CloudTalkError("TOO_LARGE", "service", "La respuesta de CloudTalk es demasiado grande (>5 MB). Pide menos elementos (limit) o filtra más.");
	const text = await res.text();
	if (text.length > MAX_BODY_BYTES) throw new CloudTalkError("TOO_LARGE", "service", "La respuesta de CloudTalk es demasiado grande (>5 MB). Pide menos elementos (limit) o filtra más.");
	return text;
}

async function readLimitedAudio(res: Response): Promise<Uint8Array> {
	const len = Number(res.headers.get("content-length") ?? "0");
	if (len > MAX_FILE_BYTES) throw new CloudTalkError("TOO_LARGE", "service", "La grabación supera el límite de 5 MB del conector.");
	if (!res.body) throw new CloudTalkError("BAD_AUDIO", "service", "CloudTalk devolvió una grabación vacía.");
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_FILE_BYTES) throw new CloudTalkError("TOO_LARGE", "service", "La grabación supera el límite de 5 MB del conector.");
			chunks.push(value);
		}
	} catch (e) {
		await reader.cancel().catch(() => undefined);
		throw e;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function rateInfo(h: Headers): RateInfo | undefined {
	const limit = h.get("x-cloudtalkapi-limit");
	const remaining = h.get("x-cloudtalkapi-remaining");
	const reset = h.get("x-cloudtalkapi-resettime");
	if (limit === null && remaining === null && reset === null) return undefined;
	const r: RateInfo = {};
	if (limit !== null && Number.isFinite(Number(limit))) r.limit = Number(limit);
	if (remaining !== null && Number.isFinite(Number(remaining))) r.remaining = Number(remaining);
	if (reset !== null && Number.isFinite(Number(reset))) r.reset_at_utc = new Date(Number(reset) * 1000).toISOString();
	return r;
}

/** Quita el sobre de la API core ({responseData: …}). */
function unwrap(body: unknown): unknown {
	if (body && typeof body === "object" && !Array.isArray(body) && "responseData" in (body as object)) return (body as { responseData: unknown }).responseData;
	return body;
}

/**
 * Cliente de la API de CloudTalk (Basic Auth: ID de clave + secreto).
 * - Solo hosts del catálogo oficial, sin redirecciones, timeout 15 s, respuesta máx. 5 MB.
 * - Reintento único solo en lecturas: red, timeout, 5xx o 429 con espera ≤ 5 s.
 * - Errores con HTTP 2xx: la API core puede devolver {responseData:{status:4xx}} y el envío de SMS {success:false}.
 */
export class CloudTalkClient {
	private readonly f: typeof fetch;
	lastRate?: RateInfo;

	constructor(
		private readonly creds: CloudTalkCredentials,
		private readonly opts: ClientOptions = {},
	) {
		this.f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
	}

	/** Llama a una operación del catálogo por su id. */
	async call(opOrId: Operation | string, input: CallInput = {}): Promise<CallResult> {
		const op = typeof opOrId === "string" ? getOperation(opOrId) : opOrId;
		if (!op) throw new CloudTalkError("UNKNOWN_OPERATION", "unsupported", `Operación desconocida: ${String(opOrId).slice(0, 80)}.`);
		const url = buildUrl(op, input);
		const isRead = op.method === "GET";
		const attempt = async (): Promise<CallResult> => {
			await this.opts.beforeRequest?.();
			const audio = op.id === "calls_recording";
			const headers: Record<string, string> = { Authorization: basicAuth(this.creds), Accept: audio ? "audio/x-wav" : "application/json", "User-Agent": USER_AGENT };
			let body: string | FormData | undefined;
			if (input.body !== undefined) {
				if (op.id === "upload_knowledge_base_file") {
					const file = parseUploadFile(input.body);
					const form = new FormData();
					form.append("file", new Blob([new Uint8Array(file.bytes).buffer], { type: file.mimeType }), file.filename);
					body = form;
				} else {
					headers["Content-Type"] = "application/json";
					body = JSON.stringify(input.body);
				}
			}
			const res = await this.f(url, { method: op.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(this.opts.timeoutMs ?? CLOUDTALK_TIMEOUT_MS) });
			const rate = rateInfo(res.headers);
			if (rate) this.lastRate = rate;
			if (res.status >= 300 && res.status < 400) throw new CloudTalkError("REDIRECT", "service", `CloudTalk respondió con una redirección (HTTP ${res.status}); no se sigue por seguridad.`, res.status);
			const ctype = res.headers.get("content-type") ?? "";
			if (audio && res.ok && /audio\/(?:x-)?wav|application\/octet-stream/i.test(ctype)) {
				const bytes = await readLimitedAudio(res);
				if (bytes.length < 12 || !["RIFF", "RF64"].includes(String.fromCharCode(...bytes.subarray(0, 4))) || String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE")
					throw new CloudTalkError("BAD_AUDIO", "service", "CloudTalk no devolvió un fichero WAV válido.");
				return { status: res.status, data: { kind: "audio", data: b64(bytes), mimeType: "audio/wav", bytes: bytes.length } satisfies AudioData, ...(rate ? { rate } : {}) };
			}
			const text = await readLimited(res);
			let parsed: unknown = text;
			if (text && (ctype.includes("json") || /^[\s]*[[{]/.test(text))) {
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = text;
				}
			}
			if (res.status === 429) {
				const now = this.opts.now?.() ?? Date.now();
				const waitS = rate?.reset_at_utc ? Math.max(0, Math.ceil((Date.parse(rate.reset_at_utc) - now) / 1000)) : undefined;
				throw errorFromStatus(429, parsed, waitS);
			}
			if (res.status >= 400) throw errorFromStatus(res.status, parsed);
			if (audio && !ctype.includes("json")) throw new CloudTalkError("BAD_AUDIO", "service", "CloudTalk no devolvió audio WAV válido.");
			const data = unwrap(parsed);
			// La API core puede devolver el error dentro del sobre con HTTP 200.
			const inner = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
			const innerStatus = Number(inner?.status);
			if (inner && Number.isFinite(innerStatus) && innerStatus >= 400) throw errorFromStatus(innerStatus, parsed);
			if (op.id === "sms_send" && inner && (inner.success === false || inner.success === "false")) {
				throw new CloudTalkError("SMS_FAILED", "input", `CloudTalk no envió el mensaje: "${String(typeof inner.data === "string" ? inner.data : JSON.stringify(inner.data ?? "")).slice(0, 300)}".`, res.status);
			}
			if (res.status >= 200 && res.status < 300 && typeof parsed === "string" && parsed && /^\s*</.test(parsed)) {
				throw new CloudTalkError("NOT_JSON", "service", "CloudTalk devolvió HTML en lugar de JSON (¿host o ruta incorrectos?).", res.status);
			}
			return { status: res.status, data, ...(rate ? { rate } : {}) };
		};
		try {
			return await attempt();
		} catch (e) {
			if (!isRead || !this.retryable(e)) throw e;
			const wait = e instanceof CloudTalkError && e.category === "rate_limit" ? this.rateWaitMs(e) : (this.opts.retryDelayMs ?? 800);
			if (wait === undefined) throw e;
			await new Promise((r) => setTimeout(r, wait));
			return attempt();
		}
	}

	private retryable(e: unknown): boolean {
		if (e instanceof CloudTalkError) return e.category === "rate_limit" || (e.category === "service" && !["TOO_LARGE", "REDIRECT", "BAD_AUDIO"].includes(e.code));
		const name = (e as { name?: string })?.name;
		return name === "TypeError" || name === "TimeoutError" || name === "AbortError";
	}

	private rateWaitMs(e: CloudTalkError): number | undefined {
		if (this.opts.retryDelayMs !== undefined) return this.opts.retryDelayMs;
		const reset = this.lastRate?.reset_at_utc ? Date.parse(this.lastRate.reset_at_utc) : undefined;
		if (reset === undefined) return undefined;
		const ms = reset - (this.opts.now?.() ?? Date.now()) + 250;
		return ms <= MAX_RATE_WAIT_MS ? Math.max(ms, 0) : undefined;
	}
}

/** Paginación de la API core: {itemsCount, pageCount, pageNumber, limit, data: [...]}. */
export interface CorePage<T = unknown> {
	itemsCount?: number | string;
	pageCount?: number | string;
	pageNumber?: number | string;
	limit?: number | string;
	data?: T[];
}

/**
 * Recorre páginas de un listado core (page/limit) hasta maxItems o maxPages.
 * Devuelve los elementos y si quedó algo sin leer.
 */
export async function collectCorePages<T = unknown>(client: CloudTalkClient, opId: string, query: Record<string, unknown>, maxItems: number, maxPages: number) {
	const items: T[] = [];
	let page = Number(query.page ?? 1);
	let total: number | undefined;
	let pageCount = 1;
	let pages = 0;
	const limit = Math.min(1000, Math.max(1, Number(query.limit ?? Math.min(maxItems, 1000))));
	while (pages < maxPages && items.length < maxItems) {
		const r = await client.call(opId, { query: { ...query, limit, page } });
		const d = (r.data ?? {}) as CorePage<T>;
		pages++;
		total = d.itemsCount !== undefined ? Number(d.itemsCount) : total;
		pageCount = Number(d.pageCount ?? 1);
		const batch = Array.isArray(d.data) ? d.data : [];
		items.push(...batch.slice(0, maxItems - items.length));
		if (!batch.length || page >= pageCount) break;
		page++;
	}
	const truncated = total !== undefined ? items.length < total : page < pageCount;
	return { items, total, pages_read: pages, truncated };
}

/** Recorre páginas con cursor (APIs v1: {data, meta:{nextCursor}}, {data, pagination:{next}} o {items, nextCursor}). */
export async function collectCursorPages(client: CloudTalkClient, opId: string, input: CallInput, maxItems: number, maxPages: number) {
	const items: unknown[] = [];
	let cursor: string | undefined;
	let pages = 0;
	let more = false;
	do {
		const r = await client.call(opId, { ...input, query: { ...(input.query ?? {}), ...(cursor ? { cursor } : {}) } });
		pages++;
		const d = (r.data ?? {}) as Record<string, any>;
		const batch: unknown[] = Array.isArray(d) ? d : Array.isArray(d.data) ? d.data : Array.isArray(d.items) ? d.items : [];
		items.push(...batch.slice(0, maxItems - items.length));
		const next = d.meta?.nextCursor ?? d.nextCursor ?? d.meta?.next_cursor ?? d.pagination?.next ?? d.pagination?.nextCursor ?? undefined;
		cursor = typeof next === "string" && next ? next : undefined;
		more = !!cursor;
		if (!batch.length) break;
	} while (cursor && pages < maxPages && items.length < maxItems);
	return { items, pages_read: pages, truncated: more };
}
