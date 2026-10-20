import OAuthProvider, { type OAuthProviderOptions, getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as StatelessMcpServer } from "@modelcontextprotocol/server";
import { McpAgent } from "agents/mcp";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { AuthHandler, type Props } from "./auth/handler";
import { CATALOG, CatalogError, brief, isRead, requireOperation, searchOperations, tags, unsupportedReason } from "./cloudtalk/catalog";
import { CloudTalkClient, collectCorePages, collectCursorPages, isAudioData } from "./cloudtalk/client";
import { type ErrorInfo, errorInfo } from "./cloudtalk/errors";
import { validateCall } from "./cloudtalk/validate";
import { isEmailAllowed } from "./config";
import { INSIGHT_PARTS, accountOverview, callInsights, callReport, listCalls } from "./features";
import { PlanRejected, buildApiCallPlan, buildCreateContactPlan, buildMakeCallPlan, buildSendSmsPlan, buildUpdateContactPlan, buildUploadKnowledgeBaseFilePlan, limitsFrom } from "./plans/builders";
import { type Deps, type PlanDraft, applyPlan, cancelPlan, clipData, confirmPhrase, deleteAllPlans, getAuditLog, listPendingPlans, loadPlan, publicStepBody, savePlan } from "./plans/engine";
import { assessRisk } from "./plans/policy";
import type { UsageQuota } from "./quota";
import { type Usage, quotaConfig } from "./quota-policy";
import { hmacHex } from "./util/crypto";

export { PlanLock } from "./lock";
export { UsageQuota } from "./quota";

export const VERSION = "0.1.0";

type ToolResult = { content: ({ type: "text"; text: string } | { type: "audio"; data: string; mimeType: string })[]; isError?: boolean };

class DirectResult {
	constructor(readonly result: ToolResult) {}
}

const CATEGORY_LABEL: Record<string, string> = {
	credential: "Falla la clave API de CloudTalk",
	permission: "CloudTalk no lo permite con esta cuenta o clave",
	not_found: "No existe en tu cuenta de CloudTalk",
	input: "Dato no válido",
	rate_limit: "Límite de peticiones por minuto de CloudTalk",
	service: "CloudTalk no responde correctamente",
	unsupported: "El conector no puede ejecutar esa operación",
	quota: "Límite de uso del conector alcanzado",
	guard: "Bloqueado por una barrera del conector",
	unknown: "Error",
};

/** Respuesta máxima que se devuelve al chat (caracteres de JSON). */
const MAX_RESPONSE_CHARS = 120_000;

const ok = (data: unknown): ToolResult => {
	let text = JSON.stringify(data, null, 2);
	if (text.length > MAX_RESPONSE_CHARS) text = `${JSON.stringify(data).slice(0, MAX_RESPONSE_CHARS)}\n…[RESPUESTA TRUNCADA: pide menos elementos (limit/max_items) o filtra más]`;
	return { content: [{ type: "text", text }], ...((data as { ok?: boolean })?.ok === false ? { isError: true } : {}) };
};

class QuotaError extends Error {
	override name = "QuotaError";
}

function fail(e: unknown): ToolResult {
	if (e instanceof PlanRejected) return ok(e.toResult());
	const info: ErrorInfo = e instanceof QuotaError ? { code: "QUOTA", category: "quota", message: e.message } : e instanceof CatalogError ? { code: "UNKNOWN_OPERATION", category: "input", message: e.message } : errorInfo(e);
	return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, reason: CATEGORY_LABEL[info.category] ?? "Error", ...info, note: "No se ha hecho nada." }, null, 2) }] };
}

/** Contrato de respuesta para cualquier cliente (Claude, Cowork, Codex…). */
const SERVER_INSTRUCTIONS = `CloudTalk (la cuenta propia del usuario) vía su API oficial.
Reglas:
1. Nada está hecho hasta que apply_plan devuelve ok:true. Un plan_* solo valida, lee el estado y prepara; no cambia nada.
2. Si algo no se puede hacer, dilo con el motivo exacto (campos reason/category/message): la API de CloudTalk no lo ofrece, falta permiso o función contratada, falla la clave, lo bloquea una barrera del conector o CloudTalk no responde. No lo sustituyas por otra cosa sin decirlo.
3. Si solo se hizo una parte, enumera lo que no se hizo y por qué (apply_plan devuelve el resultado de cada llamada). Un resultado UNKNOWN significa que no se sabe si se aplicó: pide comprobarlo en CloudTalk antes de repetir.
4. Antes de aplicar, enseña el resumen ANTES → DESPUÉS del plan y, si tiene elevated, sus motivos. Aplica solo con aprobación explícita del usuario, usando exactamente confirm_with ("APPLY <id>" o "APPLY-ELEVATED <id>").
5. No inventes operaciones, parámetros ni campos: describe_api_operation da el esquema oficial; api_read cubre cualquier lectura y plan_api_call cualquier escritura de las 107 operaciones de la API. Obtén los IDs reales con lecturas (get_account_overview, find_contacts, list_calls…).
6. CloudTalk limita a 60 peticiones por minuto por empresa (compartidas con sus otras integraciones): prefiere filtros y rangos de fechas acotados a recorrer todo.
7. Distingue datos de CloudTalk de cálculos del conector (get_call_report agrega el historial y dice si el informe es parcial).`;

