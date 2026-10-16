const { cpSync, existsSync, rmSync } = require("fs");
const { execFileSync } = require("child_process");
const path = require("path");

/**
 * electron-builder's default filters strip node_modules from extraResources.
 * Copy the prepared standalone payload (and Node binary) after pack.
 *
 * On macOS, clear extended attributes before codesign — otherwise:
 *   "resource fork, Finder information, or similar detritus not allowed"
 */
function clearXattrs(target) {
  if (process.platform !== "darwin" || !existsSync(target)) return;
  try {
    execFileSync("xattr", ["-cr", target], { stdio: "pipe" });
  } catch (err) {
    console.warn(
      `[afterPack] xattr -cr failed on ${target}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

exports.default = async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const isMac = context.electronPlatformName === "darwin";
  const isWin = context.electronPlatformName === "win32";
  const appName = context.packager.appInfo.productFilename;
  const resources = isMac
    ? path.join(context.appOutDir, `${appName}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");

  const srcStandalone = path.join(projectDir, "desktop-resources", "standalone");
  const nodeName = isWin ? "node.exe" : "node";
  const srcNode = path.join(projectDir, "desktop-resources", nodeName);
  const destStandalone = path.join(resources, "standalone");
  const destNode = path.join(resources, nodeName);

  if (!existsSync(srcStandalone)) {
    throw new Error(`Missing ${srcStandalone} — run desktop:prepare first`);
  }
  if (!existsSync(srcNode)) {
    throw new Error(`Missing ${srcNode} — run desktop:prepare first`);
  }

  // Strip quarantine / Finder xattrs from sources before they land in the .app
  if (isMac) {
    clearXattrs(path.join(projectDir, "desktop-resources"));
  }

  rmSync(destStandalone, { recursive: true, force: true });
  cpSync(srcStandalone, destStandalone, { recursive: true });
  cpSync(srcNode, destNode);
  console.log(`[afterPack] Copied standalone + ${nodeName} → ${resources}`);

  if (isMac) {
    const appPath = path.join(context.appOutDir, `${appName}.app`);
    clearXattrs(appPath);
    console.log(`[afterPack] Cleared xattrs on ${appPath} (pre-codesign)`);
  }
};
