import catalogJson from "./catalog.json";

/** Esquema compacto generado desde el OpenAPI oficial (scripts/build-catalog.mjs). */
export interface Schema {
	type?: string;
	enum?: unknown[];
	format?: string;
	description?: string;
	example?: unknown;
	minimum?: number;
	maximum?: number;
	maxItems?: number;
	maxLength?: number;
	properties?: Record<string, Schema>;
	required?: string[];
	items?: Schema;
	oneOf?: Schema[];
	additionalProperties?: Schema | true;
	/** Solo en la raíz del body: el body es obligatorio. */
	required_body?: boolean;
}

export interface Param extends Omit<Schema, "required"> {
	name: string;
	required: boolean;
}

export interface Operation {
	id: string;
	tag: string;
	method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
	host: string;
	path: string;
	summary: string;
	description: string;
	path_params: Param[];
	query_params: Param[];
	body_content_type?: string;
	body?: Schema;
	response_content_type: string | null;
	deprecated?: boolean;
}

interface Catalog {
	source: string;
	api_title: string;
	api_version: string;
	spec_sha256: string;
	operation_count: number;
	operations: Operation[];
}

export const CATALOG = catalogJson as unknown as Catalog;
const BY_ID = new Map(CATALOG.operations.map((o) => [o.id, o]));

/** Hosts de la API de CloudTalk. El cliente no llama a ningún otro. */
export const ALLOWED_HOSTS = new Set(CATALOG.operations.map((o) => new URL(o.host).hostname));

export function getOperation(id: string): Operation | undefined {
	return BY_ID.get(String(id ?? "").trim());
}

export function requireOperation(id: string): Operation {
	const op = getOperation(id);
	if (!op) {
		const near = searchOperations(id).slice(0, 8).map((o) => o.id);
		throw new CatalogError(`La operación "${String(id).slice(0, 80)}" no existe en la API de CloudTalk.${near.length ? ` Parecidas: ${near.join(", ")}.` : ""} Usa describe_api_operation para ver el catálogo.`);
	}
	return op;
}

export class CatalogError extends Error {
	override name = "CatalogError";
}

export const isRead = (op: Operation) => op.method === "GET";

/** Tipos que el transporte del conector todavía no reconoce. */
export function unsupportedReason(op: Operation): string | undefined {
	if (op.body_content_type && !["application/json", "multipart/form-data"].includes(op.body_content_type)) return `Body ${op.body_content_type} no admitido.`;
	if (op.response_content_type && !/json|^audio\//.test(op.response_content_type)) return `Respuesta ${op.response_content_type} no admitida.`;
	return undefined;
}

/** Búsqueda simple por id, tag, ruta, resumen y descripción. */
export function searchOperations(filter?: string, tag?: string): Operation[] {
	const words = String(filter ?? "")
		.toLowerCase()
		.split(/[\s_/.-]+/)
		.filter(Boolean);
	const t = tag?.toLowerCase();
	return CATALOG.operations.filter((o) => {
		if (t && o.tag.toLowerCase() !== t) return false;
		if (!words.length) return true;
		const hay = `${o.id} ${o.tag} ${o.method} ${o.path} ${o.summary} ${o.description}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

export function tags(): { tag: string; operations: number }[] {
	const m = new Map<string, number>();
	for (const o of CATALOG.operations) m.set(o.tag, (m.get(o.tag) ?? 0) + 1);
	return [...m].map(([tag, operations]) => ({ tag, operations }));
}

/** Línea de catálogo (listado). */
export function brief(op: Operation) {
	return { operation: op.id, kind: isRead(op) ? "read" : "write", method: op.method, path: op.path, summary: op.summary, ...(unsupportedReason(op) ? { unsupported: true } : {}) };
}
