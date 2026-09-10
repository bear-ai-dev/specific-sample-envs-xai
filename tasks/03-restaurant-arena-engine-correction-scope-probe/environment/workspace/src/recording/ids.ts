import { randomUUID } from "node:crypto";

type UuidFactory = () => string;

function createPrefixedId(prefix: string, uuid: UuidFactory): string {
  return `${prefix}_${uuid()}`;
}

export function createUserId(uuid: UuidFactory = randomUUID): string {
  return createPrefixedId("usr", uuid);
}

export function createGameId(uuid: UuidFactory = randomUUID): string {
  return createPrefixedId("game", uuid);
}

export function createEventId(uuid: UuidFactory = randomUUID): string {
  return createPrefixedId("evt", uuid);
}

export function createChunkId(uuid: UuidFactory = randomUUID): string {
  return createPrefixedId("chk", uuid);
}

export function createObservationId(uuid: UuidFactory = randomUUID): string {
  return createPrefixedId("obs", uuid);
}
