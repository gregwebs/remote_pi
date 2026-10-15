import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lifecycleLogPath falls back to homedir only with a null override and unset
// REMOTE_PI_HOME. Six test files delete it; reused workers carry that deletion
// into the next file. Restore an existing sandbox per file, without loading src
// modules before that file's hoisted mocks can apply.
const home = process.env["REMOTE_PI_HOME"] || mkdtempSync(join(tmpdir(), "rp-vitest-home-"));
mkdirSync(home, { recursive: true });
process.env["REMOTE_PI_HOME"] = home;
