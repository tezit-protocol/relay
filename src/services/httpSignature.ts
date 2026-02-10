/**
 * HTTP Message Signatures for federation requests.
 *
 * Simplified from RFC 9421. Signs outbound federation requests and
 * verifies inbound ones using Ed25519.
 *
 * Signed components: (request-target), host, date, digest
 * Digest: SHA-256 of the request body (prevents tampering).
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "crypto";

export interface SignatureParams {
  method: string;
  path: string;
  host: string;
  body: string;
  privateKeyPem: string;
  keyId: string; // serverId of the signing server
}

export interface SignedHeaders {
  Host: string;
  Date: string;
  Digest: string;
  Signature: string;
  "Signature-Input": string;
}

export interface VerifyParams {
  method: string;
  path: string;
  host: string;
  date: string;
  digest: string;
  signature: string;
  signatureInput: string;
  body: string;
  publicKeyBase64: string;
}

/**
 * Create the signing string from request components.
 */
function buildSigningString(params: {
  method: string;
  path: string;
  host: string;
  date: string;
  digest: string;
}): string {
  return [
    `(request-target): ${params.method.toLowerCase()} ${params.path}`,
    `host: ${params.host}`,
    `date: ${params.date}`,
    `digest: ${params.digest}`,
  ].join("\n");
}

/**
 * Compute SHA-256 digest of a body string.
 */
export function computeDigest(body: string): string {
  const hash = createHash("sha256").update(body, "utf-8").digest("base64");
  return `SHA-256=${hash}`;
}

/**
 * Sign an outbound federation request.
 * Returns headers to add to the request.
 */
export function signRequest(params: SignatureParams): SignedHeaders {
  const date = new Date().toUTCString();
  const digest = computeDigest(params.body);

  const signingString = buildSigningString({
    method: params.method,
    path: params.path,
    host: params.host,
    date,
    digest,
  });

  const privateKey = createPrivateKey(params.privateKeyPem);
  const sig = sign(null, Buffer.from(signingString), privateKey);

  return {
    Host: params.host,
    Date: date,
    Digest: digest,
    Signature: sig.toString("base64"),
    "Signature-Input": `keyId="${params.keyId}",headers="(request-target) host date digest",algorithm="ed25519"`,
  };
}

/**
 * Verify an inbound federation request's signature.
 * Returns true if valid, false otherwise.
 */
export function verifyRequest(params: VerifyParams): boolean {
  try {
    // Verify digest matches body
    const expectedDigest = computeDigest(params.body);
    if (params.digest !== expectedDigest) {
      return false;
    }

    // Verify the date is within 5 minutes
    const requestDate = new Date(params.date);
    const now = new Date();
    const diffMs = Math.abs(now.getTime() - requestDate.getTime());
    if (diffMs > 5 * 60 * 1000) {
      return false;
    }

    // Reconstruct signing string
    const signingString = buildSigningString({
      method: params.method,
      path: params.path,
      host: params.host,
      date: params.date,
      digest: params.digest,
    });

    // Verify signature
    const publicKeyDer = Buffer.from(params.publicKeyBase64, "base64");
    const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    return verify(null, Buffer.from(signingString), publicKey, Buffer.from(params.signature, "base64"));
  } catch {
    return false;
  }
}

/**
 * Extract the keyId from a Signature-Input header.
 */
export function extractKeyId(signatureInput: string): string | null {
  const match = signatureInput.match(/keyId="([^"]+)"/);
  return match ? match[1] : null;
}
