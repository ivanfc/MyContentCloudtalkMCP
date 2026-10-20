import { DurableObject } from "cloudflare:workers";
import { type QuotaConfig, type QuotaState, type Usage, ZERO, decide } from "./quota-policy";

/** Cuota diaria en un Durable Object global (idFromName("global")): las peticiones se procesan de una en una. */
export class UsageQuota extends DurableObject<Env> {
	async consume(user: string, req: Partial<Usage>, cfg: QuotaConfig): Promise<{ ok: boolean; reason?: string; used: Usage }> {
		const today = new Date().toISOString().slice(0, 10);
		const prev = await this.ctx.storage.get<QuotaState>("state");
		const d = decide(prev, today, user, req, cfg);
		if (d.ok || !prev || prev.day !== today) await this.ctx.storage.put("state", d.state);
		return { ok: d.ok, reason: d.ok ? undefined : d.reason, used: d.state.users[user] ?? { ...ZERO } };
	}

	async usage(user: string): Promise<{ day: string; used: Usage }> {
		const today = new Date().toISOString().slice(0, 10);
		const st = await this.ctx.storage.get<QuotaState>("state");
		return { day: today, used: st?.day === today ? { ...ZERO, ...(st.users[user] ?? {}) } : { ...ZERO } };
	}
}
