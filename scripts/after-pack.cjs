const { cpSync, existsSync, rmSync } = require("fs");
const path = require("path");

/**
 * electron-builder's default filters strip node_modules from extraResources.
 * Copy the prepared standalone payload (and Node binary) after pack.
 */
exports.default = async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const isMac = context.electronPlatformName === "darwin";
  const isWin = context.electronPlatformName === "win32";
  const resources = isMac
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents",
        "Resources",
      )
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

  rmSync(destStandalone, { recursive: true, force: true });
  cpSync(srcStandalone, destStandalone, { recursive: true });
  cpSync(srcNode, destNode);
  console.log(`[afterPack] Copied standalone + ${nodeName} → ${resources}`);
};
