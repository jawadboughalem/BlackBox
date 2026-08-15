import { defineConfig, type Options } from "tsup";

const shared: Options = {
  format: ["esm"],
  target: "node20",
  platform: "node",
  sourcemap: true,
  dts: true,
  // Both entries build in parallel, so neither may `clean` the shared output
  // folder — `npm run build` wipes `dist/` up front instead.
  clean: false,
};

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
  },
  {
    ...shared,
    entry: { cli: "src/cli.ts" },
    banner: { js: "#!/usr/bin/env node" },
  },
]);