const PLAN_NOTE =
	'NO aplica nada: valida contra el esquema oficial, lee el estado actual y devuelve plan_id, resumen ANTES → DESPUÉS y confirm_with. Enseña el resumen al usuario y, solo con su aprobación explícita, llama a apply_plan(plan_id, confirm: confirm_with). Si hay elevated, la confirmación es "APPLY-ELEVATED <plan_id>" y debes enseñar esos motivos antes.';

const idParam = z.union([z.number().int().positive(), z.string().regex(/^\d{1,18}$/)]).transform((v) => Number(v));
const jsonObject = z.record(z.string(), z.unknown());
const dateTime = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/, 'Formato "YYYY-MM-DD" o "YYYY-MM-DD HH:MM:SS"')
	.transform((s) => (s.length === 10 ? s : s.length === 16 ? `${s}:00` : s));

const callFilters = {
	date_from: dateTime.optional().describe('Desde (UTC según CloudTalk), "YYYY-MM-DD" o "YYYY-MM-DD HH:MM:SS". Con solo fecha se envía 00:00:00'),
	date_to: dateTime.optional().describe('Hasta (UTC), mismo formato. Con solo fecha se envía 23:59:59'),
	type: z.enum(["incoming", "outgoing", "internal"]).optional(),
	status: z.enum(["missed", "answered"]).optional(),
	user_id: idParam.optional().describe("ID del agente"),
	contact_id: idParam.optional(),
	tag_id: idParam.optional().describe("ID de etiqueta de llamada"),
	public_internal: z.string().max(20).optional().describe("Número de la cuenta (línea) implicado"),
	public_external: z.string().max(20).optional().describe("Número externo (cliente) implicado"),
	agent_extension: idParam.optional(),
};

/** "2026-10-01" → desde 00:00:00 / hasta 23:59:59. */
function normalizeRange<T extends { date_from?: string; date_to?: string }>(f: T): T {
	const out = { ...f };
	if (out.date_from && out.date_from.length === 10) out.date_from = `${out.date_from} 00:00:00`;
	if (out.date_to && out.date_to.length === 10) out.date_to = `${out.date_to} 23:59:59`;
	return out;
}

/** Opciones del proveedor OAuth: las mismas para servir peticiones y para revocar grants desde el MCP. */
function providerOptions(env: Env): OAuthProviderOptions<Env> {
	return {
		apiHandlers: {
			"/mcp": { fetch: handleMcpRequest },
			"/sse": CloudTalkMCP.serveSSE("/sse", { binding: "MCP_OBJECT" }) as any,
		},
		authorizeEndpoint: "/authorize",
		clientRegistrationEndpoint: "/register",
		defaultHandler: AuthHandler as any,
		tokenEndpoint: "/token",
		accessTokenTTL: 30 * 24 * 3600,
		refreshTokenTTL: undefined,
		clientRegistrationTTL: undefined,
		resourceMetadata: {
			resource: (env.PUBLIC_BASE_URL || "").replace(/\/$/, "").toLowerCase() || undefined,
			resource_name: "MyContent CloudTalk MCP",
		} as any,
	};
}

/** Herramientas del MCP. El estado (planes, auditoría, cuota) vive en KV y Durable Objects, no en la sesión del protocolo. */
export class CloudTalkTools {
	constructor(
		readonly env: Env,
		private readonly propsForRequest: () => Props | undefined,
		readonly server: McpServer | StatelessMcpServer = new McpServer({ name: "MyContent CloudTalk MCP", version: VERSION }, { instructions: SERVER_INSTRUCTIONS }),
	) {}
	private userKeyCache?: { email: string; key: string };
	get props() {
		return this.propsForRequest();
	}

	private async userKey(): Promise<string> {
		const email = (this.props?.email ?? "").toLowerCase();
		if (this.userKeyCache?.email !== email) this.userKeyCache = { email, key: (await hmacHex(this.env.COOKIE_ENCRYPTION_KEY, `user:${email}`)).slice(0, 24) };
		return this.userKeyCache.key;
	}

