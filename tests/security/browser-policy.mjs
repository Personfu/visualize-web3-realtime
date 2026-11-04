import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const browserPin = JSON.parse(
  readFileSync(join(directory, "chrome-pin.json"), "utf8")
);

const VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;

function assertPatchedVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(
      "Browser version is missing or malformed; no page may open."
    );
  }
  const actual = version.split(".").map(Number);
  const minimum = browserPin.minimumVersion.split(".").map(Number);
  if (actual.some((part) => !Number.isSafeInteger(part))) {
    throw new Error("Browser version is outside the supported numeric range.");
  }
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] > minimum[index]) {
      return;
    }
    if (actual[index] < minimum[index]) {
      throw new Error(
        "Browser is vulnerable under the reviewed security floor; no page may open."
      );
    }
  }
}

function secureBrowserExecutable() {
  const platform = `${process.platform}-${process.arch}`;
  const pin = browserPin.platforms[platform];
  if (!pin) {
    throw new Error(
      "No reviewed Chrome pin for this platform; install no fallback."
    );
  }
  const root = resolve(
    directory,
    "../../.cache/security-chrome",
    browserPin.version,
    platform
  );
  const receipt = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
  const executable = join(root, pin.root, pin.executable);
  if (
    receipt.version !== browserPin.version ||
    receipt.archiveSha256 !== pin.sha256 ||
    realpathSync(executable) !== executable ||
    createHash("sha256").update(readFileSync(executable)).digest("hex") !==
      receipt.executableSha256
  ) {
    throw new Error("Browser receipt or executable integrity check failed.");
  }
  return executable;
}

export { browserPin, assertPatchedVersion, secureBrowserExecutable };
