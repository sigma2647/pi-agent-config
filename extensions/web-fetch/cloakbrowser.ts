// CloakBrowser resolver for pi-wf.
//
// CloakBrowser is a Chromium fork with 58 C++ source-level patches that
// eliminate bot detection signals at the binary level (navigator.webdriver,
// CDP leaks, TLS fingerprint, canvas/WebGL/audio fingerprinting, etc.).
// It exposes a Playwright-compatible API — no JS stealth injection needed.
//
// Install:
//   npm install cloakbrowser playwright-core
//
// First launch auto-downloads ~200MB binary to ~/.cloakbrowser.
// Use CLOAKBROWSER_BINARY_PATH to point at a pre-downloaded binary.

let cachedCB: Awaited<ReturnType<typeof import("cloakbrowser")>> | null | undefined;

export async function loadCloakBrowser() {
	if (cachedCB !== undefined) return cachedCB;
	try {
		const cb = await import("cloakbrowser");
		if (cb?.launch && cb?.launchPersistentContext) {
			cachedCB = cb;
			return cachedCB;
		}
	} catch {
		// not installed — normal, fall back to Playwright
	}
	cachedCB = null;
	return null;
}

export function cloakbrowserInstallHint(): string {
	return [
		"install CloakBrowser (stealth Chromium for pi-wf):",
		"  npm install cloakbrowser playwright-core --prefix /home/lawrence/pi-agent-config/extensions/web-fetch",
		"",
		"first launch auto-downloads the stealth binary (~200MB).",
		"if behind a proxy, pre-download with:",
		"  curl -x http://127.0.0.1:7890 -L -o /tmp/cb.tar.gz https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-linux-x64.tar.gz",
		"  mkdir -p ~/.cloakbrowser/chromium-146.0.7680.177.5",
		"  tar -xzf /tmp/cb.tar.gz -C ~/.cloakbrowser/chromium-146.0.7680.177.5",
		'  echo "146.0.7680.177.5" > ~/.cloakbrowser/latest_version_linux-x64',
	].join("\n");
}
