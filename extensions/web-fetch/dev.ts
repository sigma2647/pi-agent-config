import { fetchAndExtract } from "./core.ts";

const url = process.argv[2];
if (!url) {
	console.error("usage: node --experimental-strip-types dev.ts <url>");
	process.exit(1);
}

const result = await fetchAndExtract(url);

if (result.error) {
	console.error(`ERROR: ${result.error}`);
	process.exit(1);
}

const header = result.title
	? `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n`
	: "";
process.stdout.write(header + result.content + "\n");
