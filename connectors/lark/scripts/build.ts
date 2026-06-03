import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { builtinModules } from "node:module";

const watch = Deno.args.includes("--watch");
const configPath = `${Deno.cwd()}/deno.json`;

const nodeBuiltinModules = new Set(builtinModules);
const nodeBuiltinAliasPlugin: esbuild.Plugin = {
  name: "node-builtin-alias",
  setup(build) {
    build.onResolve({ filter: /^[^./][^:]*$/ }, (args) => {
      if (!nodeBuiltinModules.has(args.path)) {
        return undefined;
      }

      return {
        path: `node:${args.path}`,
        external: true,
      };
    });
  },
};

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
  plugins: [
    nodeBuiltinAliasPlugin,
    ...denoPlugins({
      configPath,
    }),
  ],
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
