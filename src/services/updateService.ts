/**
 * Update checker — fetches the latest release from GitHub and compares
 * with the current app version. Shows a banner if an update is available.
 */

const GITHUB_REPO = "flamme-demon/Sion-Cient";
const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

export interface UpdateInfo {
  version: string;
  downloadUrl: string;
  releaseUrl: string;
  notes: string;
}

let lastCheck = 0;
let cachedUpdate: UpdateInfo | null = null;

function getCurrentVersion(): string {
  // Injected by Vite from package.json
  return __APP_VERSION__;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function getAssetUrl(assets: { name: string; browser_download_url: string }[]): string {
  // Detect platform
  const isWindows = navigator.userAgent.includes("Windows");
  const isLinux = navigator.userAgent.includes("Linux");

  if (isWindows) {
    // Prefer NSIS exe, then MSI
    const nsis = assets.find((a) => a.name.endsWith(".exe") && !a.name.includes("uninstall"));
    if (nsis) return nsis.browser_download_url;
    const msi = assets.find((a) => a.name.endsWith(".msi"));
    if (msi) return msi.browser_download_url;
  }
  if (isLinux) {
    const appimage = assets.find((a) => a.name.endsWith(".AppImage"));
    if (appimage) return appimage.browser_download_url;
  }
  // Fallback: first asset or release page
  return assets[0]?.browser_download_url || "";
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const now = Date.now();
  if (now - lastCheck < CHECK_INTERVAL && cachedUpdate !== undefined) {
    return cachedUpdate;
  }
  lastCheck = now;

  try {
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const latestVersion = (data.tag_name || "").replace(/^v/, "");
    const currentVersion = getCurrentVersion();

    if (compareVersions(latestVersion, currentVersion) > 0) {
      cachedUpdate = {
        version: latestVersion,
        downloadUrl: getAssetUrl(data.assets || []),
        releaseUrl: data.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
        notes: data.body || "",
      };
      return cachedUpdate;
    }

    cachedUpdate = null;
    return null;
  } catch {
    return null;
  }
}
