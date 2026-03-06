import { build as esbuild } from "esbuild";
import { rm, readFile } from "fs/promises";

async function buildApi() {
  await rm("dist", { recursive: true, force: true });

  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const externals = Object.keys(pkg.dependencies || {});

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    external: externals,
    logLevel: "info",
  });
}

buildApi().catch((err) => {
  console.error(err);
  process.exit(1);
});