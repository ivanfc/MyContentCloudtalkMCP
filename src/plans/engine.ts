import type { CloudTalkClient } from "../cloudtalk/client";
import { errorInfo, type ErrorInfo } from "../cloudtalk/errors";
import type { Usage } from "../quota-policy";
import { decryptJson, encryptJson, sha256Hex } from "../util/crypto";
import { type StateRead, pickById, stable } from "./policy";

export const PLAN_TTL_SECONDS = 24 * 60 * 60;
/** Un plan que contacta a terceros (SMS, llamadas) caduca antes: la decisión pierde vigencia. */
export const OUTREACH_PLAN_TTL_SECONDS = 2 * 60 * 60;
export const AUDIT_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Una llamada a la API dentro de un plan. */
export interface Step {
	op: string;
	label: string;
	path?: Record<string, string>;
	query?: Record<string, unknown>;
	body?: unknown;
}

/** Estado leído al crear el plan: se vuelve a leer al aplicar y, si cambió, el plan se aborta. */
export interface StateCheck {
	read: StateRead;
	label: string;
	hash: string;
}

export interface PlanAction {
	type: "api_calls";
	steps: Step[];
	/** false (por defecto): si un paso falla, los siguientes no se intentan. true: lotes independientes (p. ej. SMS a varios). */
	continueOnError: boolean;
	stateChecks: StateCheck[];
}

export interface Plan {
	id: string;
	kind: string;
	createdAt: string;
	expiresAt: number;
	summary: string[];
	warnings: string[];
	/** Motivos de confirmación reforzada (vacío = "APPLY <id>"). */
	elevated: string[];
	outreach: number;
	action: PlanAction;
}

export interface PlanDraft {
	kind: string;
	summary: string[];
	warnings?: string[];
	elevated?: string[];
	outreach?: number;
	action: PlanAction;
	ttlSeconds?: number;
	/** Detalle para el usuario que no se guarda en el plan. */
	extra?: Record<string, unknown>;
}

export interface Deps {
	kv: KVNamespace;
	/** Cliente con cuota por petición (lecturas sueltas y comprobación de estado). */
	client: CloudTalkClient;
	/** Cliente sin cuota por petición: apply_plan reserva la cuota del plan de una vez. */
	bulkClient: CloudTalkClient;
	/** Seudónimo estable del usuario (HMAC del email). Prefijo de sus claves en KV. */
	userKey: string;
	/** Secreto con el que se cifran sus planes: su clave de CloudTalk (solo está en sus props). */
	planSecret: string;
	/** Reserva cuota; lanza Error con el motivo si no hay. */
	reserve: (req: Partial<Usage>) => Promise<void>;
	/** Cerrojo global (Durable Object) + cuota en una sola operación. false = el plan ya se está aplicando o se aplicó. */
	acquire?: (planId: string, req: Partial<Usage>) => Promise<boolean>;
	/** Cerrojo sin cuota (tests o despliegues sin acquire). */
	claim?: (planId: string) => Promise<boolean>;
	now?: () => number;
}

const now = (d: Deps) => (d.now ? d.now() : Date.now());
const planKey = (d: Deps, id: string) => `plan:${d.userKey}:${id}`;

export const confirmPhrase = (planId: string, elevated: string[]) => (elevated.length ? `APPLY-ELEVATED ${planId}` : `APPLY ${planId}`);

