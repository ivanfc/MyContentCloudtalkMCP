import { describe, expect, it } from "vitest";
import { accountOverview, callInsights, callReport, listCalls, simplifyCall } from "../src/features";
import { FakeCloudTalk } from "./helpers";

describe("lecturas curadas", () => {
	it("foto de la cuenta: agentes por disponibilidad, grupos, números y estadísticas en vivo", async () => {
		const fake = new FakeCloudTalk();
		const o = await accountOverview(fake.client());
		expect(o.agents).toMatchObject({ total: 3, by_availability: { online: 2, offline: 1 } });
		expect(o.numbers.list[0]).toMatchObject({ id: "10", number: "+34910000001", connected_to: "group", source_id: "5" });
		expect(o.groups.list).toEqual([{ id: "5", name: "Ventas" }]);
		expect(o.realtime_groups_today).toMatchObject({ data: { groups: [{ name: "Ventas" }] } });
	});

	it("simplifica una llamada del historial", () => {
		const c = simplifyCall({
			Cdr: { id: "27", type: "outgoing", talking_time: "21", waiting_time: 2, answered_at: "2017-10-04T06:33:37.000Z", started_at: "2017-10-04T06:33:37.000Z", public_external: 421904247371, public_internal: 421221291400, recorded: true, recording_link: "https://analytics.cloudtalk.io/call-details/27" },
			Agent: { id: "1234", fullname: "Max Yellow" },
			Contact: { id: "9", name: "Jon", company: "First" },
			BillingCall: { price: "0.012000" },
			Tags: [{ id: "1", name: "VIP" }],
			Notes: [{ id: "2", note: "Llamar luego" }],
		});
		expect(c).toMatchObject({ id: "27", answered: true, talking_s: 21, external_number: "+421904247371", agent: { name: "Max Yellow" }, contact: { name: "Jon" }, price: 0.012, tags: ["VIP"], notes: ["Llamar luego"] });
	});

	it("list_calls pagina y dice si queda algo sin leer", async () => {
		const fake = new FakeCloudTalk();
		fake.addCalls(30);
		const r = await listCalls(fake.client(), { type: "outgoing" }, 10);
		expect(r).toMatchObject({ returned: 10, total_matching: 30, truncated: true, filters: { type: "outgoing" } });
		expect(fake.calls[0].url).toContain("type=outgoing");
	});

	it("informe por agente: totales, tasa de respuesta, conversación y coste", async () => {
		const fake = new FakeCloudTalk();
		fake.addCalls(6);
		const r = await callReport(fake.client(), {}, "agent", 1000);
		expect(r.complete).toBe(true);
		expect(r.total).toMatchObject({ calls: 6, answered: 4, missed: 2, answer_rate_pct: 66.7, incoming: 3, outgoing: 3, talking_total_min: 4, cost: 0.06 });
		expect(r.groups.map((g) => g.label).sort()).toEqual(["Ana López", "Luis Pérez"]);
		const partial = await callReport(fake.client(), {}, "day", 4);
		expect(partial).toMatchObject({ complete: false, calls_analyzed: 4, warning: expect.stringMatching(/PARCIAL/) });
	});

	it("análisis de una llamada: las partes no disponibles no tumban las demás", async () => {
		const fake = new FakeCloudTalk();
		const r = await callInsights(fake.client(), "77", ["details", "summary", "sentiment"], 100);
		expect(r).toMatchObject({ call_id: "77", details: { cdr_id: 77 }, summary: { summary: "Resumen de prueba" }, unavailable: { sentiment: expect.stringMatching(/Conversation Intelligence not enabled/) } });
		fake.secret = "rotada";
		await expect(callInsights(fake.client({ secret: "x" }), "77", ["summary"], 10)).rejects.toMatchObject({ category: "credential" });
	});
});
