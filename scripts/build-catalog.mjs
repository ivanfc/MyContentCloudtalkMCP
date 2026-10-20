#!/usr/bin/env node
/**
 * Genera src/cloudtalk/catalog.json a partir del OpenAPI oficial de CloudTalk (spec/cloudtalk-openapi.json).
 *
 *   node scripts/build-catalog.mjs [ruta-al-openapi.json]
 *
 * El catálogo es la única fuente de operaciones del MCP: host, método, ruta, parámetros y campos del body.
 * Si CloudTalk publica una versión nueva del OpenAPI, se sustituye spec/cloudtalk-openapi.json y se regenera.
 * Fuente: https://help.cloudtalk.io/api-reference/openapi.json (misma que developers.cloudtalk.io).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SPEC = process.argv[2] ?? new URL("../spec/cloudtalk-openapi.json", import.meta.url).pathname;
const OUT = new URL("../src/cloudtalk/catalog.json", import.meta.url).pathname;

const raw = readFileSync(SPEC);
const spec = JSON.parse(raw.toString("utf8"));
const defaultServer = spec.servers?.[0]?.url;

function resolve(node, seen = new Set()) {
	if (!node || typeof node !== "object") return node;
	if (node.$ref) {
		if (seen.has(node.$ref)) return { type: "object", description: `(recursivo: ${node.$ref})` };
		let x = spec;
		for (const p of node.$ref.replace(/^#\//, "").split("/")) x = x?.[p];
		return resolve(x, new Set([...seen, node.$ref]));
	}
	return node;
}

const clip = (s, n) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Esquema compacto: tipo, enum, descripción, propiedades y requeridos (profundidad limitada). */
function compact(schema, depth = 0) {
	const s = resolve(schema);
	if (!s || typeof s !== "object") return undefined;
	const merged = s.allOf ? Object.assign({}, ...s.allOf.map((x) => resolve(x))) : s;
	const variants = merged.oneOf ?? merged.anyOf;
	const out = {};
	const type = merged.type ?? (merged.properties ? "object" : variants ? "oneOf" : undefined);
	if (type) out.type = Array.isArray(type) ? type.join("|") : type;
	if (merged.enum) out.enum = merged.enum;
	if (merged.format) out.format = merged.format;
	if (merged.description) out.description = clip(merged.description, 220);
	if (merged.example !== undefined && typeof merged.example !== "object") out.example = merged.example;
	if (merged.minimum !== undefined) out.minimum = merged.minimum;
	if (merged.maximum !== undefined) out.maximum = merged.maximum;
	if (merged.maxItems !== undefined) out.maxItems = merged.maxItems;
	if (merged.maxLength !== undefined) out.maxLength = merged.maxLength;
	if (depth < 4 && merged.properties) {
		out.properties = {};
		for (const [k, v] of Object.entries(merged.properties)) {
			const c = compact(v, depth + 1);
			if (resolve(v)?.readOnly) continue;
			out.properties[k] = c ?? {};
		}
		if (merged.required?.length) out.required = merged.required;
	}
	if (depth < 4 && merged.items) out.items = compact(merged.items, depth + 1);
	if (depth < 3 && variants) out.oneOf = variants.map((v) => compact(v, depth + 1));
	if (merged.additionalProperties && typeof merged.additionalProperties === "object" && depth < 4) out.additionalProperties = compact(merged.additionalProperties, depth + 1);
	else if (merged.additionalProperties === true) out.additionalProperties = true;
	return out;
}

/** Nombres que la regla general dejaría poco claros. */
const NAME_OVERRIDES = { "GET /calls/{callId}": "calls_details", "POST /cuecards": "cuecards_create" };

/**
 * Nombre estable de operación en snake_case.
 * - Con operationId (APIs nuevas): sin el prefijo public_/public_v1_; las del Dialer llevan dialer_ (p. ej. dialer_list_campaigns).
 * - Sin operationId (API core my.cloudtalk.io): ruta sin .json ni parámetros (contacts_add, contacts_addtags, numbers_clear…).
 */
function opName(method, path, op) {
	const override = NAME_OVERRIDES[`${method.toUpperCase()} ${path}`];
	if (override) return override;
	const snake = (x) => x.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase();
	if (op.operationId) {
		const n = snake(op.operationId).replace(/^public_(v1_)?/, "");
		return op.tags?.[0] === "Dialer" && !n.startsWith("dialer_") ? `dialer_${n}` : n;
	}
	return snake(path.replace(/\.json$/, "").replace(/\{[^}]+\}/g, ""));
}

const ops = [];
const seenIds = new Set();
for (const [path, item] of Object.entries(spec.paths)) {
	for (const method of ["get", "put", "post", "patch", "delete"]) {
		const op = item[method];
		if (!op) continue;
		const server = (op.servers ?? item.servers ?? [])[0]?.url ?? defaultServer;
		const base = server.replace(/\/$/, "");
		const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => resolve(p));
		const pathParams = params.filter((p) => p.in === "path").map((p) => ({ name: p.name, required: true, ...compact(p.schema), description: clip(p.description, 160) }));
		const queryParams = params.filter((p) => p.in === "query").map((p) => ({ name: p.name, required: !!p.required, ...compact(p.schema), description: clip(p.description, 160) }));
		const headerParams = params.filter((p) => p.in === "header").map((p) => p.name);
		let body;
		let bodyContentType;
		const rb = resolve(op.requestBody);
		if (rb?.content) {
			bodyContentType = Object.keys(rb.content)[0];
			body = compact(rb.content[bodyContentType].schema);
			body.required_body = !!rb.required;
		}
		const ok = Object.entries(op.responses ?? {}).find(([c]) => /^2/.test(c));
		const respType = ok ? Object.keys(resolve(ok[1])?.content ?? {})[0] ?? null : null;
		let id = opName(method, path, op);
		if (seenIds.has(id)) id = `${id}_${method}`;
		seenIds.add(id);
		ops.push({
			id,
			tag: op.tags?.[0] ?? "Other",
			method: method.toUpperCase(),
			host: base,
			path,
			summary: clip(op.summary, 120),
			description: clip(op.description, 700),
			path_params: pathParams,
			query_params: queryParams,
			...(headerParams.length ? { header_params: headerParams } : {}),
			...(body ? { body_content_type: bodyContentType, body } : {}),
			response_content_type: respType,
			...(op.deprecated ? { deprecated: true } : {}),
		});
	}
}

const catalog = {
	source: "https://help.cloudtalk.io/api-reference/openapi.json",
	api_title: spec.info?.title,
	api_version: spec.info?.version,
	spec_sha256: createHash("sha256").update(raw).digest("hex"),
	operation_count: ops.length,
	operations: ops,
};
writeFileSync(OUT, `${JSON.stringify(catalog, null, "\t")}\n`);
console.log(`${ops.length} operaciones → ${OUT}`);
