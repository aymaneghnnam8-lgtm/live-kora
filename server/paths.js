import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const root = process.env.VERCEL
  ? process.cwd()
  : path.resolve(here, "..");

export const dataDir = process.env.VERCEL
  ? path.join("/tmp", "live-kora")
  : path.join(root, "data");
