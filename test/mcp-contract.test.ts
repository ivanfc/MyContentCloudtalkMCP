import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.mock("agents/mcp", () => ({ McpAgent: class { static serve() { return {}; } static serveSSE() { return {}; } } }));
vi.mock("@cloudflare/workers-oauth-provider", () => ({ default: class {}, getOAuthApi: () => ({}) }));
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CloudTalkTools } from "../src/index";
import { CFG, FakeCloudTalk, makeDeps } from "./helpers";

const TOOLS = [
	"describe_api_operation",
	"api_read",
	"check_connection",
	"get_account_overview",
	"list_calls",
	"get_call_report",
	"get_call",
	"find_contacts",
	"get_contact",
	"get_capabilities",
	"get_quota_usage",
	"plan_api_call",
	"plan_create_contact",
	"plan_update_contact",
	"plan_send_sms",
	"plan_make_call",
	"apply_plan",
	"preview_plan",
	"list_pending_plans",
	"cancel_plan",
	"get_audit_log",
	"disconnect_cloudtalk",
];

async function connect(fake: FakeCloudTalk, env: Record<string, unknown> = { ALLOWED_EMAILS: "*" }) {
	const deps = makeDeps(fake);
	const tools = new CloudTalkTools(env as any, () => ({ email: "ana@example.test", name: "Ana", sub: "g1", cloudtalk: { keyId: fake.keyId, secret: fake.secret, registeredAt: "2026-10-20" } }));
	vi.spyOn(tools as any, "services").mockResolvedValue({ client: deps.client, deps, cfg: CFG, userKey: "userA", props: { cloudtalk: { keyId: fake.keyId, registeredAt: "2026-10-20" } }, env, quota: { usage: async () => ({ day: "2026-10-20", used: { calls: 3, outreach: 0 } }) } });
	await tools.init();
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "contract-test", version: "1" });
	await tools.server.connect(st);
	await client.connect(ct);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
		return { isError: !!r.isError, json: JSON.parse(r.content[0].text.split("\n…[RESPUESTA TRUNCADA")[0]) };
	};
	return { client, tools, call, deps };
}

describe("contrato MCP real (cliente y servidor del SDK)", () => {
	it("publica las 22 herramientas con anotaciones coherentes", async () => {
		const { client, tools } = await connect(new FakeCloudTalk());
		try {
			const { tools: list } = await client.listTools();
			expect(list.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
			const by = Object.fromEntries(list.map((t) => [t.name, t.annotations]));
			for (const n of ["api_read", "get_call_report", "find_contacts", "describe_api_operation", "preview_plan"]) expect(by[n]?.readOnlyHint, n).toBe(true);
			for (const n of ["plan_api_call", "apply_plan", "disconnect_cloudtalk"]) expect(by[n]?.readOnlyHint, n).toBe(false);
			expect(by.apply_plan?.destructiveHint).toBe(true);
		} finally {
			await client.close();
			await tools.server.close();
		}
	});

	it("flujo completo: describe → plan → preview → apply, y lecturas genéricas", async () => {
		const fake = new FakeCloudTalk();
		const { client, tools, call } = await connect(fake);
		try {
			const d = await call("describe_api_operation", { operation: "contacts_delete" });
			expect(d.json).toMatchObject({ kind: "write", use_with: "plan_api_call", guard: expect.stringMatching(/^APPLY-ELEVATED/) });
			const s = await call("describe_api_operation", { filter: "transcription" });
			expect(s.json.operations.map((o: { operation: string }) => o.operation)).toContain("ai_calls_transcription");

			const read = await call("api_read", { operation: "dialer_list_campaigns", all_pages: true });
			expect(read.json).toMatchObject({ returned: 2, items: [{ id: "42" }, { id: "43" }] });
			expect((await call("api_read", { operation: "tags_add" })).json.message).toMatch(/escritura/);
			expect((await call("api_read", { operation: "calls_index", query: { foo: 1 } })).isError).toBe(true);
			expect((await call("api_read", { operation: "calls_recording", path_params: { callId: 1 } })).json.message).toMatch(/binario/);

			const p = await call("plan_api_call", { operation: "tags_add", body: { name: "Caliente" } });
			expect(p.json).toMatchObject({ ok: true, confirm_with: expect.stringMatching(/^APPLY p_/) });
			const pv = await call("preview_plan", { plan_id: p.json.plan_id });
			expect(pv.json.api_calls).toEqual([{ operation: "tags_add", label: "Add a contact tag", body: { name: "Caliente" } }]);
			fake.override["PUT /api/tags/add.json"] = () => Response.json({ responseData: { status: 201, data: { id: "77" } } }, { status: 201 });
			fake.calls.length = 0;
			const ap = await call("apply_plan", { plan_id: p.json.plan_id, confirm: p.json.confirm_with });
			expect(ap.json).toMatchObject({ ok: true, results: [{ created_id: "77" }] });
		} finally {
			await client.close();
			await tools.server.close();
		}
	});

	it("herramientas curadas por el cable: informe, contacto, SMS rechazado sin plan", async () => {
		const fake = new FakeCloudTalk();
		fake.addCalls(4);
		const { client, tools, call } = await connect(fake);
		try {
			const rep = await call("get_call_report", { date_from: "2026-10-01", date_to: "2026-10-03", group_by: "type" });
			expect(rep.json.total.calls).toBe(4);
			expect(fake.calls[0].url).toContain("date_from=2026-10-01+00%3A00%3A00");
			expect(fake.calls[0].url).toContain("date_to=2026-10-03+23%3A59%3A59");
			const f = await call("find_contacts", { keyword: "acme" });
			expect(f.json.contacts).toEqual([{ id: "100", name: "Cliente Uno", company: "ACME", title: null, phones: ["+34600111222"], emails: ["uno@acme.com"], tags: ["VIP"] }]);
			const g = await call("get_contact", { contact_id: "100" });
			expect(g.json).toMatchObject({ contact: { Contact: { id: "100" } }, notes: [{ ContactNote: { note: "Llamar el lunes" } }] });
			const sms = await call("plan_send_sms", { sender: "+34999999999", recipients: ["+34600000001"], message: "Hola" });
			expect(sms).toMatchObject({ isError: true, json: { ok: false, stage: "guards" } });
			const caps = await call("get_capabilities");
			expect(caps.json.api).toMatchObject({ operations: 107 });
			expect(caps.json.not_executable.map((x: { operation: string }) => x.operation).sort()).toEqual(["calls_recording", "upload_knowledge_base_file"]);
		} finally {
			await client.close();
			await tools.server.close();
		}
	});

	it("bloquea a un email de BLOCKED_EMAILS incluso en herramientas locales", async () => {
		const tools = new CloudTalkTools({ ALLOWED_EMAILS: "*", BLOCKED_EMAILS: "ana@example.test" } as any, () => ({ email: "ana@example.test" }) as any);
		await tools.init();
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "blocked", version: "1" });
		await tools.server.connect(st);
		await client.connect(ct);
		try {
			expect((await client.callTool({ name: "describe_api_operation", arguments: {} })).isError).toBe(true);
			expect((await client.callTool({ name: "check_connection", arguments: {} })).isError).toBe(true);
		} finally {
			await client.close();
			await tools.server.close();
		}
	});
});
