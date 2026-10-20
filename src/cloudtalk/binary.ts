import { CloudTalkError } from "./errors";
import { unb64 } from "../util/crypto";

/** Keep file arguments small enough for a single MCP call and an encrypted KV plan. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface UploadFileBody {
	file: { filename: string; content_base64: string; mime_type?: string };
}

export function parseUploadFile(body: unknown): { filename: string; mimeType: string; bytes: Uint8Array } {
	const file = (body as UploadFileBody | undefined)?.file;
	const filename = file?.filename;
	const encoded = file?.content_base64;
	const mimeType = file?.mime_type ?? "application/octet-stream";
	if (typeof filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename) || filename.includes(".."))
		throw new CloudTalkError("BAD_FILE", "input", "Nombre de fichero no válido (sin rutas, 1–128 caracteres).");
	if (typeof mimeType !== "string" || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(mimeType) || mimeType.length > 100)
		throw new CloudTalkError("BAD_FILE", "input", "Tipo MIME del fichero no válido.");
	if (typeof encoded !== "string" || !encoded || encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
		throw new CloudTalkError("BAD_FILE", "input", "El fichero debe ir en base64 estándar y medir como máximo 5 MB.");
	let bytes: Uint8Array;
	try {
		bytes = unb64(encoded);
	} catch {
		throw new CloudTalkError("BAD_FILE", "input", "Base64 del fichero no válido.");
	}
	if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new CloudTalkError("BAD_FILE", "input", "El fichero debe medir entre 1 byte y 5 MB.");
	return { filename, mimeType, bytes };
}
