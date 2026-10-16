import { execFile } from "child_process";
import { promisify } from "util";
import { emitLine } from "./events";

const execFileAsync = promisify(execFile);

export async function runCurl(
  jobId: string,
  args: string[],
  opts?: { timeoutMs?: number; quietLog?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const display = `curl ${args.map(shellQuote).join(" ")}`;
  const targetUrl = args.find((a) => /^https?:\/\//i.test(a));
  if (!opts?.quietLog) {
    emitLine(
      jobId,
      "curl",
      `$ ${display}`,
      undefined,
      targetUrl
        ? `Downloading web page: ${targetUrl}. (Scout)`
        : "Fetching data from the internet. (Scout)",
    );
  }

  try {
    const { stdout, stderr } = await execFileAsync("curl", args, {
      timeout: opts?.timeoutMs ?? 45000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LANG: "C.UTF-8" },
    });
    const out = stdout.toString();
    const err = stderr.toString().trim();
    if (err && !opts?.quietLog) {
      const preview = err.split("\n").slice(0, 3).join(" | ");
      emitLine(
        jobId,
        "system",
        `  ↳ stderr: ${preview.slice(0, 240)}`,
        undefined,
        `Download warning: ${preview.slice(0, 100)}. (Scout)`,
      );
    }
    emitLine(
      jobId,
      "system",
      `  ↳ ${out.length} bytes${out.length ? ` · preview: ${compact(out, 120)}` : ""}`,
      undefined,
      out.length
        ? `Page fetched (${Math.round(out.length / 1024)} KB). (Scout)`
        : "Page came back empty. (Scout)",
    );
    return { stdout: out, stderr: err, code: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; code?: number; message?: string };
    const stdout = err.stdout?.toString() || "";
    const stderr = err.stderr?.toString() || err.message || String(e);
    emitLine(
      jobId,
      "err",
      `  ✖ curl failed (${err.code ?? "?"}): ${compact(stderr, 200)}`,
      undefined,
      `Could not download page: ${compact(stderr, 100)}. (Scout)`,
    );
    return { stdout, stderr, code: err.code ?? 1 };
  }
}

function shellQuote(s: string) {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function compact(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
