import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function encryptCheckpoint(plaintext: string, key: string, context: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid checkpoint key");
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), nonce);
	cipher.setAAD(Buffer.from(context));
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptCheckpoint(envelope: Buffer, key: string, context: string): string {
	if (!/^[a-f0-9]{64}$/.test(key) || envelope.length < 29 || envelope[0] !== 1) throw new Error("Invalid checkpoint envelope");
	const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), envelope.subarray(1, 13));
	decipher.setAAD(Buffer.from(context));
	decipher.setAuthTag(envelope.subarray(13, 29));
	return Buffer.concat([decipher.update(envelope.subarray(29)), decipher.final()]).toString("utf8");
}
