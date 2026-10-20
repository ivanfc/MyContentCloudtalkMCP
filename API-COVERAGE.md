# Cobertura de la API oficial de CloudTalk

Fuente: https://help.cloudtalk.io/api-reference/openapi.json (OpenAPI 1.7, sha256 `184b4fa8613dbf9047fc6b51123afb65d2d981b944077e6b76b211f7e264d964`). Copia versionada en `spec/cloudtalk-openapi.json`.
Generado con `node scripts/coverage-md.mjs` a partir de `src/cloudtalk/catalog.json` (que la CI regenera desde el spec y compara).

**107 operaciones.** Toda lectura es ejecutable con `api_read` y toda escritura JSON con `plan_api_call` → `apply_plan`, validadas contra el esquema oficial. La columna «Curada» indica la herramienta específica cuando existe.

Barrera: **E** = APPLY-ELEVATED siempre · **E\*** = APPLY-ELEVATED según el body · **A** = APPLY · **L** = lectura (sin plan) · **✗** = no ejecutable por el conector.


## CueCard (1)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `cuecards_create` | POST `platform-api.cloudtalk.io/api/cuecards` | Create CueCard | A |  |

## Agents (4)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `agents_index` | GET `my.cloudtalk.io/api/agents/index.json` | List agents | L | get_account_overview, plan_make_call (comprobación) |
| `agents_add` | PUT `my.cloudtalk.io/api/agents/add.json` | Add an agent | E |  |
| `agents_edit` | POST `my.cloudtalk.io/api/agents/edit/{agentId}.json` | Edit an agent | E* (si cambia email, salientes o límite de gasto) |  |
| `agents_delete` | DELETE `my.cloudtalk.io/api/agents/delete/{agentId}.json` | Delete an agent | E |  |

## Groups (3)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `groups_index` | GET `my.cloudtalk.io/api/groups/index.json` | List groups | L | get_account_overview |
| `groups_add` | PUT `my.cloudtalk.io/api/groups/add.json` | Add agent to group | A |  |
| `groups_delete` | DELETE `my.cloudtalk.io/api/groups/delete/{agent_id}.json` | Remove agent from group | A |  |

## Bulks (1)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `bulk_contacts` | POST `my.cloudtalk.io/api/bulk/contacts.json` | Contact actions | E* (si incluye borrados) |  |

## Campaigns (4)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `campaigns_index` | GET `my.cloudtalk.io/api/campaigns/index.json` | List campaigns | L |  |
| `campaigns_add` | PUT `my.cloudtalk.io/api/campaigns/add.json` | Add campaign | E* (si status=active) |  |
| `campaigns_edit` | POST `my.cloudtalk.io/api/campaigns/edit/{id}.json` | Edit campaign | E* (si status=active) |  |
| `campaigns_delete` | DELETE `my.cloudtalk.io/api/campaigns/delete/{id}.json` | Delete campaign | E |  |

## Contacts (16)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `contacts_index` | GET `my.cloudtalk.io/api/contacts/index.json` | List contacts | L | find_contacts, plan_create_contact (duplicados) |
| `contacts_add` | PUT `my.cloudtalk.io/api/contacts/add.json` | Add contact | A | plan_create_contact |
| `contacts_edit` | POST `my.cloudtalk.io/api/contacts/edit/{contactId}.json` | Edit contact | A | plan_update_contact (fusiona listas) |
| `contacts_delete` | DELETE `my.cloudtalk.io/api/contacts/delete/{contactId}.json` | Delete contact | E |  |
| `contacts_show` | GET `my.cloudtalk.io/api/contacts/show/{contactId}.json` | Inspect a contact | L | get_contact, plan_update_contact |
| `contacts_attributes` | GET `my.cloudtalk.io/api/contacts/attributes.json` | Attributes | L |  |
| `contacts_add_tags` | PUT `my.cloudtalk.io/api/contacts/addTags/{contactId}.json` | Assign contact tags | A | plan_update_contact |
| `contacts_remove_tags` | DELETE `my.cloudtalk.io/api/contacts/removeTags/{contactId}.json` | Unassign contact tags | A | plan_update_contact |
| `notes_index` | GET `my.cloudtalk.io/api/notes/index.json` | List notes | L | get_contact |
| `notes_add` | PUT `my.cloudtalk.io/api/notes/add/{contactId}.json` | Add note | A |  |
| `notes_edit` | POST `my.cloudtalk.io/api/notes/edit/{noteId}.json` | Edit note | A |  |
| `notes_delete` | DELETE `my.cloudtalk.io/api/notes/delete/{noteId}.json` | Delete note | E |  |
| `activity_index` | GET `my.cloudtalk.io/api/activity/index.json` | List activities | L | get_contact |
| `activity_add` | PUT `my.cloudtalk.io/api/activity/add/{contactId}.json` | Add activity | A |  |
| `activity_edit` | POST `my.cloudtalk.io/api/activity/edit/{activityId}.json` | Edit activity | A |  |
| `activity_delete` | DELETE `my.cloudtalk.io/api/activity/delete/{activityId}.json` | Delete activity | E |  |

