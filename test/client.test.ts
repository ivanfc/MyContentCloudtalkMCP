import { describe, expect, it } from "vitest";
import { requireOperation } from "../src/cloudtalk/catalog";
import { CloudTalkClient, buildUrl, collectCorePages, collectCursorPages } from "../src/cloudtalk/client";
import { CloudTalkError } from "../src/cloudtalk/errors";
import { FakeCloudTalk } from "./helpers";

describe("cliente CloudTalk", () => {
	it("usa Basic Auth con ID:secreto, el host del catálogo y quita el sobre responseData", async () => {
		const fake = new FakeCloudTalk();
		const r = await fake.client().call("agents_index", { query: { limit: 2 } });
		expect(fake.calls[0].url).toBe("https://my.cloudtalk.io/api/agents/index.json?limit=2");
		expect(fake.calls[0].auth).toBe(`Basic ${btoa("KEYID123456:SECRET_abcdef123")}`);
		expect(r.data).toMatchObject({ itemsCount: 3, data: [{ Agent: { id: "1" } }, { Agent: { id: "2" } }] });
		expect(r.rate).toEqual({ limit: 60, remaining: 59 });
	});

	it("enruta cada API a su host (analytics, v1)", () => {
		expect(buildUrl(requireOperation("calls_details"), { path: { callId: 7 } })).toBe("https://analytics-api.cloudtalk.io/api/calls/7");
		expect(buildUrl(requireOperation("dialer_get_campaign"), { path: { campaignId: "42" } })).toBe("https://api.cloudtalk.io/v1/dialer/campaigns/42");
		expect(() => buildUrl(requireOperation("contacts_show"), { path: { contactId: "1/../../agents" } })).toThrow(/no es válido/);
		expect(() => buildUrl(requireOperation("contacts_show"), {})).toThrow(/Falta el parámetro de ruta "contactId"/);
	});

	it("clave incorrecta → credential (401)", async () => {
		const fake = new FakeCloudTalk();
		await expect(fake.client({ secret: "otra-clave" }).call("agents_index")).rejects.toMatchObject({ code: "UNAUTHORIZED", category: "credential" });
	});

	it("detecta errores dentro del sobre con HTTP 200 y el SMS con success:false", async () => {
		const fake = new FakeCloudTalk();
		fake.override["POST /api/contacts/edit/100.json"] = () => Response.json({ responseData: { status: 400, message: "Invalid country_id" } });
		await expect(fake.client().call("contacts_edit", { path: { contactId: 100 }, body: { country_id: 999 } })).rejects.toMatchObject({ category: "input", message: expect.stringContaining("Invalid country_id") });
		await expect(fake.client().call("sms_send", { body: { sender: "+34910000001", recipient: "+34600000999", message: "x" } })).rejects.toMatchObject({ code: "SMS_FAILED", message: expect.stringContaining("Unknown number") });
	});

	it("traduce los errores v1 con subErrors y correlationId", async () => {
		const fake = new FakeCloudTalk();
		fake.override["POST /v1/dialer/campaigns"] = () => Response.json({ statusCode: 422, message: "Validation error", subErrors: ["name should not be empty"], correlationId: "Yev" }, { status: 422 });
		const e = (await fake.client().call("dialer_create_campaign", { body: { name: " " } }).catch((x) => x)) as CloudTalkError;
		expect(e.toInfo()).toMatchObject({ category: "input", http_status: 422, details: { sub_errors: ["name should not be empty"], correlation_id: "Yev" } });
	});

	it("429: reintenta una vez las lecturas; nunca las escrituras", async () => {
		const fake = new FakeCloudTalk();
		fake.rateResetAt = Date.now() + 1000;
		const r = await fake.client().call("groups_index");
		expect(fake.calls).toHaveLength(2);
		expect(r.status).toBe(200);
		fake.rateResetAt = Date.now() + 1000;
		await expect(fake.client().call("tags_add", { body: { name: "x" } })).rejects.toMatchObject({ category: "rate_limit", message: expect.stringMatching(/60 peticiones por minuto/) });
		expect(fake.calls).toHaveLength(3);
	});

	it("HTML con 404 → not_found; redirecciones no se siguen", async () => {
		const fake = new FakeCloudTalk();
		fake.override["GET /api/countries/index.json"] = () => new Response("", { status: 302, headers: { location: "https://evil.example" } });
		await expect(fake.client().call("countries_index")).rejects.toMatchObject({ code: "REDIRECT" });
		await expect(fake.client().call("ai_calls_topics", { path: { callId: 1 } })).rejects.toMatchObject({ category: "not_found" });
	});

	it("grabación WAV inválida se rechaza sin repetir la lectura", async () => {
		const fake = new FakeCloudTalk();
		fake.override["GET /api/calls/recording/1.json"] = () => new Response("not-wav", { headers: { "content-type": "audio/x-wav" } });
		await expect(fake.client().call("calls_recording", { path: { callId: 1 } })).rejects.toMatchObject({ code: "BAD_AUDIO" });
		expect(fake.calls).toHaveLength(1);
	});

	it("la cuota se consulta antes de cada petición y puede cortar", async () => {
		const fake = new FakeCloudTalk();
		let n = 0;
		const client = fake.client({ beforeRequest: async () => {
			if (++n > 1) throw new Error("sin cuota");
		} });
		await client.call("groups_index");
		await expect(client.call("groups_index")).rejects.toThrow("sin cuota");
		expect(fake.calls).toHaveLength(1);
	});

	it("pagina listados core (page/limit) y con cursor", async () => {
		const fake = new FakeCloudTalk();
		fake.addCalls(25);
		const r = await collectCorePages(fake.client(), "calls_index", { limit: 10 }, 22, 10);
		expect(r).toMatchObject({ total: 25, pages_read: 3, truncated: true });
		expect(r.items).toHaveLength(22);
		const c = await collectCursorPages(fake.client(), "dialer_list_campaigns", {}, 100, 5);
		expect(c).toMatchObject({ pages_read: 2, truncated: false, items: [{ id: "42" }, { id: "43" }] });
	});

	it("rechaza operaciones desconocidas sin llamar", async () => {
		const fake = new FakeCloudTalk();
		await expect(new CloudTalkClient({ keyId: "a", secret: "b" }, { fetch: fake.fetch as typeof fetch }).call("nope")).rejects.toMatchObject({ code: "UNKNOWN_OPERATION" });
		expect(fake.calls).toHaveLength(0);
	});
});
