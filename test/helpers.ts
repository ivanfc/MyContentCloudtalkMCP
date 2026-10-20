import { CloudTalkClient } from "../src/cloudtalk/client";
import type { Deps } from "../src/plans/engine";
import { type QuotaConfig, type QuotaState, type Usage, decide } from "../src/quota-policy";

export class MemoryKV {
	store = new Map<string, { value: string; expiresAt?: number }>();
	now = () => Date.now();
	async get(key: string) {
		const e = this.store.get(key);
		if (!e) return null;
		if (e.expiresAt && e.expiresAt <= this.now()) {
			this.store.delete(key);
			return null;
		}
		return e.value;
	}
	async put(key: string, value: string, opts?: { expirationTtl?: number }) {
		this.store.set(key, { value, expiresAt: opts?.expirationTtl ? this.now() + opts.expirationTtl * 1000 : undefined });
	}
	async delete(key: string) {
		this.store.delete(key);
	}
	async list({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number; cursor?: string } = {}) {
		const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
		return { keys: keys.map((name) => ({ name })), list_complete: true };
	}
}

type Handler = (req: { method: string; url: URL; body: any; params: string[] }) => Response | Promise<Response>;

const core = (responseData: unknown, status = 200) => Response.json({ responseData }, { status });
const page = (items: unknown[], url: URL) => {
	const limit = Number(url.searchParams.get("limit") ?? 30);
	const p = Number(url.searchParams.get("page") ?? 1);
	return core({ itemsCount: items.length, pageCount: Math.max(1, Math.ceil(items.length / limit)), pageNumber: p, limit, data: items.slice((p - 1) * limit, p * limit) });
};

/** Cuenta de CloudTalk simulada: responde como la API real (sobre responseData en core, errores dentro del sobre, 429…). */
export class FakeCloudTalk {
	keyId = "KEYID123456";
	secret = "SECRET_abcdef123";
	calls: { method: string; url: string; body: any; auth: string | null }[] = [];
	agents = [
		{ id: "1", firstname: "Ana", lastname: "López", email: "ana@x.com", availability_status: "online", status_outbound: true, extension: "1001", default_number: "+34910000001" },
		{ id: "2", firstname: "Luis", lastname: "Pérez", email: "luis@x.com", availability_status: "offline", status_outbound: true, extension: "1002" },
		{ id: "3", firstname: "Sin", lastname: "Salientes", email: "s@x.com", availability_status: "online", status_outbound: false, extension: "1003" },
	];
	numbers = [{ id: "10", caller_id_e164: 34910000001, internal_name: "Ventas ES", country_code: "34", connected_to: "0", source_id: "5" }];
	contacts = new Map<string, { Contact: Record<string, unknown>; ContactNumber: { public_number: number }[]; ContactEmail: { email: string }[]; ContactsTag: { name: string }[] }>([
		["100", { Contact: { id: "100", name: "Cliente Uno", company: "ACME" }, ContactNumber: [{ public_number: 34600111222 }], ContactEmail: [{ email: "uno@acme.com" }], ContactsTag: [{ name: "VIP" }] }],
	]);
	cdrs: Record<string, unknown>[] = [];
	dialerCampaigns = new Map<string, Record<string, unknown>>([["42", { id: "42", name: "Q4", status: "inactive", updated_at: "2026-10-01T00:00:00Z" }]]);
	/** Respuesta forzada por "MÉTODO /ruta" (p. ej. para simular errores). */
	override: Record<string, Handler> = {};
	rateResetAt?: number;

