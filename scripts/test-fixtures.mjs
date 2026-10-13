/** Exercise real Kit 2/3 builds, generated types, SSR and remote HTTP execution. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const command = async (args, cwd) => {
	const child = spawn("vp", args, { cwd, stdio: "inherit" });
	const [code] = await once(child, "exit");
	assert.equal(code, 0, `vp ${args.join(" ")} failed`);
};

for (const name of ["kit2", "kit3"]) {
	const cwd = `${root}/fixtures/${name}`;
	await command(["run", "check"], cwd);
	await command(["run", "build"], cwd);

	// Read the generated remote identity instead of assuming SvelteKit's hash algorithm.
	const files = await readdir(`${cwd}/build/server`, { recursive: true });
	const manifestFile = files.find((file) => /(?:^|\/)manifest\.js(?:-|$)/.test(file));
	assert.ok(manifestFile, "adapter-node manifest was not generated");
	const manifestModule = await import(pathToFileURL(`${cwd}/build/server/${manifestFile}`).href);
	const manifest = Object.values(manifestModule).find(
		(value) => value && typeof value === "object" && ("appPath" in value || "app_path" in value),
	);
	assert.ok(manifest, "adapter-node manifest has no recognized app path");
	const remoteHash = Object.keys(manifest.remotes ?? manifest._.remotes)[0];
	assert.ok(remoteHash, "fixture remote module was not registered");

	// Reserve an available port briefly; test servers never use a fixed user port.
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const port = probe.address().port;
	probe.close();
	await once(probe, "close");
	const origin = `http://127.0.0.1:${port}`;
	const server = spawn(process.execPath, ["build/index.js"], {
		cwd,
		env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), ORIGIN: origin },
		stdio: "inherit",
	});
	const exited = once(server, "exit");
	try {
		let response;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				response = await fetch(`${origin}/proof`);
				break;
			} catch {
				await delay(50);
			}
		}
		assert.ok(response, `${name} server did not start`);
		assert.equal(response.status, 200);
		const html = await response.text();
		assert.ok(html.includes("proof:retained:retained"));
		assert.ok(html.includes("3000:"));
		assert.ok(
			!html.includes("fixture-secret"),
			"private values must stay redacted during serialization",
		);
		const remote = await fetch(`${origin}/_app/remote/${remoteHash}/remoteThing`);
		assert.equal(remote.status, 200);
		assert.ok((await remote.text()).includes("retained"));
		console.log(`${name}: generated types, production SSR and remote HTTP passed`);
	} finally {
		server.kill("SIGTERM");
		// Force cleanup if graceful shutdown unexpectedly stalls.
		const deadline = setTimeout(() => server.kill("SIGKILL"), 5000);
		try {
			await exited;
		} finally {
			clearTimeout(deadline);
		}
	}
}
