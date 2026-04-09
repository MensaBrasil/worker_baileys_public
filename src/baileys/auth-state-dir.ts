import path from "path";

export function getAuthStateDir(): string {
  return path.resolve("auth");
}
