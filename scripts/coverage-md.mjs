#!/usr/bin/env node
/** Genera API-COVERAGE.md desde src/cloudtalk/catalog.json: cada operación oficial y cómo se usa desde el MCP. */
import { readFileSync, writeFileSync } from "node:fs";

const cat = JSON.parse(readFileSync(new URL("../src/cloudtalk/catalog.json", import.meta.url), "utf8"));
const CURATED = {
	agents_index: "get_account_overview, plan_make_call (comprobación)",
	groups_index: "get_account_overview",
	numbers_index: "get_account_overview, plan_send_sms (remitente)",
	statistics_realtime_groups: "get_account_overview",
	calls_index: "list_calls, get_call_report, get_contact",
	calls_details: "get_call (details)",
	ai_calls_summary: "get_call (summary)",
	ai_calls_overall_sentiment: "get_call (sentiment)",
	ai_calls_talk_listen_ratio: "get_call (talk_listen_ratio)",
	ai_calls_topics: "get_call (topics)",
	ai_calls_transcription: "get_call (transcription)",
	ai_calls_smart_notes: "get_call (smart_notes)",
	ai_calls_details_link: "get_call (details_link)",
	contacts_index: "find_contacts, plan_create_contact (duplicados)",
	contacts_show: "get_contact, plan_update_contact",
	notes_index: "get_contact",
	activity_index: "get_contact",
	contacts_add: "plan_create_contact",
	contacts_edit: "plan_update_contact (fusiona listas)",
	contacts_add_tags: "plan_update_contact",
	contacts_remove_tags: "plan_update_contact",
	sms_send: "plan_send_sms",
	calls_create: "plan_make_call",
};
const ELEVATED = new Set(["agents_add", "agents_delete", "campaigns_delete", "contacts_delete", "notes_delete", "activity_delete", "numbers_edit", "numbers_clear", "blacklist_delete", "sms_send", "recordings_delete", "tags_delete", "create_voice_agent_call", "delete_voice_agent", "delete_knowledge_base", "dialer_delete_campaign", "create_webhook_endpoint", "delete_webhook_endpoint", "rotate_webhook_endpoint_secret"]);
const CONDITIONAL = { agents_edit: "si cambia email, salientes o límite de gasto", bulk_contacts: "si incluye borrados", campaigns_add: "si status=active", campaigns_edit: "si status=active", dialer_patch_campaign: "si status=active", update_webhook_endpoint: "si cambia url/eventos o reactiva" };
const UNSUPPORTED = { calls_recording: "audio binario: usar get_call", upload_knowledge_base_file: "multipart: usar create_knowledge_base (text/url)" };

let md = `# Cobertura de la API oficial de CloudTalk

Fuente: ${cat.source} (OpenAPI ${cat.api_version}, sha256 \`${cat.spec_sha256}\`). Copia versionada en \`spec/cloudtalk-openapi.json\`.
Generado con \`node scripts/coverage-md.mjs\` a partir de \`src/cloudtalk/catalog.json\` (que la CI regenera desde el spec y compara).

**${cat.operation_count} operaciones.** Toda lectura es ejecutable con \`api_read\` y toda escritura JSON con \`plan_api_call\` → \`apply_plan\`, validadas contra el esquema oficial. La columna «Curada» indica la herramienta específica cuando existe.

Barrera: **E** = APPLY-ELEVATED siempre · **E\\*** = APPLY-ELEVATED según el body · **A** = APPLY · **L** = lectura (sin plan) · **✗** = no ejecutable por el conector.

`;
const byTag = new Map();
for (const o of cat.operations) byTag.set(o.tag, [...(byTag.get(o.tag) ?? []), o]);
for (const [tag, ops] of byTag) {
	md += `\n## ${tag} (${ops.length})\n\n| Operación | Método y ruta | Resumen | Barrera | Curada |\n|---|---|---|---|---|\n`;
	for (const o of ops) {
		const soft = ["contacts_remove_tags", "groups_delete", "detach_voice_agent_knowledge_base", "dialer_archive_script"].includes(o.id);
		const g = UNSUPPORTED[o.id] ? `✗ ${UNSUPPORTED[o.id]}` : o.method === "GET" ? "L" : ELEVATED.has(o.id) ? "E" : CONDITIONAL[o.id] ? `E* (${CONDITIONAL[o.id]})` : o.method === "DELETE" && !soft ? "E" : "A";
		md += `| \`${o.id}\` | ${o.method} \`${new URL(o.host).hostname}${new URL(o.host).pathname.replace(/\/$/, "")}${o.path}\` | ${o.summary} | ${g} | ${CURATED[o.id] ?? ""} |\n`;
	}
}
md += `
## Lo que la API de CloudTalk no ofrece (y el MCP no simula)

- Configurar call flows, IVR, horarios, colas o grabaciones de bienvenida (solo se puede cambiar a qué grupo/agente apunta un número con \`numbers_edit\`).
- Comprar, portar o dar de baja números en la facturación; crear o borrar grupos; roles y permisos de usuario; facturación y recargas.
- Informes históricos agregados oficiales: \`get_call_report\` los calcula a partir del historial de llamadas (y avisa si es parcial).
`;
writeFileSync(new URL("../API-COVERAGE.md", import.meta.url), md);
console.log("API-COVERAGE.md generado");
