import { describe, expect, it } from "vitest";
import { CATALOG, requireOperation } from "../src/cloudtalk/catalog";
import { PlanRejected, buildApiCallPlan, buildCreateContactPlan, buildMakeCallPlan, buildSendSmsPlan, buildUpdateContactPlan, limitsFrom, normalizePhone } from "../src/plans/builders";
import { applyPlan, cancelPlan, listPendingPlans, loadPlan, savePlan } from "../src/plans/engine";
import { assessRisk } from "../src/plans/policy";
import { CFG, FakeCloudTalk, MemoryKV, MemoryQuota, makeDeps } from "./helpers";

const env = {};
const plan = async (fake: FakeCloudTalk, deps: ReturnType<typeof makeDeps>, args: Parameters<typeof buildApiCallPlan>[2]) => savePlan(deps, await buildApiCallPlan(deps.client, env, args));

describe("barreras por operación", () => {
	const risk = (id: string, body?: unknown) => assessRisk(requireOperation(id), body);
	it("borrados y acciones de alto impacto exigen APPLY-ELEVATED", () => {
		for (const id of ["contacts_delete", "agents_delete", "recordings_delete", "numbers_clear", "numbers_edit", "agents_add", "sms_send", "create_voice_agent_call", "create_webhook_endpoint", "rotate_webhook_endpoint_secret", "delete_voice_agent", "dialer_delete_campaign", "tags_delete", "blacklist_delete"])
			expect(risk(id).elevated.length, id).toBeGreaterThan(0);
	});
	it("la lista de operaciones siempre reforzadas coincide con API-COVERAGE.md (scripts/coverage-md.mjs)", () => {
		const always = CATALOG.operations.filter((o) => o.method !== "GET" && assessRisk(o, {}).elevated.length).map((o) => o.id).sort();
		expect(always).toEqual(["activity_delete", "agents_add", "agents_delete", "blacklist_delete", "campaigns_delete", "contacts_delete", "create_voice_agent_call", "create_webhook_endpoint", "delete_knowledge_base", "delete_voice_agent", "delete_webhook_endpoint", "dialer_delete_campaign", "notes_delete", "numbers_clear", "numbers_edit", "recordings_delete", "rotate_webhook_endpoint_secret", "sms_send", "tags_delete", "upload_knowledge_base_file"]);
	});
	it("cambios corrientes y desvinculaciones van con APPLY normal", () => {
		for (const id of ["contacts_add", "contacts_edit", "contacts_remove_tags", "groups_delete", "notes_add", "tags_add", "dialer_create_script", "dialer_archive_script", "detach_voice_agent_knowledge_base", "calls_create", "kill_voice_agent_outbound", "cuecards_create", "blacklist_add"])
			expect(risk(id).elevated, id).toEqual([]);
	});
	it("depende del body donde importa", () => {
		expect(risk("dialer_patch_campaign", { status: "active" }).elevated.join()).toMatch(/marcación/);
		expect(risk("dialer_patch_campaign", { name: "x" }).elevated).toEqual([]);
		const before = { Agent: { email: "ana@x.com", status_outbound: true } };
		expect(risk("agents_edit", { email: "ana@x.com", firstname: "A", lastname: "B", daily_price_limit: 200 }).elevated).toHaveLength(1);
		expect(assessRisk(requireOperation("agents_edit"), { email: "ANA@x.com", firstname: "A", lastname: "B" }, before).elevated).toEqual([]);
		expect(assessRisk(requireOperation("agents_edit"), { email: "otra@x.com", firstname: "A", lastname: "B" }, before).elevated.join()).toMatch(/email/);
		expect(assessRisk(requireOperation("agents_edit"), { email: "ana@x.com", firstname: "A", lastname: "B", status_outbound: false }, before).elevated.join()).toMatch(/status_outbound/);
		expect(risk("bulk_contacts", [{ action: "add_contact" }, { action: "delete_contact" }]).elevated.join()).toMatch(/1 borrado/);
		expect(risk("contacts_edit", { ContactNumber: [] }).warnings.join()).toMatch(/reemplaza/);
		expect(risk("update_webhook_endpoint", { description: "x" }).elevated).toEqual([]);
		expect(risk("update_webhook_endpoint", { url: "https://x" }).elevated).toHaveLength(1);
		expect(risk("calls_create").outreach).toBe(1);
	});
});

