import type { Operation } from "../cloudtalk/catalog";
import { parseList } from "../config";

/**
 * Política de barreras (mismo criterio que el MCP de Google Ads): todo lo que permite la API se puede hacer,
 * con dos niveles de confirmación.
 * - APPLY <id>: cambios corrientes y reversibles (contactos, notas, etiquetas, scripts, encuestas…).
 * - APPLY-ELEVATED <id>: borrados, enrutado de números, usuarios con coste, SMS y llamadas de VoiceAgent a terceros,
 *   envío de datos de llamadas a URLs externas (webhooks) y activar marcación del Dialer.
 * Bloqueo duro: solo las operaciones que el administrador ponga en HARD_BLOCKED_OPERATIONS (vacía por defecto).
 */
export interface Risk {
	elevated: string[];
	warnings: string[];
	/** Contactos salientes reales que hace la operación (SMS, llamadas, llamadas de VoiceAgent): cuota "outreach". */
	outreach: number;
}

/** DELETE que solo desvinculan o archivan (no destruyen el objeto): confirmación normal. */
const SOFT_DELETES = new Set(["contacts_remove_tags", "groups_delete", "detach_voice_agent_knowledge_base", "dialer_archive_script"]);

const OUTREACH_OPS: Record<string, string> = {
	sms_send: "Envía un SMS/WhatsApp real a un tercero (coste por mensaje)",
	calls_create: "Inicia una llamada real: primero suena el agente y, al descolgar, se llama al número",
	create_voice_agent_call: "Un VoiceAgent (IA) llamará de verdad a un tercero (coste por minuto)",
};

const arrFields = ["ContactNumber", "ContactEmail", "ContactsTag", "ContactAttribute", "ExternalUrl"];

export function hardBlocked(op: Operation, env: { HARD_BLOCKED_OPERATIONS?: string }): string | undefined {
	const list = parseList(env.HARD_BLOCKED_OPERATIONS).map((x) => x.toLowerCase());
	if (list.includes(op.id.toLowerCase()) || list.includes(`tag:${op.tag.toLowerCase()}`)) return `La operación ${op.id} está bloqueada por la configuración del conector (HARD_BLOCKED_OPERATIONS).`;
	return undefined;
}

/**
 * before: estado leído del objeto (si la operación tiene lectura de estado). Permite elevar solo cuando un campo
 * sensible CAMBIA de verdad (p. ej. agents_edit exige reenviar email aunque no cambie).
 */
export function assessRisk(op: Operation, body: unknown, before?: unknown): Risk {
	const r: Risk = { elevated: [], warnings: [], outreach: 0 };
	const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

	if (op.method === "DELETE" && !SOFT_DELETES.has(op.id)) r.elevated.push(`Borrado: ${op.summary} (${op.id}). Puede ser irreversible.`);
	if (op.method === "DELETE" && SOFT_DELETES.has(op.id)) r.warnings.push(`${op.summary}: desvincula o archiva; no borra el objeto.`);

	switch (op.id) {
		case "numbers_edit":
			r.elevated.push("Cambia el número o su enrutado: afecta a las llamadas entrantes en curso y futuras.");
			break;
		case "numbers_clear":
			r.elevated.push("Desregistra el número: deja de enrutar llamadas entrantes.");
			break;
		case "agents_add":
			r.elevated.push("Crea un usuario/agente en CloudTalk: puede consumir una licencia (coste) y recibe credenciales.");
			break;
		case "agents_edit": {
			const cur = ((before as { Agent?: Record<string, unknown> } | undefined)?.Agent ?? undefined) as Record<string, unknown> | undefined;
			const changed = (k: string) => k in b && (!cur || String(cur[k] ?? "").toLowerCase() !== String(b[k] ?? "").toLowerCase());
			const sensitive = ["email", "status_outbound", "daily_price_limit"].filter(changed);
			if (sensitive.length) r.elevated.push(`Cambia ${sensitive.join(", ")} del agente (email de acceso, permiso de llamadas salientes o límite de gasto diario).`);
			break;
		}
		case "bulk_contacts": {
			const actions = Array.isArray(body) ? (body as { action?: string }[]) : [];
			const deletes = actions.filter((a) => String(a?.action ?? "").startsWith("delete_")).length;
			if (deletes) r.elevated.push(`La acción masiva incluye ${deletes} borrado(s) (contactos, notas o actividades).`);
			if (actions.some((a) => String(a?.action ?? "") === "edit_contact"))
				r.warnings.push("edit_contact en bloque: si envías ContactNumber/ContactEmail/ContactsTag/ContactAttribute, CloudTalk REEMPLAZA esa lista completa (lo no enviado se borra).");
			break;
		}
		case "contacts_edit":
			if (arrFields.some((k) => k in b)) r.warnings.push(`Envías ${arrFields.filter((k) => k in b).join(", ")}: CloudTalk reemplaza esas listas completas. Si solo quieres añadir, usa plan_update_contact (fusiona con lo existente).`);
			break;
		case "create_webhook_endpoint":
			r.elevated.push("Crea un webhook: CloudTalk enviará datos de llamadas y contactos (datos personales) a una URL externa.");
			break;
		case "update_webhook_endpoint":
			if ("url" in b || "eventTypes" in b || b.enabled === true) r.elevated.push("Cambia la URL, los eventos o reactiva un webhook: envío de datos personales a un sistema externo.");
			break;
		case "rotate_webhook_endpoint_secret":
			r.elevated.push("Rota el secreto de firma: el receptor rechazará los eventos hasta que actualices el secreto allí.");
			break;
		case "campaigns_add":
		case "campaigns_edit":
			if (b.status === "active") r.elevated.push("Deja la campaña del Dialer ACTIVA: los agentes empezarán a llamar a contactos reales.");
			break;
		case "dialer_patch_campaign":
			if (b.status === "active") r.elevated.push("Activa la campaña del Dialer: empezará la marcación a contactos reales.");
			if (b.status === "archived") r.warnings.push("Archiva la campaña: deja de marcar (las sesiones en curso terminan solas).");
			break;
		case "dialer_create_campaign_export":
			r.warnings.push("No es idempotente: cada ejecución encola una exportación nueva (CloudTalk además envía el enlace por email).");
			break;
		case "kill_voice_agent_outbound":
			r.warnings.push(Number(b.duration_seconds) === 0 ? "Levanta la parada de emergencia de llamadas salientes de VoiceAgent." : `Parada de emergencia de llamadas salientes de VoiceAgent durante ${Number(b.duration_seconds)} s (las entrantes no se ven afectadas).`);
			break;
	}
	if (op.method === "PUT" && /^(dialer_replace_|replace_voice_agent)/.test(op.id)) r.warnings.push("Reemplazo completo: lo que no envíes se elimina de esa configuración.");
	if (OUTREACH_OPS[op.id]) {
		r.outreach = 1;
		if (op.id === "calls_create") r.warnings.push(OUTREACH_OPS[op.id]);
		else r.elevated.push(OUTREACH_OPS[op.id]);
	}
	return r;
}

