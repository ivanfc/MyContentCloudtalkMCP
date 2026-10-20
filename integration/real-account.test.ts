import { describe, expect, it } from "vitest";
import { CloudTalkClient } from "../src/cloudtalk/client";
import { accountOverview, callReport } from "../src/features";
import { buildApiCallPlan } from "../src/plans/builders";

/**
 * Contra una cuenta REAL de CloudTalk. Solo lecturas y construcción de planes (que leen estado): nunca apply_plan.
 *   CLOUDTALK_TEST_KEY_ID=... CLOUDTALK_TEST_SECRET=... npm run integration
 * Consume unas 10 peticiones del límite de 60/min de la empresa.
 */
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const keyId = env.CLOUDTALK_TEST_KEY_ID;
const secret = env.CLOUDTALK_TEST_SECRET;
const d = keyId && secret ? describe : describe.skip;

d("cuenta real de CloudTalk (solo lectura)", () => {
	const client = new CloudTalkClient({ keyId: keyId!, secret: secret! });

	it("la clave es válida y se ve la cuenta", async () => {
		const o = await accountOverview(client);
		console.log(JSON.stringify({ agents: o.agents.total, groups: o.groups.total, numbers: o.numbers.total, rate: client.lastRate }));
		expect(o.agents.total).toBeGreaterThan(0);
	});

	it("historial e informe de los últimos 7 días", async () => {
		const to = new Date();
		const from = new Date(to.getTime() - 7 * 86400_000);
		const fmt = (x: Date) => x.toISOString().slice(0, 19).replace("T", " ");
		const r = await callReport(client, { date_from: fmt(from), date_to: fmt(to) }, "agent", 1000);
		console.log(JSON.stringify(r.total));
		expect(r.total.calls).toBeGreaterThanOrEqual(0);
	});

	it("un plan de lectura de estado sobre el primer número no cambia nada", async () => {
		const n = await client.call("numbers_index", { query: { limit: 1 } });
		const first = (n.data as { data?: { CallNumber?: { id: string; internal_name?: string } }[] }).data?.[0]?.CallNumber;
		if (!first) return;
		const plan = await buildApiCallPlan(client, {}, { operation: "numbers_edit", path_params: { id: first.id }, body: { internal_name: first.internal_name ?? "" } });
		expect(plan.elevated?.length).toBeGreaterThan(0);
		expect(plan.action.stateChecks).toHaveLength(1);
	});
});