describe("plan_api_call", () => {
	it("crea un plan validado, lo aplica una sola vez y audita sin valores", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		const p = await plan(fake, deps, { operation: "contacts_add", body: { name: "Nuevo", company: "Beta", ContactNumber: [{ public_number: "+34600999888" }] } });
		expect(p).toMatchObject({ ok: true, confirm_with: `APPLY ${p.plan_id}`, elevated: [] });
		expect(fake.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
		expect((await applyPlan(deps, p.plan_id, `APPLY-ELEVATED ${p.plan_id}`)).ok).toBe(false);
		const r = await applyPlan(deps, p.plan_id, `APPLY ${p.plan_id}`);
		expect(r).toMatchObject({ ok: true, outcome: "APPLIED", results: [{ outcome: "DONE", created_id: "101" }] });
		expect((await applyPlan(deps, p.plan_id, `APPLY ${p.plan_id}`)).ok).toBe(false);
		const audit = [...deps.kv.store.entries()].find(([k]) => k.startsWith("audit:"))![1].value;
		expect(audit).toContain("contacts_add");
		expect(audit).toContain('"body_fields":["name","company","ContactNumber"]');
		expect(audit).not.toContain("34600999888");
		expect(audit).not.toContain("Beta");
	});

	it("rechaza lecturas, campos inventados, operaciones no ejecutables y bloqueadas", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		await expect(buildApiCallPlan(deps.client, env, { operation: "calls_index" })).rejects.toThrow(/solo lectura: usa api_read/);
		await expect(buildApiCallPlan(deps.client, env, { operation: "tags_add", body: { name: "x", color: "red" } })).rejects.toMatchObject({ details: { errors: [expect.stringMatching(/body\.color/)] } });
		await expect(buildApiCallPlan(deps.client, env, { operation: "upload_knowledge_base_file", body: {} })).rejects.toThrow(/plan_upload_knowledge_base_file/);
		await expect(buildApiCallPlan(deps.client, { HARD_BLOCKED_OPERATIONS: "sms_send" }, { operation: "sms_send", body: { sender: "+1", recipient: "+2", message: "x" } })).rejects.toThrow(/bloqueada/);
		await expect(buildApiCallPlan(deps.client, { HARD_BLOCKED_OPERATIONS: "tag:Webhooks" }, { operation: "create_webhook_endpoint", body: { url: "https://x.com" } })).rejects.toThrow(/bloqueada/);
	});

	it("lee el estado ANTES, exige refuerzo en borrados y aborta si el objeto cambió", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		const p = await plan(fake, deps, { operation: "contacts_delete", path_params: { contactId: 100 } });
		expect(p.confirm_with).toBe(`APPLY-ELEVATED ${p.plan_id}`);
		expect(p.summary.join("\n")).toMatch(/ANTES: .*Cliente Uno/);
		fake.contacts.get("100")!.Contact.name = "Cambiado por otro";
		const r = await applyPlan(deps, p.plan_id, p.confirm_with);
		expect(r).toMatchObject({ ok: false, outcome: "ABORTED_STATE_CHANGED" });
		expect(fake.contacts.has("100")).toBe(true);
		expect(await loadPlan(deps, p.plan_id)).toBeUndefined();
	});

	it("rechaza planificar sobre un objeto inexistente", async () => {
		const fake = new FakeCloudTalk();
		await expect(plan(fake, makeDeps(fake), { operation: "numbers_edit", path_params: { id: 999 }, body: { internal_name: "x" } })).rejects.toThrow(/No existe el objeto/);
	});

	it("los cambios de presencia del agente no invalidan el plan", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		const p = await plan(fake, deps, { operation: "agents_edit", path_params: { agentId: 1 }, body: { firstname: "Anabel", lastname: "López", email: "ana@x.com" } });
		expect(p.elevated).toEqual([]);
		fake.agents[0].availability_status = "busy";
		fake.override["POST /api/agents/edit/1.json"] = () => Response.json({ responseData: { status: 200 } });
		expect(await applyPlan(deps, p.plan_id, p.confirm_with)).toMatchObject({ ok: true });
	});

	it("Dialer v1: activar exige refuerzo y aplica el PATCH", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		const p = await plan(fake, deps, { operation: "dialer_patch_campaign", path_params: { campaignId: 42 }, body: { status: "active" } });
		expect(p.elevated.join()).toMatch(/marcación/);
		expect(await applyPlan(deps, p.plan_id, p.confirm_with)).toMatchObject({ ok: true });
		expect(fake.dialerCampaigns.get("42")!.status).toBe("active");
	});

	it("un error de red tras enviar una escritura queda como UNKNOWN y no se reintenta", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		const p = await plan(fake, deps, { operation: "tags_add", body: { name: "Nueva" } });
		fake.override["PUT /api/tags/add.json"] = () => {
			throw new TypeError("network");
		};
		const r = await applyPlan(deps, p.plan_id, p.confirm_with);
		expect(r).toMatchObject({ ok: false, outcome: "UNKNOWN", results: [{ outcome: "UNKNOWN" }] });
		expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
	});

	it("aislamiento: otro usuario u otra clave no ven ni aplican el plan", async () => {
		const fake = new FakeCloudTalk();
		const kv = new MemoryKV();
		const a = makeDeps(fake, { kv, user: "userA" });
		const p = await plan(fake, a, { operation: "tags_add", body: { name: "X" } });
		const b = makeDeps(fake, { kv, user: "userB" });
		expect(await loadPlan(b, p.plan_id)).toBeUndefined();
		expect((await applyPlan(b, p.plan_id, p.confirm_with)).ok).toBe(false);
		const otherKey = makeDeps(fake, { kv, user: "userA", secret: "otra" });
		expect(await loadPlan(otherKey, p.plan_id)).toBeUndefined();
		expect(await listPendingPlans(a)).toHaveLength(1);
		expect((await cancelPlan(a, p.plan_id)).ok).toBe(true);
		expect(await listPendingPlans(a)).toHaveLength(0);
	});

	it("sin cuota no aplica y el plan sigue pendiente", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake, { quota: new MemoryQuota({ user: { calls: 10_000, outreach: 0 }, global: CFG.global }) });
		const p = await savePlan(deps, await buildMakeCallPlan(deps.client, env, { agent_id: 1, callee_number: "+34600111222" }));
		const r = await applyPlan(deps, p.plan_id, p.confirm_with);
		expect(r.message).toMatch(/límite diario de contactos salientes/);
		expect(await loadPlan(deps, p.plan_id)).toBeDefined();
	});
});

