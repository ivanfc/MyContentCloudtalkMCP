import { type Operation, isRead, requireOperation, unsupportedReason } from "../cloudtalk/catalog";
import { type CloudTalkClient, collectCorePages } from "../cloudtalk/client";
import { validateCall } from "../cloudtalk/validate";
import { envInt } from "../config";
import { emailProblem, normalizeEmail } from "../util/email";
import { type PlanDraft, type StateCheck, type Step, readState } from "./engine";
import { assessRisk, hardBlocked, stateReadFor } from "./policy";

export class PlanRejected extends Error {
	constructor(
		message: string,
		public details: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "PlanRejected";
	}
	toResult() {
		return { ok: false as const, stage: "guards", message: this.message, ...this.details, note: "No se ha creado ningún plan ni se ha cambiado nada." };
	}
}

export interface Limits {
	maxSmsRecipients: number;
	maxSmsChars: number;
}

export function limitsFrom(env: Record<string, unknown>): Limits {
	return { maxSmsRecipients: envInt(env, "MAX_SMS_RECIPIENTS_PER_PLAN", 20), maxSmsChars: envInt(env, "MAX_SMS_CHARS", 1600) };
}

const json = (v: unknown, max = 1200) => {
	const s = JSON.stringify(v ?? null);
	return s.length > max ? `${s.slice(0, max)}…` : s;
};

/* ============================== Teléfonos ============================== */

const E164 = /^\+[1-9]\d{6,14}$/;

/** "+34 600 12 34 56" → "+34600123456". undefined si no es E.164. */
export function normalizePhone(raw: string): string | undefined {
	const s = String(raw ?? "").trim().replace(/[\s().-]/g, "");
	const withPlus = s.startsWith("00") ? `+${s.slice(2)}` : s;
	return E164.test(withPlus) ? withPlus : undefined;
}

const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");

/* ============================== Genérico ============================== */

export interface ApiCallArgs {
	operation: string;
	path_params?: Record<string, string | number>;
	query?: Record<string, unknown>;
	body?: unknown;
	allow_undocumented_fields?: boolean;
}

/** Comprobaciones comunes de una escritura: existe, es escritura, se puede ejecutar, no está bloqueada y valida contra el esquema. */
export function checkWrite(op: Operation, args: ApiCallArgs, env: Record<string, unknown>) {
	if (isRead(op)) throw new PlanRejected(`${op.id} es de solo lectura: usa api_read (no necesita plan).`);
	const unsupported = unsupportedReason(op);
	if (unsupported) throw new PlanRejected(`${op.id}: ${unsupported}`);
	const blocked = hardBlocked(op, env as { HARD_BLOCKED_OPERATIONS?: string });
	if (blocked) throw new PlanRejected(blocked);
	const v = validateCall(op, { path_params: args.path_params, query: args.query, body: args.body }, !!args.allow_undocumented_fields);
	if (v.errors.length) throw new PlanRejected(`Los datos no cumplen el esquema oficial de ${op.id}. Corrígelos (describe_api_operation("${op.id}") da los campos exactos).`, { errors: v.errors });
	return v;
}

/** Lee el estado del objeto que se va a tocar (si aplica): ANTES para el resumen y hash para apply_plan. */
async function stateFor(client: CloudTalkClient, op: Operation, path: Record<string, string>): Promise<{ checks: StateCheck[]; before?: unknown; warnings: string[] }> {
	const read = stateReadFor(op, path);
	if (!read) return { checks: [], warnings: op.method === "PUT" && /_add$/.test(op.id) ? [] : op.path_params.length ? ["Esta operación no tiene lectura de estado asociada: apply_plan no podrá detectar cambios hechos entretanto."] : [] };
	const label = `${read.op}${read.path ? ` ${Object.values(read.path).join("/")}` : ""}${read.query?.id ? ` id=${read.query.id}` : ""}`;
	const { snapshot, hash } = await readState(client, read);
	if (snapshot === null || snapshot === undefined) throw new PlanRejected(`No existe el objeto a modificar (${label}). Comprueba el ID con una lectura antes de planificar.`);
	return { checks: [{ read, label, hash }], before: snapshot, warnings: [] };
}