## Numbers (3)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `numbers_index` | GET `my.cloudtalk.io/api/numbers/index.json` | List numbers | L | get_account_overview, plan_send_sms (remitente) |
| `numbers_edit` | POST `my.cloudtalk.io/api/numbers/edit/{id}.json` | Edit a number | E |  |
| `numbers_clear` | DELETE `my.cloudtalk.io/api/numbers/clear/{id}.json` | Unregister a number | E |  |

## Utilities (5)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `countries_index` | GET `my.cloudtalk.io/api/countries/index.json` | List countries | L |  |
| `blacklist_index` | GET `my.cloudtalk.io/api/blacklist/index.json` | List blacklist | L |  |
| `blacklist_add` | PUT `my.cloudtalk.io/api/blacklist/add.json` | Add number to blacklist | A |  |
| `blacklist_edit` | POST `my.cloudtalk.io/api/blacklist/edit/{id}.json` | Edit number on blacklist | A |  |
| `blacklist_delete` | DELETE `my.cloudtalk.io/api/blacklist/delete/{id}.json` | Delete number from blacklist | E |  |

## Sms (1)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `sms_send` | POST `my.cloudtalk.io/api/sms/send.json` | Send sms | E | plan_send_sms |

## Calls (6)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `calls_index` | GET `my.cloudtalk.io/api/calls/index.json` | Call history | L | list_calls, get_call_report, get_contact |
| `calls_details` | GET `analytics-api.cloudtalk.io/api/calls/{callId}` | Get call details | L | get_call (details) |
| `calls_recording` | GET `my.cloudtalk.io/api/calls/recording/{callId}.json` | Recording media | ✗ audio binario: usar get_call |  |
| `recordings_delete` | DELETE `my.cloudtalk.io/api/recordings/delete/{callId}.json` | Delete call recording | E |  |
| `calls_create` | POST `my.cloudtalk.io/api/calls/create.json` | Make a call | A | plan_make_call |
| `statistics_realtime_groups` | GET `my.cloudtalk.io/api/statistics/realtime/groups.json` | Group statistics | L | get_account_overview |

## Contact tags (4)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `tags_index` | GET `my.cloudtalk.io/api/tags/index.json` | List contact tags | L |  |
| `tags_add` | PUT `my.cloudtalk.io/api/tags/add.json` | Add a contact tag | A |  |
| `tags_edit` | POST `my.cloudtalk.io/api/tags/edit/{id}.json` | Edit a contact tag | A |  |
| `tags_delete` | DELETE `my.cloudtalk.io/api/tags/delete/{id}.json` | Delete a contact tag | E |  |

## Conversation Intelligence (7)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `ai_calls_summary` | GET `api.cloudtalk.io/v1/ai/calls/{callId}/summary` | Summary | L | get_call (summary) |
| `ai_calls_overall_sentiment` | GET `api.cloudtalk.io/v1/ai/calls/{callId}/overall-sentiment` | Overall sentiment | L | get_call (sentiment) |
| `ai_calls_talk_listen_ratio` | GET `api.cloudtalk.io/v1/ai/calls/{callId}/talk-listen-ratio` | Talk-listen ratio | L | get_call (talk_listen_ratio) |
| `ai_calls_topics` | GET `api.cloudtalk.io/v1/ai/calls/{callId}/topics` | Topics | L | get_call (topics) |
| `ai_calls_transcription` | GET `api.cloudtalk.io/v1/ai/calls/{callId}/transcription` | Transcription | L | get_call (transcription) |
| `ai_calls_smart_notes` | GET `api.cloudtalk.io/v1/ai/calls/{callId}/smart-notes` | Smart notes | L | get_call (smart_notes) |
| `ai_calls_details_link` | GET `api.cloudtalk.io/v1/ai/calls/{callId}/details-link` | Call details link | L | get_call (details_link) |

