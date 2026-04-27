import path from "node:path";

export function getAuthStateDir(): string {
  return path.resolve("auth");
}