export async function buildApiCallPlan(client: CloudTalkClient, env: Record<string, unknown>, args: ApiCallArgs): Promise<PlanDraft> {
	const op = requireOperation(args.operation);
	const v = checkWrite(op, args, env);
	const st = await stateFor(client, op, v.path);
	const risk = assessRisk(op, args.body, st.before);
	const summary = [
		`Operación: ${op.id} · ${op.summary}`,
		`${op.method} ${op.host}${op.path}`,
		...(Object.keys(v.path).length ? [`Parámetros de ruta: ${json(v.path, 300)}`] : []),
		...(Object.keys(v.query).length ? [`Consulta: ${json(v.query, 300)}`] : []),
		...(st.before !== undefined ? [`ANTES: ${json(st.before)}`] : []),
		...(args.body !== undefined ? [`${st.before !== undefined ? "DESPUÉS (campos enviados)" : "Datos enviados"}: ${json(args.body)}`] : []),
	];
	const step: Step = { op: op.id, label: op.summary, ...(Object.keys(v.path).length ? { path: v.path } : {}), ...(Object.keys(v.query).length ? { query: v.query } : {}), ...(args.body !== undefined ? { body: args.body } : {}) };
	return {
		kind: op.id,
		summary,
		warnings: [...v.warnings.map((w) => `Campo no documentado (enviado igualmente por allow_undocumented_fields): ${w}`), ...risk.warnings, ...st.warnings],
		elevated: risk.elevated,
		outreach: risk.outreach,
		action: { type: "api_calls", steps: [step], continueOnError: false, stateChecks: st.checks },
	};
}

/* ============================== Contactos ============================== */

export interface ContactFields {
	name?: string;
	title?: string;
	company?: string;
	industry?: string;
	website?: string;
	address?: string;
	city?: string;
	zip?: string;
	state?: string;
	country_id?: number;
	favorite_agent?: number;
}

const SCALARS: (keyof ContactFields)[] = ["name", "title", "company", "industry", "website", "address", "city", "zip", "state", "country_id", "favorite_agent"];

function phonesOrReject(list: string[] | undefined, field: string): string[] {
	const bad: string[] = [];
	const out: string[] = [];
	for (const raw of list ?? []) {
		const p = normalizePhone(raw);
		if (!p) bad.push(String(raw).slice(0, 40));
		else if (!out.includes(p)) out.push(p);
	}
	if (bad.length) throw new PlanRejected(`${field}: números no válidos (deben ir en formato internacional E.164, p. ej. +34600123456): ${bad.join(", ")}`);
	return out;
}

function emailsOrReject(list: string[] | undefined, field: string): string[] {
	const bad = (list ?? []).filter((e) => emailProblem(e));
	if (bad.length) throw new PlanRejected(`${field}: emails no válidos: ${bad.map((e) => String(e).slice(0, 60)).join(", ")}`);
	return [...new Set((list ?? []).map(normalizeEmail))];
}

/** Contactos existentes que ya tienen alguno de estos teléfonos (búsqueda por keyword; máx. 3 búsquedas). */
async function findByPhones(client: CloudTalkClient, phones: string[]) {
	const hits: { phone: string; contacts: { id: string; name: string }[] }[] = [];
	for (const p of phones.slice(0, 3)) {
		const r = await client.call("contacts_index", { query: { keyword: digits(p), limit: 5 } });
		const items = ((r.data as { data?: { Contact?: { id: string; name: string } }[] })?.data ?? []).map((x) => x.Contact).filter(Boolean) as { id: string; name: string }[];
		if (items.length) hits.push({ phone: p, contacts: items.map((c) => ({ id: String(c.id), name: c.name })) });
	}
	return hits;
}

export interface CreateContactArgs extends ContactFields {
	name: string;
	phones?: string[];
	emails?: string[];
	tags?: string[];
	attributes?: { attribute_id: number; value: string }[];
	external_urls?: { name: string; url: string }[];
	allow_duplicate?: boolean;
}

