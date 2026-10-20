import { envInt } from "./config";

/**
 * Cuota diaria (día natural UTC) por usuario y global. Dos contadores:
 * - calls: peticiones HTTP a CloudTalk (lecturas y escrituras);
 * - outreach: contactos salientes reales (SMS/WhatsApp, llamadas iniciadas, llamadas de VoiceAgent).
 * Aparte, CloudTalk limita a 60 peticiones/min por empresa; eso lo aplica su API (429) y el cliente lo explica.
 */
export interface Usage {
	calls: number;
	outreach: number;
}

export interface QuotaConfig {
	user: Usage;
	global: Usage;
}

export interface QuotaState {
	day: string;
	global: Usage;
	users: Record<string, Usage>;
}

export type QuotaDecision = { ok: true; state: QuotaState } | { ok: false; reason: string; state: QuotaState };

export const ZERO: Usage = { calls: 0, outreach: 0 };
const KEYS = ["calls", "outreach"] as const;
const LABEL: Record<keyof Usage, string> = { calls: "peticiones a CloudTalk", outreach: "contactos salientes (SMS, llamadas, VoiceAgent)" };

export function emptyState(day: string): QuotaState {
	return { day, global: { ...ZERO }, users: {} };
}

export function decide(prev: QuotaState | undefined, today: string, user: string, req: Partial<Usage>, cfg: QuotaConfig): QuotaDecision {
	const s: QuotaState = prev && prev.day === today ? { day: today, global: { ...ZERO, ...prev.global }, users: { ...prev.users } } : emptyState(today);
	const mine: Usage = { ...ZERO, ...(s.users[user] ?? {}) };
	for (const k of KEYS) {
		const n = req[k] ?? 0;
		if (n <= 0) continue;
		if (s.global[k] + n > cfg.global[k]) return { ok: false, state: s, reason: `Límite diario GLOBAL del conector alcanzado (${LABEL[k]}: ${s.global[k]}/${cfg.global[k]}). Se renueva a las 00:00 UTC.` };
		if (mine[k] + n > cfg.user[k])
			return { ok: false, state: s, reason: `Has alcanzado tu límite diario de ${LABEL[k]} (${mine[k]}/${cfg.user[k]}${n > 1 ? `; esta operación necesita ${n}` : ""}). Se renueva a las 00:00 UTC.` };
	}
	for (const k of KEYS) {
		const n = req[k] ?? 0;
		if (n <= 0) continue;
		s.global[k] += n;
		mine[k] += n;
	}
	s.users[user] = mine;
	return { ok: true, state: s };
}

export function quotaConfig(env: Record<string, unknown>): QuotaConfig {
	return {
		user: { calls: envInt(env, "QUOTA_USER_CALLS", 5000), outreach: envInt(env, "QUOTA_USER_OUTREACH", 100) },
		global: { calls: envInt(env, "QUOTA_GLOBAL_CALLS", 100000), outreach: envInt(env, "QUOTA_GLOBAL_OUTREACH", 2000) },
	};
}