	private routes: [string, RegExp, Handler][] = [
		["GET", /^\/api\/agents\/index\.json$/, ({ url }) => page(this.agents.filter((a) => !url.searchParams.get("id") || a.id === url.searchParams.get("id")).map((Agent) => ({ Agent })), url)],
		["GET", /^\/api\/groups\/index\.json$/, ({ url }) => page([{ Group: { id: "5", internal_name: "Ventas" } }], url)],
		["GET", /^\/api\/numbers\/index\.json$/, ({ url }) => page(this.numbers.filter((n) => !url.searchParams.get("id") || n.id === url.searchParams.get("id")).map((CallNumber) => ({ CallNumber })), url)],
		["POST", /^\/api\/numbers\/edit\/(\d+)\.json$/, ({ params }) => (this.numbers.some((n) => n.id === params[0]) ? core({ status: 200 }) : core({ status: 404, message: "Not Found" }, 404))],
		["GET", /^\/api\/statistics\/realtime\/groups\.json$/, () => core({ data: { groups: [{ id: 5, name: "Ventas", answered: 3, unanswered: 1, real_time: { waiting_queue: 0 } }] } })],
		[
			"GET",
			/^\/api\/contacts\/index\.json$/,
			({ url }) => {
				const kw = (url.searchParams.get("keyword") ?? "").toLowerCase();
				const items = [...this.contacts.values()].filter((c) => !kw || JSON.stringify(c).toLowerCase().includes(kw));
				return page(items.map(({ ContactsTag: _tags, ...contact }) => contact), url);
			},
		],
		["GET", /^\/api\/contacts\/show\/(\d+)\.json$/, ({ params }) => {
			const contact = this.contacts.get(params[0]);
			if (!contact) return core({ status: 404, message: "Not Found" }, 404);
			const { ContactsTag, ...fields } = contact;
			return core({ ...fields, Tag: ContactsTag });
		}],
		[
			"PUT",
			/^\/api\/contacts\/add\.json$/,
			({ body }) => {
				const id = String(100 + this.contacts.size);
				this.contacts.set(id, { Contact: { id, name: body.name, company: body.company }, ContactNumber: (body.ContactNumber ?? []).map((n: any) => ({ public_number: Number(String(n.public_number).replace(/\D/g, "")) })), ContactEmail: body.ContactEmail ?? [], ContactsTag: body.ContactsTag ?? [] });
				return core({ status: 201, data: { id } }, 201);
			},
		],
		[
			"POST",
			/^\/api\/contacts\/edit\/(\d+)\.json$/,
			({ params, body }) => {
				const c = this.contacts.get(params[0]);
				if (!c) return core({ status: 404, message: "Not Found" });
				Object.assign(c.Contact, Object.fromEntries(Object.entries(body).filter(([k]) => !/^[A-Z]/.test(k))));
				if (body.ContactNumber) c.ContactNumber = body.ContactNumber.map((n: any) => ({ public_number: Number(String(n.public_number).replace(/\D/g, "")) }));
				if (body.ContactEmail) c.ContactEmail = body.ContactEmail;
				return core({ status: 200 });
			},
		],
		[
			"PUT",
			/^\/api\/contacts\/addTags\/(\d+)\.json$/,
			({ params, body }) => {
				this.contacts.get(params[0])!.ContactsTag.push(...body.tags.map((name: string) => ({ name })));
				return core({ status: 200 });
			},
		],
		[
			"DELETE",
			/^\/api\/contacts\/removeTags\/(\d+)\.json$/,
			({ params, body }) => {
				const c = this.contacts.get(params[0])!;
				c.ContactsTag = c.ContactsTag.filter((t) => !body.tags.includes(t.name));
				return core({ status: 200 });
			},
		],
		["DELETE", /^\/api\/contacts\/delete\/(\d+)\.json$/, ({ params }) => (this.contacts.delete(params[0]) ? core({ status: 200 }) : core({ status: 404, message: "Not Found" }, 404))],
		["GET", /^\/api\/notes\/index\.json$/, ({ url }) => page([{ ContactNote: { id: "1", contact_id: "100", note: "Llamar el lunes" } }], url)],
		["GET", /^\/api\/calls\/index\.json$/, ({ url }) => page(this.cdrs, url)],
		[
			"POST",
			/^\/api\/sms\/send\.json$/,
			({ body }) => (String(body.recipient).endsWith("999") ? core({ success: "false", data: "Unknown number" }) : core({ success: "true", data: { recipient: body.recipient } })),
		],
		[
			"POST",
			/^\/api\/calls\/create\.json$/,
			({ body }) => (this.agents.find((a) => a.id === String(body.agent_id))?.availability_status === "online" ? core({ status: 200 }) : core({ status: 403, message: "Agent is not online." }, 403)),
		],
		["GET", /^\/api\/calls\/(\d+)$/, ({ params }) => Response.json({ cdr_id: Number(params[0]), direction: "incoming", status: "answered" })],
		["GET", /^\/v1\/ai\/calls\/(\d+)\/summary$/, ({ params }) => Response.json({ callId: Number(params[0]), summary: "Resumen de prueba" })],
		["GET", /^\/v1\/ai\/calls\/(\d+)\/overall-sentiment$/, () => Response.json({ statusCode: 404, message: "Conversation Intelligence not enabled" }, { status: 404 })],
		["GET", /^\/v1\/dialer\/campaigns\/(\d+)$/, ({ params }) => (this.dialerCampaigns.has(params[0]) ? Response.json(this.dialerCampaigns.get(params[0])) : Response.json({ statusCode: 404, message: "Campaign not found" }, { status: 404 }))],
		[
			"PATCH",
			/^\/v1\/dialer\/campaigns\/(\d+)$/,
			({ params, body }) => {
				const c = this.dialerCampaigns.get(params[0])!;
				Object.assign(c, body, { updated_at: new Date().toISOString() });
				return Response.json(c);
			},
		],
		["POST", /^\/v1\/webhooks\/endpoints$/, ({ body }) => Response.json({ id: "ep_1", ...body, status: "enabled" }, { status: 201 })],
		["GET", /^\/v1\/dialer\/campaigns$/, ({ url }) => (url.searchParams.get("cursor") ? Response.json({ data: [{ id: "43" }], meta: { nextCursor: null } }) : Response.json({ data: [{ id: "42" }], meta: { nextCursor: "c2" } }))],
	];

	fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const method = (init?.method ?? "GET").toUpperCase();
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const auth = new Headers(init?.headers).get("authorization");
		this.calls.push({ method, url: url.toString(), body, auth });
		const expected = `Basic ${btoa(`${this.keyId}:${this.secret}`)}`;
		if (auth !== expected) return Response.json({ responseData: { status: 401, message: "Unauthorized" } }, { status: 401 });
		if (this.rateResetAt) {
			const reset = this.rateResetAt;
			this.rateResetAt = undefined;
			return Response.json({ responseData: { status: 429, message: "Too Many Requests" } }, { status: 429, headers: { "X-CloudTalkAPI-Limit": "60", "X-CloudTalkAPI-Remaining": "0", "X-CloudTalkAPI-ResetTime": String(Math.floor(reset / 1000)) } });
		}
		const path = url.pathname.replace(/^\/api(?=\/)/, "/api");
		const key = `${method} ${path}`;
		for (const [m, re, h] of this.routes) {
			if (m !== method) continue;
			const match = path.match(re);
			if (!match) continue;
			const handler = this.override[key] ?? h;
			const res = await handler({ method, url, body, params: match.slice(1) });
			res.headers.set("X-CloudTalkAPI-Limit", "60");
			res.headers.set("X-CloudTalkAPI-Remaining", "59");
			return res;
		}
		if (this.override[key]) return this.override[key]({ method, url, body, params: [] });
		return new Response("<html>Not found</html>", { status: 404, headers: { "content-type": "text/html" } });
	};

	client(opts: { secret?: string; beforeRequest?: () => Promise<void> } = {}) {
		return new CloudTalkClient({ keyId: this.keyId, secret: opts.secret ?? this.secret }, { fetch: this.fetch as typeof fetch, retryDelayMs: 0, beforeRequest: opts.beforeRequest });
	}

	addCalls(n: number, f: (i: number) => Record<string, unknown> = () => ({})) {
		for (let i = 0; i < n; i++) {
			const base = { Cdr: { id: String(1000 + i), type: i % 2 ? "incoming" : "outgoing", talking_time: String(i % 3 ? 60 : 0), waiting_time: 10, started_at: `2026-10-0${1 + (i % 3)}T09:00:00.000Z`, answered_at: i % 3 ? "x" : null, public_external: 34600000000 + i, public_internal: 34910000001 }, Agent: { id: String(1 + (i % 2)), fullname: i % 2 ? "Luis Pérez" : "Ana López" }, BillingCall: { price: "0.010000" } };
			this.cdrs.push({ ...base, ...f(i) });
		}
	}
}

/** Cuota en memoria con la misma política que el Durable Object. */
export class MemoryQuota {
	state: QuotaState | undefined;
	constructor(public cfg: QuotaConfig) {}
	async consume(user: string, req: Partial<Usage>) {
		const d = decide(this.state, new Date().toISOString().slice(0, 10), user, req, this.cfg);
		if (d.ok) this.state = d.state;
		return d;
	}
}

export const CFG: QuotaConfig = { user: { calls: 10_000, outreach: 50 }, global: { calls: 100_000, outreach: 1000 } };

export function makeDeps(fake: FakeCloudTalk, opts: { user?: string; kv?: MemoryKV; quota?: MemoryQuota; claims?: Set<string>; secret?: string } = {}): Deps & { kv: MemoryKV } {
	const kv = opts.kv ?? new MemoryKV();
	const quota = opts.quota ?? new MemoryQuota(CFG);
	const claims = opts.claims ?? new Set<string>();
	const user = opts.user ?? "userA";
	const client = fake.client({ secret: opts.secret });
	return {
		kv: kv as unknown as KVNamespace & MemoryKV,
		client,
		bulkClient: client,
		userKey: user,
		planSecret: `${fake.keyId}|${opts.secret ?? fake.secret}`,
		reserve: async (req) => {
			const r = await quota.consume(user, req);
			if (!r.ok) throw new Error((r as { reason: string }).reason);
		},
		acquire: async (id, req) => {
			const k = `${user}:${id}`;
			if (claims.has(k)) return false;
			claims.add(k);
			try {
				const r = await quota.consume(user, req);
				if (!r.ok) throw new Error((r as { reason: string }).reason);
				return true;
			} catch (e) {
				claims.delete(k);
				throw e;
			}
		},
	} as Deps & { kv: MemoryKV };
}
