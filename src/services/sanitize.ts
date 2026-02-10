/**
 * Issue #5: Context sanitization — strip prompt injection vectors.
 *
 * Implements the sanitization requirements from TIP spec Section 4.5:
 * 1. Unicode NFC normalization
 * 2. Zero-width character removal
 * 3. Bidi override removal
 * 4. Content length limits
 *
 * Applied at context ingestion time (share, reply, federation inbox)
 * before storage. The TIP-layer delimiter wrapping and data framing
 * are the responsibility of the interrogation system, not the relay.
 */

// Zero-width and invisible characters to strip
const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\uFEFF\u2060]/g;

// Unicode bidi overrides that can be used for text reordering attacks
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/g;

// Control characters (except common whitespace: \t \n \r)
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Issue #15: MIME type allowlist for context items
const ALLOWED_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
  "application/xml",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
]);

// Max content size per context item (256KB)
const MAX_CONTEXT_CONTENT_LENGTH = 256 * 1024;

/**
 * Sanitize a string for safe storage and downstream AI consumption.
 */
export function sanitizeText(input: string): string {
  // 1. Unicode NFC normalization
  let cleaned = input.normalize("NFC");

  // 2. Strip zero-width characters
  cleaned = cleaned.replace(ZERO_WIDTH_CHARS, "");

  // 3. Strip bidi overrides
  cleaned = cleaned.replace(BIDI_OVERRIDES, "");

  // 4. Strip control characters (keep tabs, newlines, carriage returns)
  cleaned = cleaned.replace(CONTROL_CHARS, "");

  return cleaned;
}

/**
 * Sanitize a context item's content and validate its metadata.
 * Returns sanitized content or throws on invalid input.
 */
export function sanitizeContextItem(item: {
  layer: string;
  content: string;
  mimeType?: string | null;
}): { content: string; mimeType: string | null } {
  // Validate content length
  if (item.content.length > MAX_CONTEXT_CONTENT_LENGTH) {
    throw new Error(
      `Context content exceeds maximum length (${MAX_CONTEXT_CONTENT_LENGTH} bytes)`
    );
  }

  // Sanitize content text
  const content = sanitizeText(item.content);

  // Validate MIME type if provided
  let mimeType: string | null = item.mimeType ?? null;
  if (mimeType && !ALLOWED_MIME_TYPES.has(mimeType)) {
    // Strip unrecognized MIME types rather than rejecting the whole request
    mimeType = "text/plain";
  }

  return { content, mimeType };
}