export async function buildCreateContactPlan(client: CloudTalkClient, env: Record<string, unknown>, a: CreateContactArgs): Promise<PlanDraft> {
	const phones = phonesOrReject(a.phones, "phones");
	const emails = emailsOrReject(a.emails, "emails");
	const body: Record<string, unknown> = {};
	for (const k of SCALARS) if (a[k] !== undefined && a[k] !== "") body[k] = a[k];
	if (phones.length) body.ContactNumber = phones.map((public_number) => ({ public_number }));
	if (emails.length) body.ContactEmail = emails.map((email) => ({ email }));
	if (a.tags?.length) body.ContactsTag = [...new Set(a.tags.map((t) => t.trim()).filter(Boolean))].map((name) => ({ name }));
	if (a.attributes?.length) body.ContactAttribute = a.attributes;
	if (a.external_urls?.length) body.ExternalUrl = a.external_urls;
	const op = requireOperation("contacts_add");
	checkWrite(op, { operation: op.id, body }, env);
	const dupes = phones.length ? await findByPhones(client, phones) : [];
	if (dupes.length && !a.allow_duplicate)
		throw new PlanRejected("Ya existe(n) contacto(s) con ese teléfono en CloudTalk. Para modificarlo usa plan_update_contact; para crear otro igualmente, repite con allow_duplicate=true.", { existing: dupes });
	return {
		kind: "contacts_add",
		summary: [`Crear contacto "${a.name}"${a.company ? ` (${a.company})` : ""}`, ...(phones.length ? [`Teléfonos: ${phones.join(", ")}`] : []), ...(emails.length ? [`Emails: ${emails.join(", ")}`] : []), ...(a.tags?.length ? [`Etiquetas: ${a.tags.join(", ")}`] : []), `Datos enviados: ${json(body)}`],
		warnings: [...(dupes.length ? [`Se crea a pesar de que ya hay contactos con ese teléfono: ${json(dupes, 400)}`] : []), ...(phones.length > 3 ? ["Solo se comprobaron duplicados de los 3 primeros teléfonos."] : [])],
		action: { type: "api_calls", steps: [{ op: op.id, label: `Crear contacto ${a.name}`, body }], continueOnError: false, stateChecks: [] },
	};
}

export interface UpdateContactArgs extends ContactFields {
	contact_id: number;
	add_phones?: string[];
	remove_phones?: string[];
	add_emails?: string[];
	remove_emails?: string[];
	add_tags?: string[];
	remove_tags?: string[];
}

interface ContactShow {
	Contact?: Record<string, unknown>;
	ContactNumber?: { public_number?: string | number }[];
	ContactEmail?: { email?: string }[];
	ContactsTag?: { name?: string }[];
}

/**
 * Modificación segura de un contacto: lee el actual y FUSIONA teléfonos y emails (CloudTalk reemplaza esas listas
 * completas en edit). Las etiquetas van por sus endpoints propios (añadir/quitar) para no tocar las demás.
 */
