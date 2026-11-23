import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;

/** Why a request body was refused: the content type is not the expected one, the body is over the limit, or the bytes are not valid JSON. */
export type BodyReadReason = 'content-type' | 'too-large' | 'invalid-json';

/** Thrown by {@link readBodyBytes} and {@link readJsonBody}; callers map `reason` to their own status code or error sentinel. */
export class BodyReadError extends Error {
  readonly reason: BodyReadReason;
  constructor(reason: BodyReadReason) {
    super('BODY_' + reason.toUpperCase().replaceAll('-', '_'));
    this.name = 'BodyReadError';
    this.reason = reason;
  }
}

export type ReadBodyOptions = {
  /** Refuse bodies larger than this many bytes. */
  maxBytes: number;
  /** Content type the request must carry; defaults to `application/json`. */
  contentType?: RegExp;
};

/** Read a whole request body into one buffer, refusing the wrong content type and oversized bodies. */
export async function readBodyBytes(req: IncomingMessage, options: ReadBodyOptions): Promise<Buffer> {
  if (!(options.contentType ?? JSON_CONTENT_TYPE).test(req.headers['content-type'] ?? '')) throw new BodyReadError('content-type');
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > options.maxBytes) throw new BodyReadError('too-large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

/** Read and parse a JSON request body; throws {@link BodyReadError} with the reason for every refusal. */
export async function readJsonBody(req: IncomingMessage, options: ReadBodyOptions): Promise<unknown> {
  const bytes = await readBodyBytes(req, options);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new BodyReadError('invalid-json');
  }
}

/** Length-guarded constant-time buffer comparison; `false` for different lengths instead of throwing. */
export function timingSafeEqualBuffers(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Compare an `Authorization` header value against the expected `Bearer` token in constant time. */
export function bearerAuthorized(authorizationHeader: string | undefined, token: string): boolean {
  return timingSafeEqualBuffers(Buffer.from('Bearer ' + token), Buffer.from(authorizationHeader ?? ''));
}
