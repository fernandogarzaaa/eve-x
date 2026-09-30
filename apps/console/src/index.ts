import express, { type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// dist layout: dist/apps/console/src/index.js → here=dist/apps/console/src.
// Prefer shipped static next to the bundle, then the source tree.
const candidates = [
  join(here, "static"),
  join(here, "..", "..", "..", "..", "apps", "console", "static"),
];

const INDEX_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta http-equiv="refresh" content="0;url=/" /><title>EVE-X console</title></head><body>console static bundle missing — rebuild console static files.</body></html>`;

function resolveStaticDir(): string {
  for (const c of candidates) {
    try {
      if (existsSync(join(c, "index.html"))) return c;
    } catch { /* ignore */ }
  }
  const fallback = candidates[1] as string;
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

function ensureStaticFiles(dir: string): void {
  // The canonical index.html/app.js live next to this source file; when the
  // server runs from dist without copied assets, plant a marker so / still serves.
  if (!existsSync(join(dir, "index.html"))) {
    writeFileSync(join(dir, "index.html"), INDEX_HTML, "utf8");
  }
  if (!existsSync(join(dir, "app.js"))) {
    writeFileSync(join(dir, "app.js"), "console.log('eve-x console bundle');\n", "utf8");
  }
}

export function buildConsoleApp(staticDir?: string): express.Express {
  const dir = staticDir ?? resolveStaticDir();
  ensureStaticFiles(dir);
  const app = express();
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "evex-console", at: new Date().toISOString() });
  });
  app.use("/", express.static(dir, { extensions: ["html"], maxAge: 0 }));
  app.get("/config.js", (_req: Request, res: Response) => {
    res.type("application/javascript").send(
      `window.EVEX = ${JSON.stringify({ apiBase: process.env["EVEX_API_URL"] ?? "http://localhost:8080" })};\n`,
    );
  });
  return app;
}

export async function startConsole(port?: number): Promise<Server> {
  const app = buildConsoleApp();
  const srv = createServer(app);
  const p = port ?? Number(process.env["CONSOLE_PORT"] ?? process.env["PORT"] ?? 3000);
  await new Promise<void>((resolve) => srv.listen(p, resolve));
  const dir = resolveStaticDir();
  let files = 0;
  try {
    files = readFileSync(join(dir, "index.html"), "utf8").length;
  } catch { files = 0; }
  process.stdout.write(`[console] serving ${dir} (${files} bytes index) on :${p}\n`);
  return srv;
}

const _entry = (process.argv[1] ?? "").replace(/\\/g, "/");
const isMain = _entry.endsWith("apps/console/index.js") ||
  _entry.endsWith("apps/console/src/index.js");
if (isMain) {
  startConsole().catch((err) => {
    process.stderr.write(`[console] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
