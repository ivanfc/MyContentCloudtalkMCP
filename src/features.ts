import { type CloudTalkClient, collectCorePages } from "./cloudtalk/client";
import { errorInfo } from "./cloudtalk/errors";

const num = (v: unknown) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};
const e164 = (v: unknown) => {
	const d = String(v ?? "").replace(/\D/g, "");
	return d ? `+${d}` : null;
};

/** Valores documentados en numbers_edit.connected_to; cualquier otro se devuelve tal cual. */
const CONNECTED_TO: Record<string, string> = { "0": "group", "1": "agent", "2": "conference_room", "3": "fax" };

/* ============================== Cuenta ============================== */

/** Foto de la cuenta: agentes (con disponibilidad), grupos, números y estadísticas en vivo de hoy. 4+ peticiones. */
export async function accountOverview(client: CloudTalkClient) {
	const [agents, groups, numbers, live] = await Promise.all([
		collectCorePages<{ Agent?: Record<string, any> }>(client, "agents_index", {}, 1000, 3),
		collectCorePages<{ Group?: Record<string, any> }>(client, "groups_index", {}, 1000, 2),
		collectCorePages<{ CallNumber?: Record<string, any> }>(client, "numbers_index", {}, 1000, 2),
		client.call("statistics_realtime_groups").then(
			(r) => r.data,
			(e) => ({ unavailable: errorInfo(e).message }),
		),
	]);
	const agentList = agents.items.map((x) => x.Agent).filter(Boolean) as Record<string, any>[];
	const byStatus: Record<string, number> = {};
	for (const a of agentList) byStatus[String(a.availability_status ?? "unknown")] = (byStatus[String(a.availability_status ?? "unknown")] ?? 0) + 1;
	return {
		observed_at_utc: new Date().toISOString(),
		agents: {
			total: agents.total ?? agentList.length,
			by_availability: byStatus,
			list: agentList.map((a) => ({
				id: String(a.id),
				name: `${a.firstname ?? ""} ${a.lastname ?? ""}`.trim(),
				email: a.email,
				extension: a.extension,
				availability: a.availability_status,
				outbound_allowed: a.status_outbound,
				default_number: a.default_number ?? null,
				associated_numbers: a.associated_numbers ?? [],
			})),
			...(agents.truncated ? { truncated: true } : {}),
		},
		groups: { total: groups.total ?? groups.items.length, list: groups.items.map((x) => x.Group).filter(Boolean).map((g) => ({ id: String(g!.id), name: g!.internal_name })) },
		numbers: {
			total: numbers.total ?? numbers.items.length,
			list: numbers.items
				.map((x) => x.CallNumber)
				.filter(Boolean)
				.map((n) => ({ id: String(n!.id), number: e164(n!.caller_id_e164), name: n!.internal_name, country_code: n!.country_code, connected_to: CONNECTED_TO[String(n!.connected_to)] ?? n!.connected_to, source_id: n!.source_id, redirected: n!.is_redirected })),
		},
		realtime_groups_today: live,
	};
}

/* ============================== Llamadas ============================== */

export interface CallFilters {
	date_from?: string;
	date_to?: string;
	type?: "incoming" | "outgoing" | "internal";
	status?: "missed" | "answered";
	user_id?: number;
	contact_id?: number;
	tag_id?: number;
	public_internal?: string;
	public_external?: string;
	agent_extension?: number;
	call_id?: number;
}