	private async services() {
		const p = this.props;
		if (!p?.email || !isEmailAllowed(p.email, this.env.ALLOWED_EMAILS, this.env.BLOCKED_EMAILS)) throw new Error(`403: ${p?.email ?? "usuario desconocido"} no tiene acceso a este conector.`);
		if (!p.cloudtalk?.keyId || !p.cloudtalk?.secret) throw new Error("Tu conexión no tiene una clave de CloudTalk registrada. Desconecta el conector y vuelve a conectarlo para registrarla.");
		const userKey = await this.userKey();
		const quota = this.env.USAGE_QUOTA.get(this.env.USAGE_QUOTA.idFromName("global")) as unknown as DurableObjectStub<UsageQuota>;
		const cfg = quotaConfig(this.env as unknown as Record<string, unknown>);
		const reserve = async (req: Partial<Usage>) => {
			let r: { ok: boolean; reason?: string };
			try {
				r = await quota.consume(userKey, req, cfg);
			} catch (e) {
				console.error(JSON.stringify({ evt: "quota_error", error: (e as Error).message.slice(0, 120) }));
				throw new QuotaError("No se pudo comprobar la cuota diaria. Inténtalo de nuevo en unos segundos.");
			}
			if (!r.ok) throw new QuotaError(r.reason);
		};
		const creds = { keyId: p.cloudtalk.keyId, secret: p.cloudtalk.secret };
		const client = new CloudTalkClient(creds, { beforeRequest: () => reserve({ calls: 1 }) });
		const bulkClient = new CloudTalkClient(creds);
		const deps: Deps = {
			kv: this.env.STATE_KV,
			client,
			bulkClient,
			userKey,
			planSecret: `${creds.keyId}|${creds.secret}`,
			reserve,
			acquire: (planId, req) => this.env.PLAN_LOCK.get(this.env.PLAN_LOCK.idFromName("global")).claimWithQuota(userKey, planId, req, cfg),
		};
		return { client, deps, quota, cfg, userKey, props: p, env: this.env as unknown as Record<string, unknown> };
	}