/**
 * Lectura de estado previa a un cambio: lo que el plan enseña como ANTES y cuyo hash se re-comprueba al aplicar
 * (si alguien lo cambió entretanto, el plan se aborta). Solo para operaciones sobre un objeto existente.
 */
export interface StateRead {
	op: string;
	path?: Record<string, string>;
	query?: Record<string, string>;
	/** Si el listado devuelve varios elementos, se queda con el del id. */
	pickId?: string;
}

export function stateReadFor(op: Operation, path: Record<string, string>): StateRead | undefined {
	const p = (k: string) => path[k];
	switch (op.id) {
		case "contacts_edit":
		case "contacts_delete":
		case "contacts_add_tags":
		case "contacts_remove_tags":
		case "notes_add":
		case "activity_add":
			return { op: "contacts_show", path: { contactId: p("contactId") } };
		case "agents_edit":
		case "agents_delete":
			return { op: "agents_index", query: { id: p("agentId") }, pickId: p("agentId") };
		case "campaigns_edit":
		case "campaigns_delete":
			return { op: "campaigns_index", query: { id: p("id") }, pickId: p("id") };
		case "numbers_edit":
		case "numbers_clear":
			return { op: "numbers_index", query: { id: p("id") }, pickId: p("id") };
		case "blacklist_edit":
		case "blacklist_delete":
			return { op: "blacklist_index", query: { id: p("id") }, pickId: p("id") };
		case "tags_edit":
		case "tags_delete":
			return { op: "tags_index", query: { id: p("id") }, pickId: p("id") };
		case "dialer_patch_campaign":
		case "dialer_delete_campaign":
			return { op: "dialer_get_campaign", path: { campaignId: p("campaignId") } };
		case "dialer_replace_campaign_associations":
			return { op: "dialer_get_campaign_associations", path: { campaignId: p("campaignId") } };
		case "dialer_replace_campaign_disposition_buttons":
			return { op: "dialer_get_campaign_disposition_buttons", path: { campaignId: p("campaignId") } };
		case "dialer_patch_script":
		case "dialer_archive_script":
			return { op: "dialer_get_script", path: { scriptId: p("scriptId") } };
		case "dialer_patch_survey":
		case "dialer_replace_survey_questions":
			return { op: "dialer_get_survey", path: { surveyId: p("surveyId") } };
		case "replace_voice_agent":
		case "delete_voice_agent":
		case "attach_voice_agent_knowledge_base":
		case "detach_voice_agent_knowledge_base":
			return { op: "get_voice_agent", path: { voiceAgentId: p("voiceAgentId") } };
		case "update_webhook_endpoint":
		case "delete_webhook_endpoint":
		case "rotate_webhook_endpoint_secret":
			return { op: "get_webhook_endpoint", path: { endpointId: p("endpointId") } };
	}
	return undefined;
}

/** Campos que cambian solos (presencia del agente, contadores en vivo): no cuentan para detectar cambios. */
const VOLATILE = new Set(["availability_status", "is_daily_limit_ok", "real_time", "statistics", "last_login", "online", "status_updated_at"]);

export function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value as object).sort()) if (!VOLATILE.has(k)) out[k] = stable((value as Record<string, unknown>)[k]);
		return out;
	}
	return value;
}

/** Elemento del listado core cuyo id coincide ({Agent:{id}}, {CallNumber:{id}}…). */
export function pickById(data: unknown, id: string): unknown {
	const list = (data as { data?: unknown[] })?.data;
	if (!Array.isArray(list)) return data;
	return (
		list.find((item) => {
			if (!item || typeof item !== "object") return false;
			const inner = Object.values(item as Record<string, unknown>)[0] as { id?: unknown } | undefined;
			return String((item as { id?: unknown }).id ?? inner?.id ?? "") === String(id);
		}) ?? null
	);
}