/** Fila compacta de una llamada del historial (Cdr + Contact + Agent + CallNumber + BillingCall + Tags + Notes). */
export function simplifyCall(row: Record<string, any>) {
	const c = row.Cdr ?? {};
	const answered = !!c.answered_at || num(c.talking_time) > 0;
	return {
		id: String(c.id),
		started_at_utc: c.started_at ?? null,
		type: c.type,
		answered,
		talking_s: num(c.talking_time),
		waiting_s: num(c.waiting_time),
		wrapup_s: num(c.wrapup_time),
		external_number: e164(c.public_external),
		internal_number: e164(c.public_internal ?? row.CallNumber?.caller_id_e164),
		line: row.CallNumber?.internal_name ?? null,
		agent: row.Agent?.id ? { id: String(row.Agent.id), name: row.Agent.fullname ?? `${row.Agent.firstname ?? ""} ${row.Agent.lastname ?? ""}`.trim() } : c.user_id ? { id: String(c.user_id) } : null,
		contact: row.Contact?.id ? { id: String(row.Contact.id), name: row.Contact.name, company: row.Contact.company ?? null } : null,
		voicemail: !!c.is_voicemail,
		recorded: !!c.recorded,
		price: row.BillingCall?.price !== undefined ? num(row.BillingCall.price) : null,
		tags: (row.Tags ?? []).map((t: { name?: string }) => t.name).filter(Boolean),
		notes: (row.Notes ?? []).map((n: { note?: string }) => n.note).filter(Boolean),
		details_link: c.recording_link ?? null,
	};
}

export async function listCalls(client: CloudTalkClient, f: CallFilters, maxCalls: number) {
	const query = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== ""));
	const r = await collectCorePages<Record<string, any>>(client, "calls_index", query, maxCalls, Math.ceil(maxCalls / 1000) + 1);
	return { filters: query, total_matching: r.total ?? null, returned: r.items.length, truncated: r.truncated, pages_read: r.pages_read, calls: r.items.map(simplifyCall) };
}

type GroupBy = "agent" | "day" | "number" | "type" | "contact" | "hour";

interface Bucket {
	key: string;
	label: string;
	calls: number;
	answered: number;
	missed: number;
	incoming: number;
	outgoing: number;
	internal: number;
	talking_s: number;
	waiting_s: number;
	cost: number;
}

/**
 * Informe agregado del historial de llamadas (lee hasta max_calls llamadas, 1.000 por página).
 * Métricas por grupo: llamadas, contestadas, perdidas, tasa de respuesta, conversación total/media, espera media y coste.
 */
