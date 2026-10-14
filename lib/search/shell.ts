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
        ? `Web sayfası indiriliyor: ${targetUrl}. (Keşif)`
        : "İnternetten veri indiriliyor. (Keşif)",
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
        `İndirme uyarısı: ${preview.slice(0, 100)}. (Keşif)`,
      );
    }
    emitLine(
      jobId,
      "system",
      `  ↳ ${out.length} bytes${out.length ? ` · preview: ${compact(out, 120)}` : ""}`,
      undefined,
      out.length
        ? `Sayfa alındı (${Math.round(out.length / 1024)} KB). (Keşif)`
        : "Sayfa boş geldi. (Keşif)",
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
      `Sayfa indirilemedi: ${compact(stderr, 100)}. (Keşif)`,
    );
    return { stdout, stderr, code: err.code ?? 1 };
  }
}

export async function runPython(
  jobId: string,
  script: string,
  opts?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const oneLiner = script.replace(/\s+/g, " ").trim();
  const shown =
    oneLiner.length > 180 ? `${oneLiner.slice(0, 180)}…` : oneLiner;
  emitLine(
    jobId,
    "python",
    `$ python3 -c ${shellQuote(shown)}`,
    undefined,
    "Metin içinde e-posta ve kalıplar taranıyor. (İletişim)",
  );

  try {
    const { stdout, stderr } = await execFileAsync("python3", ["-c", script], {
      timeout: opts?.timeoutMs ?? 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const out = stdout.toString().trim();
    if (out) {
      let countHint = "";
      try {
        const parsed = JSON.parse(out) as unknown;
        if (Array.isArray(parsed)) countHint = ` ${parsed.length} sonuç.`;
      } catch {
        /* ignore */
      }
      emitLine(
        jobId,
        "system",
        `  ↳ ${compact(out, 300)}`,
        undefined,
        `Tarama bitti.${countHint} (İletişim)`,
      );
    }
    if (stderr.toString().trim()) {
      emitLine(
        jobId,
        "system",
        `  ↳ py-stderr: ${compact(stderr.toString(), 160)}`,
        undefined,
        `Tarama uyarısı: ${compact(stderr.toString(), 100)}. (İletişim)`,
      );
    }
    return { stdout: out, stderr: stderr.toString(), code: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; code?: number; message?: string };
    emitLine(
      jobId,
      "err",
      `  ✖ python failed: ${compact(err.stderr?.toString() || err.message || String(e), 220)}`,
      undefined,
      "Tarama scripti hata verdi. (İletişim)",
    );
    return {
      stdout: err.stdout?.toString() || "",
      stderr: err.stderr?.toString() || String(e),
      code: err.code ?? 1,
    };
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
