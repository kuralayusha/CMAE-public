/**
 * macOS notarization after electron-builder pack.
 * Skips when Apple secrets are absent, or when the .app is not
 * Developer ID signed (unsigned local builds still hit afterSign).
 */
const { execFileSync } = require("child_process");

function isDeveloperIdSigned(appPath) {
  try {
    const result = execFileSync("codesign", ["-dv", "--verbose=2", appPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = `${result.stdout || ""}${result.stderr || ""}`;
    return /Authority=Developer ID Application/i.test(out);
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    return /Authority=Developer ID Application/i.test(out);
  }
}

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  if (!isDeveloperIdSigned(appPath)) {
    console.log(
      "[notarize] app is not Developer ID signed (unsigned/adhoc) — skip",
    );
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log(
      "[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID missing — skip",
    );
    return;
  }

  const { notarize } = require("@electron/notarize");
  console.log(`[notarize] submitting ${appPath}`);
  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
  console.log("[notarize] complete");
};