describe("plan_create_contact / plan_update_contact", () => {
	it("normaliza teléfonos E.164 y detecta duplicados por teléfono", async () => {
		expect(normalizePhone("+34 600 11 12 22")).toBe("+34600111222");
		expect(normalizePhone("0034600111222")).toBe("+34600111222");
		expect(normalizePhone("600111222")).toBeUndefined();
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		await expect(buildCreateContactPlan(deps.client, env, { name: "Otro", phones: ["600111222"] })).rejects.toThrow(/E\.164/);
		await expect(buildCreateContactPlan(deps.client, env, { name: "Dup", phones: ["+34 600 111 222"] })).rejects.toMatchObject({ details: { existing: [{ phone: "+34600111222", contacts: [{ id: "100" }] }] } });
		const d = await buildCreateContactPlan(deps.client, env, { name: "Dup", phones: ["+34600111222"], allow_duplicate: true, tags: ["Lead"] });
		expect(d.action.steps[0].body).toMatchObject({ name: "Dup", ContactNumber: [{ public_number: "+34600111222" }], ContactsTag: [{ name: "Lead" }] });
	});

	it("fusiona teléfonos/emails y usa los endpoints de etiquetas", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		const p = await savePlan(deps, await buildUpdateContactPlan(deps.client, env, { contact_id: 100, company: "ACME SL", add_phones: ["+34600333444"], add_emails: ["dos@acme.com"], add_tags: ["Cliente"], remove_tags: ["VIP"] }));
		expect(p.summary.join("\n")).toMatch(/company: "ACME" → "ACME SL"/);
		expect(p.summary.join("\n")).toMatch(/Teléfonos: \[\+34600111222\] → \[\+34600111222, \+34600333444\]/);
		expect(p.api_calls.map((c) => c.operation)).toEqual(["contacts_edit", "contacts_add_tags", "contacts_remove_tags"]);
		expect(await applyPlan(deps, p.plan_id, p.confirm_with)).toMatchObject({ ok: true });
		const c = fake.contacts.get("100")!;
		expect(c.ContactNumber.map((n) => n.public_number)).toEqual([34600111222, 34600333444]);
		expect(c.ContactEmail.map((e) => e.email)).toEqual(["uno@acme.com", "dos@acme.com"]);
		expect(c.ContactsTag.map((t) => t.name)).toEqual(["Cliente"]);
	});

	it("no crea planes vacíos y avisa de lo que no aplica", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		await expect(buildUpdateContactPlan(deps.client, env, { contact_id: 100, company: "ACME", add_tags: ["VIP"] })).rejects.toThrow(/nada que cambiar/);
		await expect(buildUpdateContactPlan(deps.client, env, { contact_id: 555, company: "X" })).rejects.toMatchObject({ category: "not_found" });
	});
});