export async function callReport(client: CloudTalkClient, f: CallFilters, groupBy: GroupBy, maxCalls: number) {
	const data = await listCalls(client, f, maxCalls);
	const buckets = new Map<string, Bucket>();
	const keyOf = (c: ReturnType<typeof simplifyCall>): [string, string] => {
		switch (groupBy) {
			case "agent":
				return c.agent ? [c.agent.id, c.agent.name ?? c.agent.id] : ["none", "(sin agente)"];
			case "day":
				return [String(c.started_at_utc ?? "").slice(0, 10) || "unknown", String(c.started_at_utc ?? "").slice(0, 10) || "(sin fecha)"];
			case "hour": {
				const h = String(c.started_at_utc ?? "").slice(11, 13);
				return [h || "unknown", h ? `${h}:00 UTC` : "(sin hora)"];
			}
			case "number":
				return [c.internal_number ?? "unknown", `${c.internal_number ?? "(sin número)"}${c.line ? ` · ${c.line}` : ""}`];
			case "type":
				return [String(c.type ?? "unknown"), String(c.type ?? "(sin tipo)")];
			case "contact":
				return c.contact ? [c.contact.id, `${c.contact.name}${c.contact.company ? ` (${c.contact.company})` : ""}`] : [c.external_number ?? "unknown", c.external_number ?? "(desconocido)"];
		}
	};
	const total: Bucket = { key: "total", label: "TOTAL", calls: 0, answered: 0, missed: 0, incoming: 0, outgoing: 0, internal: 0, talking_s: 0, waiting_s: 0, cost: 0 };
	let priced = 0;
	for (const c of data.calls) {
		const [key, label] = keyOf(c);
		const b = buckets.get(key) ?? { key, label, calls: 0, answered: 0, missed: 0, incoming: 0, outgoing: 0, internal: 0, talking_s: 0, waiting_s: 0, cost: 0 };
		for (const t of [b, total]) {
			t.calls++;
			if (c.answered) t.answered++;
			else t.missed++;
			if (c.type === "incoming") t.incoming++;
			else if (c.type === "outgoing") t.outgoing++;
			else if (c.type === "internal") t.internal++;
			t.talking_s += c.talking_s;
			t.waiting_s += c.waiting_s;
			t.cost += c.price ?? 0;
		}
		if (c.price !== null) priced++;
		buckets.set(key, b);
	}
	const shape = (b: Bucket) => ({
		key: b.key,
		label: b.label,
		calls: b.calls,
		answered: b.answered,
		missed: b.missed,
		answer_rate_pct: b.calls ? Math.round((b.answered / b.calls) * 1000) / 10 : null,
		incoming: b.incoming,
		outgoing: b.outgoing,
		internal: b.internal,
		talking_total_min: Math.round((b.talking_s / 60) * 10) / 10,
		talking_avg_s_answered: b.answered ? Math.round(b.talking_s / b.answered) : null,
		waiting_avg_s: b.calls ? Math.round(b.waiting_s / b.calls) : null,
		cost: Math.round(b.cost * 10000) / 10000,
	});
	return {
		filters: data.filters,
		group_by: groupBy,
		calls_analyzed: data.returned,
		total_matching: data.total_matching,
		complete: !data.truncated,
		...(data.truncated ? { warning: `Informe PARCIAL: se analizaron ${data.returned} de ${data.total_matching ?? "?"} llamadas. Acota el rango de fechas o sube max_calls.` } : {}),
		definitions: {
			answered: "talking_time > 0 o answered_at presente en el historial (Cdr)",
			cost: `Suma de BillingCall.price en la moneda de facturación de la cuenta; ${priced} de ${data.returned} llamadas traían precio`,
			dates: "Fechas en UTC según CloudTalk; los filtros date_from/date_to se envían tal cual (formato YYYY-MM-DD HH:MM:SS)",
		},
		total: shape(total),
		groups: [...buckets.values()].sort((a, b) => b.calls - a.calls).map(shape),
	};
}

/* ============================== Una llamada ============================== */

export const INSIGHT_PARTS = ["details", "summary", "sentiment", "talk_listen_ratio", "topics", "smart_notes", "transcription", "details_link"] as const;
export type InsightPart = (typeof INSIGHT_PARTS)[number];

const PART_OP: Record<InsightPart, string> = {
	details: "calls_details",
	summary: "ai_calls_summary",
	sentiment: "ai_calls_overall_sentiment",
	talk_listen_ratio: "ai_calls_talk_listen_ratio",
	topics: "ai_calls_topics",
	smart_notes: "ai_calls_smart_notes",
	transcription: "ai_calls_transcription",
	details_link: "ai_calls_details_link",
};

/**
 * Detalle y análisis de IA de una llamada. Cada parte es una petición; una parte no disponible (sin Conversation
 * Intelligence, llamada sin grabar, aún procesándose) se informa con su motivo y no tumba las demás.
 */
export async function callInsights(client: CloudTalkClient, callId: string, parts: InsightPart[], transcriptionLimit: number) {
	const out: Record<string, unknown> = { call_id: callId };
	const unavailable: Record<string, string> = {};
	for (const part of [...new Set(parts)]) {
		try {
			const query = part === "transcription" ? { limit: transcriptionLimit } : part === "topics" ? { limit: 50 } : undefined;
			out[part] = (await client.call(PART_OP[part], { path: { callId }, query })).data;
		} catch (e) {
			const info = errorInfo(e);
			if (info.category === "credential" || info.category === "rate_limit") throw e;
			unavailable[part] = info.message;
		}
	}
	if (Object.keys(unavailable).length) out.unavailable = unavailable;
	return out;
}
