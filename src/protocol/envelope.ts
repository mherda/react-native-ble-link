import { PROTOCOL_VERSION } from '../constants';
import type { BleLinkErrorCode } from '../errors';

export type RequestEnvelope = {
  v: number;
  kind: 'req';
  id: string;
  type: string;
  session: string | null;
  client: string;
  body: unknown;
};

export type ResponseEnvelope =
  | { v: number; kind: 'res'; re: string; ok: true; body: unknown }
  | {
      v: number;
      kind: 'res';
      re: string;
      ok: false;
      error: { code: BleLinkErrorCode; message: string };
    };

export type EventEnvelope = {
  v: number;
  kind: 'evt';
  type: string;
  body: unknown;
};

export type Envelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

export type ParseResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; code: BleLinkErrorCode; message: string; requestId?: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseEnvelope(value: unknown): ParseResult {
  if (!isObject(value) || typeof value.kind !== 'string') {
    return { ok: false, code: 'INVALID_BODY', message: 'Not an envelope' };
  }
  const requestId = typeof value.id === 'string' ? value.id : undefined;
  if (value.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'UNSUPPORTED_VERSION',
      message: `Protocol version ${String(value.v)} not supported`,
      requestId,
    };
  }
  switch (value.kind) {
    case 'req':
      if (
        typeof value.id === 'string' &&
        typeof value.type === 'string' &&
        typeof value.client === 'string' &&
        (value.session === null || typeof value.session === 'string')
      ) {
        return { ok: true, envelope: value as RequestEnvelope };
      }
      break;
    case 'res':
      if (typeof value.re === 'string' && typeof value.ok === 'boolean') {
        return { ok: true, envelope: value as ResponseEnvelope };
      }
      break;
    case 'evt':
      if (typeof value.type === 'string') {
        return { ok: true, envelope: value as EventEnvelope };
      }
      break;
  }
  return {
    ok: false,
    code: 'INVALID_BODY',
    message: `Malformed ${value.kind} envelope`,
    requestId,
  };
}