	private tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
		const readOnly = /^(get_|list_|find_|check_|describe_|preview_|api_read)/.test(name);
		(this.server as any).registerTool(
			name,
			{
				description,
				inputSchema: shape,
				annotations: { readOnlyHint: readOnly, destructiveHint: ["apply_plan", "disconnect_cloudtalk"].includes(name), idempotentHint: readOnly || name === "cancel_plan", openWorldHint: name !== "describe_api_operation" },
			},
			async (args: any) => {
				const started = Date.now();
				const log = async (outcome: "ok" | "rejected" | "error", code?: string) =>
					// Una línea JSON por llamada. Sin argumentos, teléfonos ni claves: usuario seudonimizado.
					console.log(JSON.stringify({ evt: "tool_call", tool: name, user: await this.userKey().catch(() => "?"), outcome, ms: Date.now() - started, ...(code ? { code } : {}) }));
				try {
					const data = await handler(args);
					const result = data instanceof DirectResult ? data.result : ok(data);
					await log(result.isError ? "rejected" : "ok", result.isError ? String((data as { outcome?: string; stage?: string })?.outcome ?? (data as { stage?: string })?.stage ?? "not_ok") : undefined);
					return result;
				} catch (e) {
					await log(e instanceof PlanRejected ? "rejected" : "error", e instanceof PlanRejected ? "guards" : e instanceof QuotaError ? "QUOTA" : errorInfo(e).code);
					return fail(e);
				}
			},
		);
	}

	private async plan(build: (s: Awaited<ReturnType<CloudTalkTools["services"]>>) => Promise<PlanDraft>) {
		const s = await this.services();
		return savePlan(s.deps, await build(s));
	}

	async init() {
		/* ============================== CATÁLOGO Y LECTURA GENÉRICA ============================== */

		this.tool(
			"describe_api_operation",
			`Catálogo oficial de la API de CloudTalk (${CATALOG.operation_count} operaciones, OpenAPI v${CATALOG.api_version}). Sin argumentos: áreas y operaciones. Con filter/tag: búsqueda. Con operation: esquema exacto (parámetros de ruta y consulta, campos del body con tipos, obligatorios y valores permitidos), si es lectura (api_read) o escritura (plan_api_call) y su barrera. No llama a CloudTalk.`,
			{
				operation: z.string().max(80).optional().describe('ID de operación, p. ej. "contacts_add" o "dialer_patch_campaign"'),
				filter: z.string().max(100).optional().describe('Palabras a buscar, p. ej. "webhook", "sms", "campaign status"'),
				tag: z.string().max(60).optional().describe('Área: Calls, Contacts, Agents, Groups, Numbers, Sms, Dialer, Campaigns, VoiceAgent, Webhooks, "Conversation Intelligence", "Contact tags", Utilities, Bulks, CueCard'),
			},
			async ({ operation, filter, tag }) => {
				if (!isEmailAllowed(this.props?.email, this.env.ALLOWED_EMAILS, this.env.BLOCKED_EMAILS)) throw new Error(`403: ${this.props?.email ?? "usuario desconocido"} no tiene acceso a este conector.`);
				if (operation) {
					const op = requireOperation(operation);
					const risk = isRead(op) ? undefined : assessRisk(op, undefined);
					return {
						operation: op.id,
						area: op.tag,
						kind: isRead(op) ? "read" : "write",
						use_with: op.id === "upload_knowledge_base_file" ? "plan_upload_knowledge_base_file" : isRead(op) ? "api_read" : "plan_api_call",
						method: op.method,
						url: `${op.host}${op.path}`,
						summary: op.summary,
						description: op.description,
						path_params: op.path_params,
						query_params: op.query_params,
						...(op.body ? { body: op.body } : {}),
						...(unsupportedReason(op) ? { unsupported: unsupportedReason(op) } : {}),
						...(risk ? { guard: risk.elevated.length ? `APPLY-ELEVATED: ${risk.elevated.join(" | ")}` : "APPLY (confirmación normal; algunas variantes del body pueden exigir APPLY-ELEVATED)", ...(risk.warnings.length ? { notes: risk.warnings } : {}) } : {}),
					};
				}
				const ops = searchOperations(filter, tag);
				return { source: CATALOG.source, api_version: CATALOG.api_version, areas: tags(), matches: ops.length, operations: ops.map(brief) };
			},
		);

		this.tool(
			"api_read",
			"Ejecuta CUALQUIER lectura (GET) de la API de CloudTalk por su id de operación (describe_api_operation), incluidas grabaciones WAV como contenido de audio MCP (máximo 5 MB). Valida parámetros contra el esquema oficial. all_pages=true recorre páginas (page/limit o cursor) hasta max_items.",
			{
				operation: z.string().max(80),
				path_params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
				query: jsonObject.optional().describe("Parámetros de consulta documentados de la operación"),
				all_pages: z.boolean().default(false),
				max_items: z.number().int().min(1).max(5000).default(500).describe("Con all_pages: máximo de elementos a reunir"),
			},
			async (a) => {
				const op = requireOperation(a.operation);
				if (!isRead(op)) throw new PlanRejected(`${op.id} es una escritura (${op.method}): usa plan_api_call y apply_plan.`);
				const unsupported = unsupportedReason(op);
				if (unsupported) throw new PlanRejected(`${op.id}: ${unsupported}`);
				const v = validateCall(op, { path_params: a.path_params, query: a.query });
				if (v.errors.length) throw new PlanRejected(`Parámetros no válidos para ${op.id}.`, { errors: v.errors });
				const { client } = await this.services();
				const maxPages = Math.ceil(a.max_items / 100) + 1;
				if (a.all_pages && op.query_params.some((q) => q.name === "page")) {
					const r = await collectCorePages(client, op.id, v.query, a.max_items, Math.min(maxPages, 10));
					return { operation: op.id, total: r.total ?? null, returned: r.items.length, truncated: r.truncated, pages_read: r.pages_read, items: r.items, rate_limit: client.lastRate ?? null };
				}
				if (a.all_pages && op.query_params.some((q) => q.name === "cursor")) {
					const r = await collectCursorPages(client, op.id, { path: v.path, query: v.query }, a.max_items, Math.min(maxPages, 20));
					return { operation: op.id, returned: r.items.length, truncated: r.truncated, pages_read: r.pages_read, items: r.items, rate_limit: client.lastRate ?? null };
				}
				const r = await client.call(op, { path: v.path, query: v.query });
				if (isAudioData(r.data)) {
					return new DirectResult({ content: [
						{ type: "text", text: JSON.stringify({ operation: op.id, http_status: r.status, mime_type: r.data.mimeType, bytes: r.data.bytes, rate_limit: r.rate ?? null }) },
						{ type: "audio", data: r.data.data, mimeType: r.data.mimeType },
					] });
				}
				return { operation: op.id, http_status: r.status, data: r.data, rate_limit: r.rate ?? null, ...(op.id === "get_webhook_endpoint_secret" ? { warning: "Contiene el secreto de firma del webhook: no lo compartas fuera de su receptor." } : {}) };
			},
		);

		/* ============================== LECTURAS CURADAS ============================== */

		this.tool("check_connection", "Prueba la clave de CloudTalk (lista 1 agente) y devuelve latencia, agentes visibles y estado del límite de peticiones por minuto.", {}, async () => {
			const { client, props } = await this.services();
			const start = Date.now();
			const r = await client.call("agents_index", { query: { limit: 1 } });
			return { ok: true, version: VERSION, key_id_suffix: props.cloudtalk.keyId.slice(-4), registered_at_utc: props.cloudtalk.registeredAt, agents_visible: Number((r.data as { itemsCount?: unknown })?.itemsCount ?? 0), latency_ms: Date.now() - start, rate_limit: r.rate ?? null, checked_at_utc: new Date().toISOString() };
		});

		this.tool(
			"get_account_overview",
			"Foto de la cuenta de CloudTalk: agentes (disponibilidad, extensión, números), grupos, números (a qué están conectados) y estadísticas en vivo de hoy por grupo (contestadas, perdidas, cola, esperas). Úsala primero para obtener IDs reales.",
			{},
			async () => accountOverview((await this.services()).client),
		);

		this.tool(
			"list_calls",
			"Historial de llamadas con filtros (fechas, tipo, contestada/perdida, agente, contacto, etiqueta, números) en formato compacto: fecha, tipo, contestada, conversación, espera, números, agente, contacto, coste, etiquetas, notas y enlace al detalle. Recorre páginas de 1.000 hasta max_calls.",
			{ ...callFilters, max_calls: z.number().int().min(1).max(5000).default(200) },
			async ({ max_calls, ...f }) => listCalls((await this.services()).client, normalizeRange(f), max_calls),
		);

		this.tool(
			"get_call_report",
			"Informe agregado del historial de llamadas (calculado por el conector) agrupado por agent, day, hour, number, type o contact: llamadas, contestadas, perdidas, tasa de respuesta, minutos de conversación, conversación media, espera media y coste. Indica si es parcial (más llamadas que max_calls).",
			{ ...callFilters, group_by: z.enum(["agent", "day", "hour", "number", "type", "contact"]).default("agent"), max_calls: z.number().int().min(1).max(10000).default(3000) },
			async ({ group_by, max_calls, ...f }) => callReport((await this.services()).client, normalizeRange(f), group_by, max_calls),
		);

		this.tool(
			"get_call",
			`Detalle de una llamada (pasos del call flow, agentes, tiempos, etiquetas, valoración) y su análisis de Conversation Intelligence: resumen, sentimiento, ratio hablar/escuchar, temas, smart notes, transcripción y enlace. parts elige qué pedir (cada parte = 1 petición). Lo no disponible (sin CI contratado, sin grabación) se indica con su motivo.`,
			{
				call_id: idParam,
				parts: z.array(z.enum(INSIGHT_PARTS)).min(1).max(8).default(["details", "summary", "sentiment", "smart_notes"]),
				transcription_limit: z.number().int().min(1).max(1000).default(300).describe("Máximo de frases de la transcripción"),
			},
			async ({ call_id, parts, transcription_limit }) => callInsights((await this.services()).client, String(call_id), parts, transcription_limit),
		);

		this.tool(
			"find_contacts",
			"Busca contactos de CloudTalk por palabra clave (nombre, empresa, teléfono…), etiqueta, país o sector. Devuelve id, nombre, empresa, teléfonos y emails. El listado no incluye las etiquetas de cada contacto; usa get_contact para verlas.",
			{
				keyword: z.string().max(200).optional(),
				tag_id: idParam.optional(),
				country_id: idParam.optional(),
				industry: z.string().max(100).optional(),
				max_results: z.number().int().min(1).max(1000).default(50),
			},
			async ({ max_results, ...q }) => {
				const { client } = await this.services();
				const query = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== ""));
				const r = await collectCorePages<Record<string, any>>(client, "contacts_index", query, max_results, 3);
				return {
					filters: query,
					total_matching: r.total ?? null,
					truncated: r.truncated,
					contacts: r.items.map((x) => {
						const c = x.Contact ?? x;
						const tagRows = x.Tag ?? x.ContactsTag ?? c.tags;
						return {
							id: String(c.id),
							name: c.name,
							company: c.company ?? null,
							title: c.title ?? null,
							phones: (x.ContactNumber ?? c.contact_numbers ?? []).map((n: any) => `+${String(n?.public_number ?? n).replace(/\D/g, "")}`),
							emails: (x.ContactEmail ?? c.contact_emails ?? []).map((e: any) => e?.email ?? e),
							tags: Array.isArray(tagRows) ? tagRows.map((t: any) => t?.name ?? t) : null,
						};
					}),
				};
			},
		);

		this.tool(
			"get_contact",
			"Ficha completa de un contacto (datos, teléfonos, emails, etiquetas, atributos, URLs externas) y, opcionalmente, sus notas, actividades y últimas llamadas.",
			{ contact_id: idParam, include_notes: z.boolean().default(true), include_activities: z.boolean().default(false), include_calls: z.boolean().default(false) },
			async ({ contact_id, include_notes, include_activities, include_calls }) => {
				const { client } = await this.services();
				const id = String(contact_id);
				const contact = (await client.call("contacts_show", { path: { contactId: id } })).data;
				const out: Record<string, unknown> = { contact };
				if (include_notes) out.notes = (await collectCorePages(client, "notes_index", { contact_id: id }, 100, 1)).items;
				if (include_activities) out.activities = (await collectCorePages(client, "activity_index", { contact_id: id }, 100, 1)).items;
				if (include_calls) out.recent_calls = (await listCalls(client, { contact_id: Number(id) }, 20)).calls;
				return out;
			},
		);

		this.tool(
			"get_capabilities",
			"Qué permite y qué NO la API de CloudTalk a través de este conector, sus barreras y tus límites. Consúltala antes de prometer algo al usuario.",
			{},
			async () => {
				const { cfg } = await this.services();
				const limits = limitsFrom(this.env as unknown as Record<string, unknown>);
				return {
					version: VERSION,
					api: { source: CATALOG.source, version: CATALOG.api_version, spec_sha256: CATALOG.spec_sha256, operations: CATALOG.operation_count, areas: tags() },
					coverage: "Las 107 operaciones del OpenAPI: lecturas por api_read (WAV como audio MCP), escrituras JSON por plan_api_call y subida multipart por plan_upload_knowledge_base_file. Los ficheros tienen límite de 5 MB.",
					not_executable: CATALOG.operations.filter((o) => unsupportedReason(o)).map((o) => ({ operation: o.id, reason: unsupportedReason(o) })),
					not_in_cloudtalk_api: [
						"Configurar call flows, IVR, horarios o colas (solo se puede cambiar a qué grupo/agente apunta un número)",
						"Comprar, portar o dar de baja números en la facturación (numbers_clear solo desregistra el enrutado)",
						"Crear o borrar grupos, cambiar roles o permisos de usuario, facturación y recargas",
						"Estadísticas históricas agregadas oficiales: get_call_report las calcula a partir del historial de llamadas",
					],
					guards: {
						two_phase: "plan_* → apply_plan con confirmación literal; plan de un solo uso; re-lectura del estado y aborto si cambió",
						elevated: "Borrados, enrutado de números, alta de agentes y cambios de email/salientes/límite de gasto, SMS/WhatsApp, llamadas de VoiceAgent, webhooks (URL, eventos, secreto), activar marcación del Dialer y acciones masivas con borrados",
						rate_limit: "CloudTalk: 60 peticiones/min por empresa (respuesta 429). El conector reintenta una vez las lecturas si la espera es ≤ 5 s",
					},
					limits: { sms_recipients_per_plan: limits.maxSmsRecipients, sms_max_chars: limits.maxSmsChars, daily_per_user: cfg.user, daily_global: cfg.global, plan_ttl: "24 h (2 h si contacta a terceros)" },
				};
			},
		);

		this.tool("get_quota_usage", "Tu uso de hoy (día UTC) de este conector: peticiones a CloudTalk y contactos salientes (SMS, llamadas, VoiceAgent), con tus límites diarios.", {}, async () => {
			const { quota, cfg, userKey } = await this.services();
			const u = await quota.usage(userKey);
			return { day_utc: u.day, used: u.used, limits: cfg.user, note: "Aparte, CloudTalk limita a 60 peticiones/min por empresa." };
		});

		/* ============================== ESCRITURA (plan) ============================== */

		this.tool(
			"plan_api_call",
			`Plan para escrituras JSON de la API de CloudTalk (PUT/POST/PATCH/DELETE) por su id de operación: valida path_params, query y body contra el esquema oficial (rechaza campos inventados salvo allow_undocumented_fields=true), lee el estado del objeto si existe (ANTES) y aplica la barrera de la operación. Para upload_knowledge_base_file usa plan_upload_knowledge_base_file. ${PLAN_NOTE}`,
			{
				operation: z.string().max(80),
				path_params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
				query: jsonObject.optional(),
				body: z.unknown().optional().describe("Body JSON exactamente como lo documenta describe_api_operation (objeto, o array en bulk_contacts)"),
				allow_undocumented_fields: z.boolean().default(false).describe("true solo si sabes que la API acepta un campo que el OpenAPI no documenta: se envía con aviso"),
			},
			async (a) => this.plan(({ client, env }) => buildApiCallPlan(client, env, a)),
		);

		this.tool(
			"plan_upload_knowledge_base_file",
			`Prepara upload_knowledge_base_file por multipart/form-data. Recibe un fichero de hasta 5 MB en base64 estándar y conserva los bytes solo en el plan cifrado; el resumen muestra nombre, tamaño y SHA-256. CloudTalk deriva el nombre de la base de conocimiento del fichero. ${PLAN_NOTE}`,
			{
				filename: z.string().min(1).max(128),
				content_base64: z.string().min(4).describe("Contenido binario del fichero codificado en base64 estándar"),
				mime_type: z.string().max(100).optional().describe("Tipo MIME; por defecto application/octet-stream"),
			},
			async (a) => this.plan(({ env }) => buildUploadKnowledgeBaseFilePlan(env, a)),
		);

		const contactFields = {
			title: z.string().max(255).optional(),
			company: z.string().max(100).optional(),
			industry: z.string().max(100).optional(),
			website: z.string().max(100).optional(),
			address: z.string().max(255).optional(),
			city: z.string().max(255).optional(),
			zip: z.string().max(15).optional(),
			state: z.string().max(255).optional(),
			country_id: idParam.optional().describe("ID de país de CloudTalk (api_read countries_index)"),
			favorite_agent: idParam.optional().describe("ID del agente preferido"),
		};

		this.tool(
			"plan_create_contact",
			`Plan para crear un contacto con teléfonos (E.164), emails, etiquetas (por nombre), atributos personalizados (attribute_id de contacts_attributes) y URLs externas. Comprueba antes si ya existe un contacto con ese teléfono (si existe, rechaza salvo allow_duplicate=true). ${PLAN_NOTE}`,
			{
				name: z.string().min(1).max(150),
				...contactFields,
				phones: z.array(z.string().max(30)).max(10).optional(),
				emails: z.array(z.string().max(254)).max(10).optional(),
				tags: z.array(z.string().min(1).max(100)).max(20).optional(),
				attributes: z.array(z.object({ attribute_id: z.number().int().positive(), value: z.string().max(255) })).max(50).optional(),
				external_urls: z.array(z.object({ name: z.string().max(30), url: z.string().url().max(500) })).max(3).optional(),
				allow_duplicate: z.boolean().default(false),
			},
			async (a) => this.plan(({ client, env }) => buildCreateContactPlan(client, env, a)),
		);

		this.tool(
			"plan_update_contact",
			`Plan para modificar un contacto SIN perder datos: lee el actual, FUSIONA teléfonos y emails (add_/remove_) en lugar de reemplazarlos y añade/quita etiquetas por sus endpoints propios. Solo envía lo que cambia y enseña ANTES → DESPUÉS. ${PLAN_NOTE}`,
			{
				contact_id: idParam,
				name: z.string().min(1).max(150).optional(),
				...contactFields,
				add_phones: z.array(z.string().max(30)).max(10).optional(),
				remove_phones: z.array(z.string().max(30)).max(10).optional(),
				add_emails: z.array(z.string().max(254)).max(10).optional(),
				remove_emails: z.array(z.string().max(254)).max(10).optional(),
				add_tags: z.array(z.string().min(1).max(100)).max(20).optional(),
				remove_tags: z.array(z.string().min(1).max(100)).max(20).optional(),
			},
			async (a) => this.plan(({ client, env }) => buildUpdateContactPlan(client, env, a)),
		);

		this.tool(
			"plan_send_sms",
			`Plan para enviar un SMS (o WhatsApp con channel="whatsapp") desde un número de TU cuenta (se comprueba) a uno o varios destinatarios E.164 (máx. por plan configurable, 20 por defecto). Siempre APPLY-ELEVATED; cuenta en tu límite diario de contactos salientes. Cada destinatario se envía por separado y el resultado los lista uno a uno. ${PLAN_NOTE}`,
			{
				sender: z.string().max(30).describe("Número de tu cuenta de CloudTalk, E.164"),
				recipients: z.array(z.string().max(30)).min(1).max(100),
				message: z.string().min(1).max(5000),
				channel: z.enum(["sms", "whatsapp"]).default("sms"),
				country_code: z.string().max(5).optional().describe("Código de país del destinatario, si CloudTalk lo necesita"),
				images_by_url: z.array(z.string().url().max(1000)).max(5).optional().describe("MMS: hasta 5 imágenes https (máx. 5 MB)"),
				file_by_url: z.string().url().max(1000).optional().describe("WhatsApp: fichero https (máx. 16 MB)"),
			},
			async (a) => this.plan(({ client, env }) => buildSendSmsPlan(client, env, limitsFrom(env), a)),
		);

		this.tool(
			"plan_make_call",
			`Plan para iniciar una llamada (click-to-call): CloudTalk llama primero al agente (máx. 20 s) y, cuando descuelga, marca el número. Comprueba que el agente existe, tiene salientes y avisa si no está online. Cuenta en tu límite diario de contactos salientes. ${PLAN_NOTE}`,
			{ agent_id: idParam, callee_number: z.string().max(30).describe("Número a llamar, E.164") },
			async (a) => this.plan(({ client, env }) => buildMakeCallPlan(client, env, a)),
		);

		/* ============================== PLANES ============================== */

		this.tool(
			"apply_plan",
			'Ejecuta EXACTAMENTE un plan ya creado. confirm debe ser literalmente su confirm_with: "APPLY <plan_id>" o "APPLY-ELEVATED <plan_id>". SOLO con aprobación explícita del usuario. Vuelve a leer el estado y aborta si cambió. Un plan solo se aplica una vez. Devuelve ok:true solo si TODO se hizo; si no, el resultado de cada llamada (DONE, FAILED, UNKNOWN, NOT_ATTEMPTED) con su motivo.',
			{ plan_id: z.string().max(40), confirm: z.string().max(80) },
			async ({ plan_id, confirm }) => applyPlan((await this.services()).deps, plan_id.trim(), confirm),
		);

		this.tool(
			"preview_plan",
			"Recupera un plan propio sin ejecutarlo: resumen, avisos, motivos de confirmación reforzada, llamadas exactas a la API y confirm_with.",
			{ plan_id: z.string().max(40) },
			async ({ plan_id }) => {
				const p = await loadPlan((await this.services()).deps, plan_id.trim());
				if (!p) return { ok: false, message: "El plan no existe, ha caducado o no es tuyo." };
				return { plan_id: p.id, kind: p.kind, summary: p.summary, warnings: p.warnings, elevated: p.elevated, confirm_with: confirmPhrase(p.id, p.elevated), expires_at_utc: new Date(p.expiresAt).toISOString(), api_calls: p.action.steps.map((s) => ({ operation: s.op, label: s.label, path_params: s.path, query: s.query, body: clipData(publicStepBody(s), 3000) })) };
			},
		);

		this.tool(
			"list_pending_plans",
			"Tus planes creados y aún no aplicados ni caducados (24 h; los que contactan a terceros, 2 h), más recientes primero, con confirm_with y resumen. Antes de aplicar uno antiguo, enseña de nuevo el resumen al usuario.",
			{},
			async () => ({ plans: await listPendingPlans((await this.services()).deps) }),
		);

		this.tool("cancel_plan", "Descarta uno de tus planes pendientes sin aplicar nada.", { plan_id: z.string().max(40) }, async ({ plan_id }) => cancelPlan((await this.services()).deps, plan_id.trim()));

		this.tool(
			"get_audit_log",
			"Tu registro de auditoría (solo el tuyo), más reciente primero: fecha UTC, plan, operaciones, IDs, nombres de campos enviados (sin sus valores) y resultado de cada llamada.",
			{ limit: z.number().int().min(1).max(100).default(20) },
			async ({ limit }) => {
				const { userKey } = await this.services();
				return { records: await getAuditLog(this.env.STATE_KV, userKey, limit) };
			},
		);

		this.tool(
			"disconnect_cloudtalk",
			'Borra tu clave de CloudTalk y tus planes pendientes y revoca TODAS tus autorizaciones de este conector (en todos tus clientes). Tendrás que volver a conectar. confirm debe ser exactamente "DISCONNECT". La auditoría se conserva 12 meses (pide su borrado por email).',
			{ confirm: z.string().max(20) },
			async ({ confirm }) => {
				if (confirm !== "DISCONNECT") return { ok: false, message: 'Confirmación incorrecta: debe ser exactamente "DISCONNECT". No se ha borrado nada.' };
				const p = this.props;
				if (!p?.sub) throw new Error("No se pudo identificar tu usuario.");
				const userKey = await this.userKey();
				const plans = await deleteAllPlans(this.env.STATE_KV, userKey);
				const api = getOAuthApi(providerOptions(this.env), this.env);
				let revoked = 0;
				let cursor: string | undefined;
				do {
					const page = await api.listUserGrants(p.sub, cursor ? { cursor } : undefined);
					for (const g of page.items) {
						await api.revokeGrant(g.id, p.sub);
						revoked++;
					}
					cursor = page.cursor;
				} while (cursor);
				return { ok: true, revoked_grants: revoked, deleted_pending_plans: plans, message: "Clave borrada y autorizaciones revocadas. Esta sesión dejará de funcionar. Recomendado: revoca también la clave en CloudTalk (Account → Settings → API Keys)." };
			},
		);
	}
}