export async function buildUpdateContactPlan(client: CloudTalkClient, env: Record<string, unknown>, a: UpdateContactArgs): Promise<PlanDraft> {
	const contactId = String(a.contact_id);
	const addPhones = phonesOrReject(a.add_phones, "add_phones");
	const removePhones = phonesOrReject(a.remove_phones, "remove_phones");
	const addEmails = emailsOrReject(a.add_emails, "add_emails");
	const removeEmails = emailsOrReject(a.remove_emails, "remove_emails");
	const read = { op: "contacts_show", path: { contactId } };
	const { snapshot, hash } = await readState(client, read);
	const cur = (snapshot ?? {}) as ContactShow;
	if (!cur.Contact) throw new PlanRejected(`No existe el contacto ${contactId} en tu cuenta de CloudTalk.`);
	const curPhones = (cur.ContactNumber ?? []).map((n) => `+${digits(n.public_number)}`).filter((p) => p !== "+");
	const curEmails = (cur.ContactEmail ?? []).map((e) => normalizeEmail(e.email ?? "")).filter(Boolean);
	const curTags = (cur.ContactsTag ?? []).map((t) => String(t.name ?? "")).filter(Boolean);

	const body: Record<string, unknown> = {};
	const changes: string[] = [];
	for (const k of SCALARS) {
		if (a[k] === undefined) continue;
		const before = cur.Contact[k];
		if (String(before ?? "") === String(a[k])) continue;
		body[k] = a[k];
		changes.push(`${k}: "${String(before ?? "")}" → "${String(a[k])}"`);
	}
	const missingPhones = removePhones.filter((p) => !curPhones.includes(p));
	const missingEmails = removeEmails.filter((e) => !curEmails.includes(e));
	const newPhones = [...curPhones.filter((p) => !removePhones.includes(p)), ...addPhones.filter((p) => !curPhones.includes(p))];
	const newEmails = [...curEmails.filter((e) => !removeEmails.includes(e)), ...addEmails.filter((e) => !curEmails.includes(e))];
	if (newPhones.join() !== curPhones.join()) {
		body.ContactNumber = newPhones.map((public_number) => ({ public_number }));
		changes.push(`Teléfonos: [${curPhones.join(", ")}] → [${newPhones.join(", ")}]`);
	}
	if (newEmails.join() !== curEmails.join()) {
		body.ContactEmail = newEmails.map((email) => ({ email }));
		changes.push(`Emails: [${curEmails.join(", ")}] → [${newEmails.join(", ")}]`);
	}
	const addTags = [...new Set((a.add_tags ?? []).map((t) => t.trim()).filter((t) => t && !curTags.includes(t)))];
	const removeTags = [...new Set((a.remove_tags ?? []).map((t) => t.trim()).filter((t) => t && curTags.includes(t)))];
	const steps: Step[] = [];
	if (Object.keys(body).length) {
		checkWrite(requireOperation("contacts_edit"), { operation: "contacts_edit", path_params: { contactId }, body }, env);
		steps.push({ op: "contacts_edit", label: `Editar contacto ${contactId}`, path: { contactId }, body });
	}
	if (addTags.length) {
		steps.push({ op: "contacts_add_tags", label: `Añadir etiquetas a ${contactId}`, path: { contactId }, body: { tags: addTags } });
		changes.push(`Añadir etiquetas: ${addTags.join(", ")}`);
	}
	if (removeTags.length) {
		steps.push({ op: "contacts_remove_tags", label: `Quitar etiquetas a ${contactId}`, path: { contactId }, body: { tags: removeTags } });
		changes.push(`Quitar etiquetas: ${removeTags.join(", ")}`);
	}
	const ignored = [
		...missingPhones.map((p) => `El teléfono ${p} no estaba en el contacto (no se quita nada).`),
		...missingEmails.map((e) => `El email ${e} no estaba en el contacto (no se quita nada).`),
		...(a.add_tags ?? []).filter((t) => curTags.includes(t.trim())).map((t) => `La etiqueta "${t}" ya estaba.`),
		...(a.remove_tags ?? []).filter((t) => !curTags.includes(t.trim())).map((t) => `La etiqueta "${t}" no estaba.`),
	];
	if (!steps.length) throw new PlanRejected("No hay nada que cambiar: el contacto ya está así.", { ignored });
	return {
		kind: "contact_update",
		summary: [`Contacto ${contactId}: "${String(cur.Contact.name ?? "")}"${cur.Contact.company ? ` (${String(cur.Contact.company)})` : ""}`, ...changes],
		warnings: ignored,
		action: { type: "api_calls", steps, continueOnError: false, stateChecks: [{ read, label: `contacto ${contactId}`, hash }] },
	};
}

/* ============================== SMS / WhatsApp ============================== */

export interface SendSmsArgs {
	sender: string;
	recipients: string[];
	message: string;
	channel?: "sms" | "whatsapp";
	country_code?: string;
	images_by_url?: string[];
	file_by_url?: string;
}

interface CallNumberItem {
	CallNumber?: { id?: string; caller_id_e164?: string | number; internal_name?: string };
}

