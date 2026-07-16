import { mkdir, cp, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const target = process.argv[2] || "all";

async function buildServer() {
  const outdir = path.join(root, "dist", "server");
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: [path.join(root, "apps", "server", "src", "index.ts")],
    outfile: path.join(outdir, "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: true,
    packages: "external"
  });
}

async function buildExtension() {
  const extensionRoot = path.join(root, "apps", "extension");
  const outdir = path.join(extensionRoot, "dist");
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: {
      "service-worker": path.join(extensionRoot, "src", "service-worker.ts"),
      popup: path.join(extensionRoot, "src", "popup.ts"),
      devtools: path.join(extensionRoot, "src", "devtools.ts"),
      panel: path.join(extensionRoot, "src", "panel.ts")
    },
    outdir,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "chrome118",
    sourcemap: true
  });
  for (const file of ["manifest.json", "popup.html", "devtools.html", "panel.html", "styles.css"]) {
    await cp(path.join(extensionRoot, file), path.join(outdir, file));
  }
}

if (target === "all" || target === "server") await buildServer();
if (target === "all" || target === "extension") await buildExtension();
