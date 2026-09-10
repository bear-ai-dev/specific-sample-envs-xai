import { chmodSync, mkdirSync } from "node:fs";

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function ensurePrivateFile(path: string): void {
  chmodSync(path, 0o600);
}
