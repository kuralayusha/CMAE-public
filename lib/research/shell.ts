import { spawn } from "child_process";
import { t } from "@/lib/i18n/t";
import { getJobSignal } from "./abort";
import { JobCanceledError, throwIfCanceled } from "./cancel";
import { emitLine } from "./events";
import { withAgent } from "./plain";

export async function runCurl(
  jobId: string,
  args: string[],
  opts?: { timeoutMs?: number; quietLog?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  throwIfCanceled(jobId);

  const display = `curl ${args.map(shellQuote).join(" ")}`;
  const targetUrl = args.find((a) => /^https?:\/\//i.test(a));
  if (!opts?.quietLog) {
    emitLine(
      jobId,
      "curl",
      t("terminal.detail.curlCmd", { cmd: display }),
      undefined,
      withAgent(
        targetUrl
          ? t("terminal.plain.downloadingPageScout", { url: targetUrl })
          : t("terminal.plain.fetchingDataScout"),
        "scout",
        t,
      ),
    );
  }

  const timeoutMs = opts?.timeoutMs ?? 45000;
  const signal = getJobSignal(jobId);

  try {
    const { stdout, stderr, code } = await spawnCurl(args, timeoutMs, signal, jobId);
    const out = stdout;
    const err = stderr.trim();
    if (err && !opts?.quietLog) {
      const preview = err.split("\n").slice(0, 3).join(" | ");
      emitLine(
        jobId,
        "system",
        t("terminal.detail.curlStderr", { preview: preview.slice(0, 240) }),
        undefined,
        withAgent(
          t("terminal.plain.downloadWarning", {
            preview: preview.slice(0, 100),
          }),
          "scout",
          t,
        ),
      );
    }
    if (!opts?.quietLog) {
      emitLine(
        jobId,
        "system",
        out.length
          ? t("terminal.detail.curlBytesPreview", {
              bytes: out.length,
              preview: compact(out, 120),
            })
          : t("terminal.detail.curlBytes", { bytes: out.length }),
        undefined,
        withAgent(
          out.length
            ? t("terminal.plain.pageFetched", {
                kb: Math.round(out.length / 1024),
              })
            : t("terminal.plain.pageEmpty"),
          "scout",
          t,
        ),
      );
    }
    return { stdout: out, stderr: err, code };
  } catch (e) {
    if (e instanceof JobCanceledError) throw e;
    const err = e as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    const stdout = err.stdout || "";
    const stderr = err.stderr || err.message || String(e);
    if (!opts?.quietLog) {
      emitLine(
        jobId,
        "err",
        t("terminal.detail.curlFailed", {
          code: err.code ?? "?",
          msg: compact(stderr, 200),
        }),
        undefined,
        withAgent(
          t("terminal.plain.downloadPageFailed", {
            msg: compact(stderr, 100),
          }),
          "scout",
          t,
        ),
      );
    }
    return { stdout, stderr, code: err.code ?? 1 };
  }
}

function spawnCurl(
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  jobId: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new JobCanceledError(jobId));
      return;
    }

    const child = spawn("curl", args, {
      env: { ...process.env, LANG: "C.UTF-8" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(() => reject(new JobCanceledError(jobId)));
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(() =>
        reject(
          Object.assign(new Error(`curl timeout after ${timeoutMs}ms`), {
            stdout,
            stderr,
            code: 28,
          }),
        ),
      );
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish(() =>
          reject(
            Object.assign(new Error("curl maxBuffer exceeded"), {
              stdout,
              stderr,
              code: 1,
            }),
          ),
        );
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      finish(() =>
        reject(
          Object.assign(err, {
            stdout,
            stderr: stderr || err.message,
            code: 1,
          }),
        ),
      );
    });

    child.on("close", (code) => {
      finish(() => {
        if (signal?.aborted) {
          reject(new JobCanceledError(jobId));
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr, code: 0 });
        } else {
          reject(
            Object.assign(new Error(`curl exited ${code}`), {
              stdout,
              stderr,
              code: code ?? 1,
            }),
          );
        }
      });
    });
  });
}

function shellQuote(s: string) {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function compact(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