## VoiceAgent (13)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `create_voice_agent_call` | POST `api.cloudtalk.io/v1/voice-agent/calls` | Initiate VoiceAgent call | E |  |
| `kill_voice_agent_outbound` | POST `api.cloudtalk.io/v1/voice-agent/outbound/kill` | Stop outbound VoiceAgent calls | A |  |
| `list_voice_agents` | GET `api.cloudtalk.io/v1/voice-agents` | List voice agents | L |  |
| `create_voice_agent` | POST `api.cloudtalk.io/v1/voice-agents` | Create a voice agent | A |  |
| `get_voice_agent` | GET `api.cloudtalk.io/v1/voice-agents/{voiceAgentId}` | Get a voice agent | L |  |
| `replace_voice_agent` | PUT `api.cloudtalk.io/v1/voice-agents/{voiceAgentId}` | Replace a voice agent | A |  |
| `delete_voice_agent` | DELETE `api.cloudtalk.io/v1/voice-agents/{voiceAgentId}` | Delete a voice agent | E |  |
| `attach_voice_agent_knowledge_base` | PUT `api.cloudtalk.io/v1/voice-agents/{voiceAgentId}/knowledge-bases/{knowledgeBaseId}` | Attach a knowledge base to a voice agent | A |  |
| `detach_voice_agent_knowledge_base` | DELETE `api.cloudtalk.io/v1/voice-agents/{voiceAgentId}/knowledge-bases/{knowledgeBaseId}` | Detach a knowledge base from a voice agent | A |  |
| `list_knowledge_bases` | GET `api.cloudtalk.io/v1/knowledge-bases` | List knowledge bases | L |  |
| `create_knowledge_base` | POST `api.cloudtalk.io/v1/knowledge-bases` | Create a knowledge base | A |  |
| `upload_knowledge_base_file` | POST `api.cloudtalk.io/v1/knowledge-bases/files` | Upload a knowledge base file | ✗ multipart: usar create_knowledge_base (text/url) |  |
| `delete_knowledge_base` | DELETE `api.cloudtalk.io/v1/knowledge-bases/{knowledgeBaseId}` | Delete a knowledge base | E |  |

## Dialer (27)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `dialer_list_campaigns` | GET `api.cloudtalk.io/v1/dialer/campaigns` | List dialer campaigns | L |  |
| `dialer_create_campaign` | POST `api.cloudtalk.io/v1/dialer/campaigns` | Create a dialer campaign | A |  |
| `dialer_get_campaign` | GET `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}` | Get a dialer campaign | L |  |
| `dialer_patch_campaign` | PATCH `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}` | Update a dialer campaign | E* (si status=active) |  |
| `dialer_delete_campaign` | DELETE `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}` | Delete a dialer campaign | E |  |
| `dialer_get_campaign_associations` | GET `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}/associations` | Get a campaign's associations | L |  |
| `dialer_replace_campaign_associations` | PUT `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}/associations` | Replace a campaign's associations | A |  |
| `dialer_get_campaign_disposition_buttons` | GET `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}/disposition-buttons` | Get a campaign's disposition buttons | L |  |
| `dialer_replace_campaign_disposition_buttons` | PUT `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}/disposition-buttons` | Replace a campaign's disposition buttons | A |  |
| `dialer_list_disposition_tags` | GET `api.cloudtalk.io/v1/dialer/disposition-tags` | List disposition tags | L |  |
| `dialer_get_campaign_statistics` | GET `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}/statistics` | Get a campaign's statistics | L |  |
| `dialer_list_campaign_contacts` | GET `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}/contacts` | List a campaign's contacts | L |  |
| `dialer_peek_contacts` | GET `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}/contacts/next` | Peek at the next contacts to be dialed | L |  |
| `dialer_get_campaign_contact` | GET `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}/contacts/{campaignContactId}` | Get one campaign contact | L |  |
| `dialer_create_campaign_export` | POST `api.cloudtalk.io/v1/dialer/campaigns/{campaignId}/exports` | Request a campaign data export | A |  |
| `dialer_get_export_job` | GET `api.cloudtalk.io/v1/dialer/exports/{jobId}` | Get an export job's status | L |  |
| `dialer_download_export_job` | GET `api.cloudtalk.io/v1/dialer/exports/{jobId}/download` | Get a download link for a completed export | L |  |
| `dialer_list_scripts` | GET `api.cloudtalk.io/v1/dialer/scripts` | List call scripts | L |  |
| `dialer_create_script` | POST `api.cloudtalk.io/v1/dialer/scripts` | Create a call script | A |  |
| `dialer_get_script` | GET `api.cloudtalk.io/v1/dialer/scripts/{scriptId}` | Get a call script | L |  |
| `dialer_patch_script` | PATCH `api.cloudtalk.io/v1/dialer/scripts/{scriptId}` | Update a call script | A |  |
| `dialer_archive_script` | DELETE `api.cloudtalk.io/v1/dialer/scripts/{scriptId}` | Archive a call script | A |  |
| `dialer_list_surveys` | GET `api.cloudtalk.io/v1/dialer/surveys` | List surveys | L |  |
| `dialer_create_survey` | POST `api.cloudtalk.io/v1/dialer/surveys` | Create a survey | A |  |
| `dialer_get_survey` | GET `api.cloudtalk.io/v1/dialer/surveys/{surveyId}` | Get a survey | L |  |
| `dialer_patch_survey` | PATCH `api.cloudtalk.io/v1/dialer/surveys/{surveyId}` | Rename or archive a survey | A |  |
| `dialer_replace_survey_questions` | PUT `api.cloudtalk.io/v1/dialer/surveys/{surveyId}/questions` | Replace a survey's questions | A |  |

