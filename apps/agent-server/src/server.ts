import { buildApp } from "./app.js";
import { createConfig, loadWorkspaceEnvironment } from "./config.js";

loadWorkspaceEnvironment();
const config = createConfig();
const app = await buildApp({ config });

try {
	await app.listen({ host: config.host, port: config.port });
	process.stdout.write(`Assistant server listening on http://${config.host}:${config.port}\n`);
} catch {
	process.stderr.write("Assistant server could not start. Check the local port and data directory.\n");
	process.exitCode = 1;
}
