import { cpSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dist", "apps", "console", "src", "static"), { recursive: true });
cpSync(join(root, "apps", "console", "static"), join(root, "dist", "apps", "console", "src", "static"), { recursive: true });
process.stdout.write("static: console bundle copied to dist\n");
