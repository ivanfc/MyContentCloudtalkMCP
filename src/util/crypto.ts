const enc = new TextEncoder();

export function b64(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

export function unb64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function sha256Hex(text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 en hex. Para seudonimizar emails en logs y auditoría sin que se puedan revertir por diccionario. */
export async function hmacHex(secret: string, text: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", enc.encode(secret || "cloudtalk-mcp"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(text));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Clave AES-GCM derivada (HKDF) de un secreto del usuario. */
async function deriveKey(secret: string, info: string): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: enc.encode("mycontent-cloudtalk-mcp/v1"), info: enc.encode(info) },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptJson(secret: string, info: string, data: unknown): Promise<string> {
	const key = await deriveKey(secret, info);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
	return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}

/** undefined si no se puede descifrar (otra clave = otra instalación u otro usuario). */
export async function decryptJson<T>(secret: string, info: string, blob: string): Promise<T | undefined> {
	try {
		const { iv, ct } = JSON.parse(blob) as { iv: string; ct: string };
		const key = await deriveKey(secret, info);
		const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct));
		return JSON.parse(new TextDecoder().decode(pt)) as T;
	} catch {
		return undefined;
	}
}