export async function buildSendSmsPlan(client: CloudTalkClient, env: Record<string, unknown>, limits: Limits, a: SendSmsArgs): Promise<PlanDraft> {
	const sender = normalizePhone(a.sender);
	if (!sender) throw new PlanRejected("sender: el remitente debe ser un número de tu cuenta en formato E.164 (p. ej. +34910000000).");
	const recipients = phonesOrReject(a.recipients, "recipients");
	if (!recipients.length) throw new PlanRejected("recipients: indica al menos un destinatario.");
	if (recipients.length > limits.maxSmsRecipients) throw new PlanRejected(`Máximo ${limits.maxSmsRecipients} destinatarios por plan (hay ${recipients.length}). Divide el envío.`);
	const message = String(a.message ?? "");
	if (!message.trim()) throw new PlanRejected("message: el mensaje está vacío.");
	if (message.length > limits.maxSmsChars) throw new PlanRejected(`message: máximo ${limits.maxSmsChars} caracteres (tiene ${message.length}).`);
	for (const u of [...(a.images_by_url ?? []), ...(a.file_by_url ? [a.file_by_url] : [])]) if (!/^https:\/\/[^\s]+$/i.test(u)) throw new PlanRejected(`URL de adjunto no válida (solo https): ${u.slice(0, 80)}`);

	// El remitente tiene que ser un número de la propia cuenta.
	const nums = await collectCorePages<CallNumberItem>(client, "numbers_index", {}, 1000, 2);
	const own = nums.items.map((n) => n.CallNumber).filter(Boolean);
	const match = own.find((n) => digits(n!.caller_id_e164) === digits(sender));
	if (!match) throw new PlanRejected(`El remitente ${sender} no es un número de tu cuenta de CloudTalk.`, { account_numbers: own.slice(0, 50).map((n) => ({ id: n!.id, number: `+${digits(n!.caller_id_e164)}`, name: n!.internal_name })) });

	const wa = a.channel === "whatsapp";
	const pre = (p: string) => (wa ? `whatsapp:${p}` : p);
	const steps: Step[] = recipients.map((r) => {
		const body: Record<string, unknown> = { sender: pre(sender), recipient: pre(r), message };
		if (a.country_code) body.country_code = a.country_code;
		if (a.images_by_url?.length) body.images_by_url = a.images_by_url;
		if (a.file_by_url) body.file_by_url = a.file_by_url;
		return { op: "sms_send", label: `${wa ? "WhatsApp" : "SMS"} a ${r}`, body };
	});
	checkWrite(requireOperation("sms_send"), { operation: "sms_send", body: steps[0].body }, env);
	const segments = Math.ceil(message.length / (/[^\x00-\x7f]/.test(message) ? 67 : 153));
	return {
		kind: wa ? "whatsapp_send" : "sms_send",
		summary: [
			`${wa ? "WhatsApp" : "SMS"} desde ${sender}${match.internal_name ? ` (${match.internal_name})` : ""} a ${recipients.length} destinatario(s): ${recipients.join(", ")}`,
			`Mensaje (${message.length} caracteres${!wa && message.length > 160 ? `, ~${segments} segmentos por SMS` : ""}): ${message.slice(0, 500)}`,
			...(a.images_by_url?.length ? [`Imágenes: ${a.images_by_url.join(", ")}`] : []),
			...(a.file_by_url ? [`Fichero: ${a.file_by_url}`] : []),
		],
		warnings: [
			...(wa ? ["WhatsApp: fuera de la ventana de 24 h de conversación, WhatsApp solo admite plantillas aprobadas; CloudTalk devolverá el error del proveedor."] : []),
			"Cada destinatario es un envío independiente: si uno falla, los demás siguen (el resultado lista cada uno).",
		],
		elevated: [`Envía ${recipients.length} ${wa ? "WhatsApp" : "SMS"} real(es) a terceros, con coste por mensaje.`],
		outreach: recipients.length,
		action: { type: "api_calls", steps, continueOnError: true, stateChecks: [] },
	};
}

/* ============================== Llamada (click-to-call) ============================== */

interface AgentItem {
	Agent?: { id?: string; firstname?: string; lastname?: string; availability_status?: string; status_outbound?: boolean; default_number?: string };
}

export async function buildMakeCallPlan(client: CloudTalkClient, env: Record<string, unknown>, a: { agent_id: number; callee_number: string }): Promise<PlanDraft> {
	const callee = normalizePhone(a.callee_number);
	if (!callee) throw new PlanRejected("callee_number: debe ir en formato E.164 (p. ej. +34600123456).");
	const r = await client.call("agents_index", { query: { id: a.agent_id, limit: 1 } });
	const agent = ((r.data as { data?: AgentItem[] })?.data ?? []).map((x) => x.Agent).find((x) => String(x?.id) === String(a.agent_id));
	if (!agent) throw new PlanRejected(`No existe el agente ${a.agent_id} en tu cuenta de CloudTalk.`);
	if (agent.status_outbound === false) throw new PlanRejected(`El agente ${agent.firstname ?? ""} ${agent.lastname ?? ""} no tiene permitidas las llamadas salientes.`);
	const body = { agent_id: Number(a.agent_id), callee_number: callee };
	checkWrite(requireOperation("calls_create"), { operation: "calls_create", body }, env);
	const status = agent.availability_status ?? "desconocido";
	return {
		kind: "calls_create",
		summary: [`Llamar a ${callee} desde el agente ${agent.firstname ?? ""} ${agent.lastname ?? ""} (id ${agent.id}, estado ${status}${agent.default_number ? `, número saliente ${agent.default_number}` : ""})`, "CloudTalk llama primero al agente (espera máx. 20 s) y, cuando descuelga, marca el número."],
		warnings: [...(status !== "online" ? [`El agente está "${status}": CloudTalk rechaza la llamada si no está online.`] : []), ...assessRisk(requireOperation("calls_create"), body).warnings],
		outreach: 1,
		action: { type: "api_calls", steps: [{ op: "calls_create", label: `Llamada a ${callee}`, body }], continueOnError: false, stateChecks: [] },
	};
}
