// Shared Playwright resolver for pi-wf.
// Re-exports from common utilities.

import { isArchLinux } from "../_common/playwright-utils.ts";

export {
	loadPlaywright,
	isArchLinux,
	getPlaywrightVersion,
	getPlaywrightExecutablePath,
	decodeBingUrl,
} from "../_common/playwright-utils.ts";

export function playwrightInstallHint(): string {
	if (isArchLinux()) {
		return [
			"install on Arch:",
			"  sudo pacman -S playwright chromium",
			"system chromium auto-detected at /usr/bin/chromium",
		].join("\n");
	}
	return "install with: npm i -g playwright && npx playwright install chromium";
}
