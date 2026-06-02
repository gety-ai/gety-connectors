import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";

const watch = Deno.args.includes("--watch");
const configPath = `${Deno.cwd()}/deno.json`;

const options: esbuild.BuildOptions = {
  entryPoints: ["src/index.ts"],
  outfile: "dist/main.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  treeShaking: true,
  sourcemap: true,
  sourcesContent: true,
  external: ["@gety-ai/connector-sdk"],
  plugins: denoPlugins({
    configPath,
  }),
  logLevel: "info",
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Watching src/index.ts and dependencies...");
} else {
  await esbuild.build(options);
  esbuild.stop();
}
