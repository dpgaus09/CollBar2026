import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

// The source uses ESM-style explicit ".js" import specifiers that actually
// point at sibling ".ts" files (TypeScript "bundler" resolution). Vite/Vitest
// will not rewrite those by default, so this tiny resolver maps a relative
// "<x>.js" import to "<x>.ts" when only the TypeScript file exists on disk.
function tsJsExtResolver(): Plugin {
  return {
    name: "ts-js-ext-resolver",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.startsWith(".") || !source.endsWith(".js")) {
        return null;
      }
      const tsPath = path.resolve(
        path.dirname(importer),
        source.replace(/\.js$/, ".ts"),
      );
      return existsSync(tsPath) ? tsPath : null;
    },
  };
}

export default defineConfig({
  plugins: [tsJsExtResolver()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
