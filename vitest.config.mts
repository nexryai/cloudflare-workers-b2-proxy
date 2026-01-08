import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        exclude: [...configDefaults.exclude, ".pnpm-wrangler/**", ".pnpm-store/**", "node_modules/**"],
    },
});
