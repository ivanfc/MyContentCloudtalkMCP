import { describe, expect, it } from "vitest";
import { ALLOWED_HOSTS, CATALOG, getOperation, isRead, requireOperation, searchOperations, unsupportedReason } from "../src/cloudtalk/catalog";
import { validateCall } from "../src/cloudtalk/validate";

describe("catálogo generado del OpenAPI oficial", () => {
	// Que catalog.json corresponde exactamente a spec/cloudtalk-openapi.json lo comprueba la CI regenerándolo (git diff).
	it("cubre las 107 operaciones con ids únicos", () => {
		expect(CATALOG.operation_count).toBe(107);
		expect(CATALOG.operations).toHaveLength(107);
		expect(new Set(CATALOG.operations.map((o) => o.id)).size).toBe(107);
		expect(CATALOG.spec_sha256).toBe("184b4fa8613dbf9047fc6b51123afb65d2d981b944077e6b76b211f7e264d964");
	});

	it("solo usa los 4 hosts https de CloudTalk", () => {
		expect([...ALLOWED_HOSTS].sort()).toEqual(["analytics-api.cloudtalk.io", "api.cloudtalk.io", "my.cloudtalk.io", "platform-api.cloudtalk.io"]);
		for (const o of CATALOG.operations) expect(o.host.startsWith("https://")).toBe(true);
	});

	it("cada parámetro de ruta aparece en la ruta y viceversa", () => {
		for (const o of CATALOG.operations) {
			const inPath = [...o.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
			expect(o.path_params.map((p) => p.name).sort(), o.id).toEqual(inPath);
		}
	});

	it("no deja operaciones oficiales sin ruta de ejecución", () => {
		expect(CATALOG.operations.filter((o) => unsupportedReason(o)).map((o) => o.id).sort()).toEqual([]);
	});

	it("busca por palabras y explica operaciones inexistentes con sugerencias", () => {
		expect(searchOperations("webhook secret").map((o) => o.id)).toEqual(expect.arrayContaining(["get_webhook_endpoint_secret", "rotate_webhook_endpoint_secret"]));
		expect(searchOperations(undefined, "Dialer").length).toBe(27);
		expect(() => requireOperation("contacts_create")).toThrow(/no existe.*contacts/);
		expect(isRead(getOperation("calls_index")!)).toBe(true);
		expect(isRead(getOperation("contacts_add")!)).toBe(false);
	});
});

describe("validación contra el esquema", () => {
	it("rechaza campos y parámetros inventados, enums y obligatorios", () => {
		const add = requireOperation("contacts_add");
		expect(validateCall(add, { body: { name: "A", phone: "+34600" } }).errors.join()).toMatch(/body\.phone: campo no documentado/);
		expect(validateCall(add, { body: { company: "X" } }).errors.join()).toMatch(/body\.name: obligatorio/);
		expect(validateCall(add, { body: { name: "A", ContactNumber: [{ public_number: "+34600111222" }] } }).errors).toEqual([]);
		expect(validateCall(add, { body: { name: "x".repeat(151) } }).errors.join()).toMatch(/máximo 150/);
		const calls = requireOperation("calls_index");
		expect(validateCall(calls, { query: { type: "inbound" } }).errors.join()).toMatch(/incoming, outgoing, internal/);
		expect(validateCall(calls, { query: { since: "2026" } }).errors.join()).toMatch(/query\.since: parámetro no documentado/);
		expect(validateCall(calls, { query: { limit: "50", user_id: 3 } })).toMatchObject({ errors: [], query: { limit: 50, user_id: 3 } });
		expect(validateCall(calls, { query: { limit: 5000 } }).errors.join()).toMatch(/máximo 1000/);
	});

	it("allow_undocumented convierte los campos desconocidos en avisos", () => {
		const v = validateCall(requireOperation("contacts_add"), { body: { name: "A", nuevo: 1 } }, true);
		expect(v.errors).toEqual([]);
		expect(v.warnings.join()).toMatch(/nuevo/);
	});

	it("valida parámetros de ruta: obligatorios, sin barras ni '..'", () => {
		const op = requireOperation("contacts_edit");
		expect(validateCall(op, { body: { name: "A" } }).errors.join()).toMatch(/path_params\.contactId: obligatorio/);
		expect(validateCall(op, { path_params: { contactId: "../agents" }, body: { name: "A" } }).errors.join()).toMatch(/formato no válido/);
		expect(validateCall(op, { path_params: { contactId: 5, id: 3 }, body: { name: "A" } }).errors.join()).toMatch(/path_params\.id: esta operación no tiene/);
	});

	it("bulk_contacts: array de máx. 10 acciones con enum de action", () => {
		const op = requireOperation("bulk_contacts");
		const one = { action: "add_contact", command_id: "c1", data: { name: "A" } };
		expect(validateCall(op, { body: [one] }).errors).toEqual([]);
		expect(validateCall(op, { body: Array(11).fill(one) }).errors.join()).toMatch(/máximo 10 elementos/);
		expect(validateCall(op, { body: [{ ...one, action: "merge_contact" }] }).errors.join()).toMatch(/no permitido/);
	});

	it("el Dialer valida objetos anidados (políticas) y los estados", () => {
		const op = requireOperation("dialer_patch_campaign");
		expect(validateCall(op, { path_params: { campaignId: 42 }, body: { status: "active", calling_policy: { answer_wait: 25 } } }).errors).toEqual([]);
		expect(validateCall(op, { path_params: { campaignId: 42 }, body: { status: "running" } }).errors.join()).toMatch(/no permitido/);
		expect(validateCall(op, { path_params: { campaignId: 42 }, body: { calling_policy: { answer_wait: -1 } } }).errors.join()).toMatch(/mínimo 0/);
	});
});
