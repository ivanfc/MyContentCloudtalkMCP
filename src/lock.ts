import { DurableObject } from "cloudflare:workers";
import type { Usage, QuotaConfig } from './quota-policy';
import type { UsageQuota } from './quota';

const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Cerrojo global de planes (una sola instancia, idFromName("global")). KV no es transaccional y cachea lecturas
 * ~60 s, así que dos apply_plan simultáneos del mismo plan podrían ejecutarse los dos. Un Durable Object procesa
 * las peticiones de una en una: get + put sobre su storage es atómico frente a otras llamadas.
 */
export class PlanLock extends DurableObject<Env> {
	async claimWithQuota(user: string, planId: string, usage: Partial<Usage>, cfg: QuotaConfig): Promise<boolean> {
		const result = await this.ctx.blockConcurrencyWhile(async () => {
			try {
			const key = `claim:${user}:${planId}`;
			if (await this.ctx.storage.get(key)) return false;
			const quota = this.env.USAGE_QUOTA.get(this.env.USAGE_QUOTA.idFromName('global')) as unknown as DurableObjectStub<UsageQuota>;
			const result = await quota.consume(user, usage, cfg);
			if (!result.ok) throw new Error(result.reason ?? 'Cuota no disponible');
			await this.ctx.storage.put(key, Date.now());
			const old = await this.ctx.storage.list<number>({prefix:'claim:'});
			const expired = [...old].filter(([,t])=>Date.now()-t>CLAIM_TTL_MS).map(([k])=>k);
			if(expired.length)await this.ctx.storage.delete(expired);
			return true;
			} catch(e) {return {error:(e as Error).message};}
		});
		// Throw outside the callback: an ordinary quota denial must not reset the DO.
		if(typeof result==='object')throw new Error(result.error);
		return result;
	}
	/** true si este llamante se queda el plan; false si ya lo reclamó otro. */
	async claim(planId: string): Promise<boolean> {
		const key = `claim:${planId}`;
		if (await this.ctx.storage.get(key)) return false;
		const now = Date.now();
		await this.ctx.storage.put(key, now);
		// Limpieza perezosa: el plan se borra al aplicarlo; el claim solo tiene que cubrir la ventana de caché de KV (~60 s), se guarda 2 h.
		const old = await this.ctx.storage.list<number>({ prefix: "claim:" });
		const expired = [...old].filter(([, t]) => now - t > CLAIM_TTL_MS).map(([k]) => k);
		if (expired.length) await this.ctx.storage.delete(expired);
		return true;
	}
}