describe("plan_send_sms / plan_make_call", () => {
	it("el remitente debe ser de la cuenta; refuerzo, uno por destinatario y resultados individuales", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		const limits = limitsFrom({});
		await expect(buildSendSmsPlan(deps.client, env, limits, { sender: "+34911111111", recipients: ["+34600000001"], message: "Hola" })).rejects.toMatchObject({ details: { account_numbers: [{ id: "10", number: "+34910000001" }] } });
		const p = await savePlan(deps, await buildSendSmsPlan(deps.client, env, limits, { sender: "+34 910 000 001", recipients: ["+34600000001", "+34600000999", "+34600000001"], message: "Hola" }));
		expect(p.confirm_with).toMatch(/^APPLY-ELEVATED/);
		expect(p.api_calls).toHaveLength(2);
		const r = await applyPlan(deps, p.plan_id, p.confirm_with);
		expect(r).toMatchObject({ ok: false, outcome: "PARTIAL", results: [{ outcome: "DONE" }, { outcome: "FAILED", error: { code: "SMS_FAILED" } }] });
		const audit = [...deps.kv.store.entries()].find(([k]) => k.startsWith("audit:"))![1].value;
		expect(audit).not.toMatch(/34600000001|Hola/);
	});

	it("WhatsApp lleva el prefijo en remitente y destinatario", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		const d = await buildSendSmsPlan(deps.client, env, limitsFrom({}), { sender: "+34910000001", recipients: ["+34600000001"], message: "Hola", channel: "whatsapp" });
		expect(d.action.steps[0].body).toMatchObject({ sender: "whatsapp:+34910000001", recipient: "whatsapp:+34600000001" });
	});

	it("respeta el máximo de destinatarios", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		const many = Array.from({ length: 3 }, (_, i) => `+3460000000${i}`);
		await expect(buildSendSmsPlan(deps.client, env, { maxSmsRecipients: 2, maxSmsChars: 1600 }, { sender: "+34910000001", recipients: many, message: "x" })).rejects.toThrow(/Máximo 2 destinatarios/);
	});

	it("llamada: agente existente con salientes; avisa si no está online", async () => {
		const fake = new FakeCloudTalk();
		const deps = makeDeps(fake);
		await expect(buildMakeCallPlan(deps.client, env, { agent_id: 99, callee_number: "+34600111222" })).rejects.toThrow(/No existe el agente/);
		await expect(buildMakeCallPlan(deps.client, env, { agent_id: 3, callee_number: "+34600111222" })).rejects.toThrow(/no tiene permitidas/);
		const off = await buildMakeCallPlan(deps.client, env, { agent_id: 2, callee_number: "+34600111222" });
		expect(off.warnings!.join()).toMatch(/offline/);
		const p = await savePlan(deps, await buildMakeCallPlan(deps.client, env, { agent_id: 1, callee_number: "+34600111222" }));
		expect(p.confirm_with).toMatch(/^APPLY p_/);
		expect(await applyPlan(deps, p.plan_id, p.confirm_with)).toMatchObject({ ok: true });
		expect(fake.calls.at(-1)).toMatchObject({ method: "POST", body: { agent_id: 1, callee_number: "+34600111222" } });
	});

	it("PlanRejected se devuelve como resultado sin plan", () => {
		expect(new PlanRejected("x", { a: 1 }).toResult()).toMatchObject({ ok: false, stage: "guards", a: 1 });
	});
});