function newPlanId(): string {
	return `p_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Lee el estado de un objeto para el plan: instantánea (para el resumen ANTES) y hash estable. */
export async function readState(client: CloudTalkClient, read: StateRead): Promise<{ snapshot: unknown; hash: string }> {
	const r = await client.call(read.op, { path: read.path, query: read.query });
	const snapshot = read.pickId !== undefined ? pickById(r.data, read.pickId) : r.data;
	return { snapshot, hash: await sha256Hex(JSON.stringify(stable(snapshot))) };
}

/** Fase 1: guarda el plan cifrado con la clave del usuario. Las validaciones y lecturas las hacen los builders antes. */
export async function savePlan(deps: Deps, draft: PlanDraft) {
	const id = newPlanId();
	const t = now(deps);
	const outreach = draft.outreach ?? 0;
	const ttl = draft.ttlSeconds ?? (outreach ? OUTREACH_PLAN_TTL_SECONDS : PLAN_TTL_SECONDS);
	const elevated = [...new Set(draft.elevated ?? [])];
	const plan: Plan = {
		id,
		kind: draft.kind,
		createdAt: new Date(t).toISOString(),
		expiresAt: t + ttl * 1000,
		summary: draft.summary,
		warnings: [...new Set(draft.warnings ?? [])],
		elevated,
		outreach,
		action: draft.action,
	};
	const blob = await encryptJson(deps.planSecret, `plan:${deps.userKey}:${id}`, plan);
	await deps.kv.put(planKey(deps, id), blob, { expirationTtl: ttl, metadata: { kind: plan.kind, expiresAt: plan.expiresAt } });
	return {
		ok: true as const,
		plan_id: id,
		kind: plan.kind,
		expires_at_utc: new Date(plan.expiresAt).toISOString(),
		confirm_with: confirmPhrase(id, elevated),
		elevated,
		summary: plan.summary,
		warnings: plan.warnings,
		api_calls: plan.action.steps.map((s) => ({ operation: s.op, label: s.label, ...(s.path && Object.keys(s.path).length ? { path_params: s.path } : {}), ...(s.query && Object.keys(s.query).length ? { query: s.query } : {}), ...(s.body !== undefined ? { body: s.body } : {}) })),
		...(draft.extra ?? {}),
		note: "Nada se ha cambiado todavía. Enseña este resumen al usuario y aplica solo con su aprobación explícita usando exactamente confirm_with.",
	};
}

/** Un plan solo existe para quien lo creó y con la misma clave de CloudTalk (se descifra con ella). */
export async function loadPlan(deps: Deps, planId: string): Promise<Plan | undefined> {
	if (!/^p_[a-f0-9]{12}$/.test(String(planId ?? ""))) return undefined;
	const raw = await deps.kv.get(planKey(deps, planId));
	if (!raw) return undefined;
	const plan = await decryptJson<Plan>(deps.planSecret, `plan:${deps.userKey}:${planId}`, raw);
	if (!plan) return undefined;
	if (plan.expiresAt <= now(deps)) {
		await deps.kv.delete(planKey(deps, planId));
		return undefined;
	}
	return plan;
}

export async function listPendingPlans(deps: Deps) {
	const prefix = `plan:${deps.userKey}:`;
	const list = await deps.kv.list({ prefix, limit: 100 });
	const out = [];
	for (const k of list.keys) {
		const plan = await loadPlan(deps, k.name.slice(prefix.length));
		if (!plan) continue;
		out.push({
			plan_id: plan.id,
			kind: plan.kind,
			created_at_utc: plan.createdAt,
			expires_at_utc: new Date(plan.expiresAt).toISOString(),
			confirm_with: confirmPhrase(plan.id, plan.elevated),
			elevated: plan.elevated,
			summary: plan.summary.slice(0, 15),
		});
	}
	return out.sort((a, b) => b.created_at_utc.localeCompare(a.created_at_utc));
}

export async function cancelPlan(deps: Deps, planId: string) {
	const plan = await loadPlan(deps, planId);
	if (!plan) return { ok: false, message: `El plan ${planId} no existe, ha caducado o no es tuyo.` };
	await deps.kv.delete(planKey(deps, planId));
	return { ok: true, message: `Plan ${planId} cancelado. No se ha aplicado ningún cambio.` };
}

/** Borra todos los planes pendientes del usuario (disconnect_cloudtalk). */
export async function deleteAllPlans(kv: KVNamespace, userKey: string): Promise<number> {
	let n = 0;
	let cursor: string | undefined;
	do {
		const list = await kv.list({ prefix: `plan:${userKey}:`, cursor, limit: 1000 });
		for (const k of list.keys) {
			await kv.delete(k.name);
			n++;
		}
		cursor = list.list_complete ? undefined : (list as { cursor?: string }).cursor;
	} while (cursor);
	return n;
}

/* ============================== Auditoría ============================== */

export interface AuditRecord {
	timestamp_utc: string;
	plan_id: string;
	kind: string;
	outcome: "APPLIED" | "PARTIAL" | "FAILED" | "ABORTED_STATE_CHANGED" | "UNKNOWN";
	elevated: string[];
	/** Operaciones, parámetros de ruta y nombres de campos enviados (no sus valores: pueden ser datos personales) y resultado por paso. */
	steps: { operation: string; path_params?: Record<string, string>; body_fields?: string[]; outcome: string; http_status?: number; created_id?: string; error?: ErrorInfo }[];
	error?: unknown;
}

const AUDIT_MAX_KEY = 9_999_999_999_999;

async function writeAudit(deps: Deps, rec: AuditRecord) {
	const inverted = String(AUDIT_MAX_KEY - now(deps)).padStart(13, "0");
	await deps.kv.put(`audit:${deps.userKey}:${inverted}:${rec.plan_id}`, JSON.stringify(rec), { expirationTtl: AUDIT_TTL_SECONDS });
}

async function safeAudit(deps: Deps, rec: AuditRecord) {
	try {
		await writeAudit(deps, rec);
	} catch (e) {
		console.error(JSON.stringify({ evt: "audit_write_error", error: (e as Error).message.slice(0, 120) }));
	}
}

/** Auditoría del propio usuario, más reciente primero. No hay forma de leer la de otro. */
export async function getAuditLog(kv: KVNamespace, userKey: string, limit: number): Promise<AuditRecord[]> {
	const n = Math.min(Math.max(limit, 1), 100);
	const list = await kv.list({ prefix: `audit:${userKey}:`, limit: n });
	const out: AuditRecord[] = [];
	for (const k of list.keys) {
		const raw = await kv.get(k.name);
		if (raw) out.push(JSON.parse(raw));
	}
	return out;
}

/* ============================== Aplicar ============================== */

function bodyFields(body: unknown): string[] | undefined {
	if (Array.isArray(body)) return [...new Set(body.flatMap((x) => (x && typeof x === "object" ? Object.keys(x) : [])))].slice(0, 50);
	if (body && typeof body === "object") return Object.keys(body).slice(0, 50);
	return undefined;
}

/** ID creado que devuelve CloudTalk: {status:201, data:{id}} (core) o {id} (v1). */
export function createdId(data: unknown): string | undefined {
	const d = data as Record<string, any> | undefined;
	const id = d?.data?.id ?? d?.id ?? d?.data?.ID ?? d?.call_uuid ?? d?.callId;
	return id === undefined || id === null || typeof id === "object" ? undefined : String(id);
}

/** Recorta respuestas grandes para devolverlas al chat. */
export function clipData(data: unknown, max = 4000): unknown {
	const s = JSON.stringify(data ?? null);
	if (s.length <= max) return data;
	return { truncated: true, preview: s.slice(0, max) };
}

export async function applyPlan(deps: Deps, planId: string, confirm: string) {
	const plan = await loadPlan(deps, planId);
	if (!plan) return { ok: false, message: `El plan ${planId} no existe, ha caducado o no es tuyo. No se ha aplicado nada. Genera un plan nuevo.` };
	const expected = confirmPhrase(planId, plan.elevated);
	if (String(confirm ?? "").trim() !== expected) {
		return {
			ok: false,
			message: `Confirmación incorrecta. Debe ser exactamente "${expected}". No se ha aplicado nada.${plan.elevated.length ? ` Requiere confirmación reforzada por: ${plan.elevated.join(" | ")}` : ""}`,
		};
	}
	const a = plan.action;
	// La auditoría no guarda el resumen: contiene valores (teléfonos, nombres, textos de SMS) y solo debe guardar qué se tocó.
	const base = { timestamp_utc: new Date(now(deps)).toISOString(), plan_id: plan.id, kind: plan.kind, elevated: plan.elevated };
	const auditSteps = (results: AuditRecord["steps"]) => results;

	// 1. ¿Ha cambiado lo que el plan leyó? Si sí, se aborta (y el plan se descarta).
	for (const check of a.stateChecks) {
		let hash: string;
		try {
			hash = (await readState(deps.client, check.read)).hash;
		} catch (e) {
			const info = errorInfo(e);
			return { ok: false, message: `No se pudo volver a leer "${check.label}" para comprobar que no ha cambiado: ${info.message} No se ha aplicado nada; el plan sigue pendiente.`, error: info };
		}
		if (hash !== check.hash) {
			await deps.kv.delete(planKey(deps, planId));
			await safeAudit(deps, { ...base, outcome: "ABORTED_STATE_CHANGED", steps: [] });
			return { ok: false, outcome: "ABORTED_STATE_CHANGED", message: `"${check.label}" ha cambiado desde que se creó el plan. No se ha aplicado nada y el plan se ha descartado: genera uno nuevo con el estado actual.` };
		}
	}
	if (plan.expiresAt <= now(deps)) return { ok: false, message: `El plan ${planId} ha caducado mientras se comprobaba. No se ha aplicado nada. Genera un plan nuevo.` };

	// 2. Cerrojo + cuota en una sola operación: dos apply simultáneos nunca ejecutan ni cobran dos veces.
	const usage = { calls: a.steps.length, outreach: plan.outreach };
	try {
		if (deps.acquire) {
			if (!(await deps.acquire(planId, usage))) return { ok: false, message: `El plan ${planId} ya se está aplicando o ya se aplicó. No se ha vuelto a ejecutar. Revisa get_audit_log.` };
		} else {
			await deps.reserve(usage);
			if (deps.claim && !(await deps.claim(planId))) return { ok: false, message: `El plan ${planId} ya se está aplicando o ya se aplicó. No se ha vuelto a ejecutar. Revisa get_audit_log.` };
		}
	} catch (e) {
		return { ok: false, message: `${(e as Error).message} No se ha aplicado nada; el plan sigue pendiente hasta que caduque.` };
	}
	await deps.kv.delete(planKey(deps, planId));

	// 3. Ejecución paso a paso.
	const results: { step: number; operation: string; label: string; ok: boolean; outcome: "DONE" | "FAILED" | "UNKNOWN" | "NOT_ATTEMPTED"; http_status?: number; created_id?: string; response?: unknown; error?: ErrorInfo }[] = [];
	let stop: string | undefined;
	for (const [i, s] of a.steps.entries()) {
		if (stop) {
			results.push({ step: i + 1, operation: s.op, label: s.label, ok: false, outcome: "NOT_ATTEMPTED", error: { code: "NOT_ATTEMPTED", category: "guard", message: `No se intentó: ${stop}` } });
			continue;
		}
		try {
			const r = await deps.bulkClient.call(s.op, { path: s.path, query: s.query, body: s.body });
			results.push({ step: i + 1, operation: s.op, label: s.label, ok: true, outcome: "DONE", http_status: r.status, created_id: createdId(r.data), response: clipData(r.data, 1500) });
		} catch (e) {
			const info = errorInfo(e);
			const uncertain = info.category === "service" || info.category === "unknown";
			results.push({ step: i + 1, operation: s.op, label: s.label, ok: false, outcome: uncertain ? "UNKNOWN" : "FAILED", ...(info.http_status ? { http_status: info.http_status } : {}), error: info });
			if (info.category === "credential") stop = "la clave API de CloudTalk dejó de ser válida.";
			else if (info.category === "rate_limit") stop = "CloudTalk aplicó su límite de peticiones por minuto.";
			else if (!a.continueOnError) stop = `falló el paso ${i + 1} (${s.label}).`;
		}
	}
	const done = results.filter((r) => r.ok).length;
	const unknown = results.filter((r) => r.outcome === "UNKNOWN").length;
	const outcome: AuditRecord["outcome"] = done === results.length ? "APPLIED" : unknown ? "UNKNOWN" : done === 0 ? "FAILED" : "PARTIAL";
	await safeAudit(deps, {
		...base,
		outcome,
		steps: auditSteps(
			results.map((r, i) => ({
				operation: r.operation,
				...(a.steps[i].path ? { path_params: a.steps[i].path } : {}),
				...(bodyFields(a.steps[i].body) ? { body_fields: bodyFields(a.steps[i].body) } : {}),
				outcome: r.outcome,
				...(r.http_status ? { http_status: r.http_status } : {}),
				...(r.created_id ? { created_id: r.created_id } : {}),
				...(r.error ? { error: r.error } : {}),
			})),
		),
	});
	const notDone = results.filter((r) => !r.ok);
	return {
		ok: outcome === "APPLIED",
		...(outcome === "PARTIAL" ? { partial: true } : {}),
		outcome,
		plan_id: plan.id,
		results,
		message:
			outcome === "APPLIED"
				? `Hecho: ${done} de ${results.length} llamada(s) aplicadas en CloudTalk.`
				: `${done} de ${results.length} llamada(s) aplicadas; ${notDone.length} NO (motivo de cada una en results).${unknown ? " Hay pasos con resultado DESCONOCIDO (error de red o de CloudTalk tras enviar): comprueba en CloudTalk si se aplicaron antes de generar otro plan; este plan no se reejecutará." : ""}${stop ? ` Se detuvo porque ${stop}` : ""}`,
	};
}