## Webhooks (12)

| Operación | Método y ruta | Resumen | Barrera | Curada |
|---|---|---|---|---|
| `list_webhook_event_types` | GET `api.cloudtalk.io/v1/webhooks/event-types` | List webhook event types | L |  |
| `list_webhook_endpoints` | GET `api.cloudtalk.io/v1/webhooks/endpoints` | List webhook endpoints | L |  |
| `create_webhook_endpoint` | POST `api.cloudtalk.io/v1/webhooks/endpoints` | Create a webhook endpoint | E |  |
| `get_webhook_endpoint` | GET `api.cloudtalk.io/v1/webhooks/endpoints/{endpointId}` | Get a webhook endpoint | L |  |
| `update_webhook_endpoint` | PATCH `api.cloudtalk.io/v1/webhooks/endpoints/{endpointId}` | Update a webhook endpoint | E* (si cambia url/eventos o reactiva) |  |
| `delete_webhook_endpoint` | DELETE `api.cloudtalk.io/v1/webhooks/endpoints/{endpointId}` | Delete a webhook endpoint | E |  |
| `get_webhook_endpoint_secret` | GET `api.cloudtalk.io/v1/webhooks/endpoints/{endpointId}/secret` | Get the signing secret | L |  |
| `rotate_webhook_endpoint_secret` | POST `api.cloudtalk.io/v1/webhooks/endpoints/{endpointId}/secret/rotate` | Rotate the signing secret | E |  |
| `send_webhook_test_event` | POST `api.cloudtalk.io/v1/webhooks/endpoints/{endpointId}/test` | Send a test event | A |  |
| `list_webhook_deliveries` | GET `api.cloudtalk.io/v1/webhooks/endpoints/{endpointId}/deliveries` | List deliveries | L |  |
| `get_webhook_delivery` | GET `api.cloudtalk.io/v1/webhooks/endpoints/{endpointId}/deliveries/{deliveryId}` | Get a delivery | L |  |
| `retry_webhook_delivery` | POST `api.cloudtalk.io/v1/webhooks/endpoints/{endpointId}/deliveries/{deliveryId}/retry` | Retry a delivery | A |  |

## Lo que la API de CloudTalk no ofrece (y el MCP no simula)

- Configurar call flows, IVR, horarios, colas o grabaciones de bienvenida (solo se puede cambiar a qué grupo/agente apunta un número con `numbers_edit`).
- Comprar, portar o dar de baja números en la facturación; crear o borrar grupos; roles y permisos de usuario; facturación y recargas.
- Informes históricos agregados oficiales: `get_call_report` los calcula a partir del historial de llamadas (y avisa si es parcial).
