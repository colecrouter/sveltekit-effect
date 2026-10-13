import { defineConfig, type UserConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/server.ts", "src/dev.ts", "src/node.ts", "src/config.ts", "src/otel.ts"],
		dts: true,
		deps: {
			neverBundle: [
				"effect",
				"@sveltejs/kit",
				"$app/server",
				"@effect/opentelemetry",
				"@opentelemetry/api",
			],
		},
	},
	lint: { options: { typeAware: true, typeCheck: true } },
	test: { include: ["tests/**/*.test.ts"] },
	fmt: {
		useTabs: true,
	},
} satisfies UserConfig);