/** Sesiones con mcp-session-id y el endpoint /sse heredado. */
export class CloudTalkMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "MyContent CloudTalk MCP", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
	async init() {
		await new CloudTalkTools(this.env, () => this.props, this.server).init();
	}
}

const verifiedProps = z.object({
	email: z.string().min(1),
	name: z.string(),
	sub: z.string().min(1),
	cloudtalk: z.object({ keyId: z.string().min(1), secret: z.string().min(1), registeredAt: z.string(), agentCount: z.number().optional() }),
});

/** Un servidor nuevo por petición (transporte HTTP sin estado): el cierre del protocolo no aborta llamadas en curso. */
export async function handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.headers.has("mcp-session-id")) {
		return CloudTalkMCP.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
	}
	const hostname = new URL(env.PUBLIC_BASE_URL || request.url).hostname;
	const handler = createMcpHandler(
		async () => {
			const props = verifiedProps.parse(getMcpAuthContext()?.props);
			const server = new StatelessMcpServer({ name: "MyContent CloudTalk MCP", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
			await new CloudTalkTools(env, () => props, server).init();
			return server;
		},
		{
			route: "/mcp",
			legacy: "stateless",
			responseMode: "auto",
			allowedHostnames: [hostname],
			allowedOriginHostnames: [hostname, "claude.ai", "chatgpt.com", "chat.openai.com", "localhost", "127.0.0.1"],
			onerror: (error) => console.error(JSON.stringify({ evt: "mcp_transport_error", name: error.name })),
		},
	);
	return handler(request, env, ctx);
}

let provider: OAuthProvider<Env> | undefined;

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const opts = providerOptions(env);
		if (!(opts.resourceMetadata as { resource?: string }).resource) (opts.resourceMetadata as { resource?: string }).resource = new URL(request.url).origin.toLowerCase();
		provider ??= new OAuthProvider<Env>(opts);
		return provider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
