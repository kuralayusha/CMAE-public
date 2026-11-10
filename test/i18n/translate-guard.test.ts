import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_BODY_BYTES,
  SlidingWindowLimiter,
  clientIp,
  parseTranslateBody,
  readLimitedText,
  validateTargetLanguage,
} from "../../lib/i18n/translate-guard";

describe("validateTargetLanguage", () => {
  it("accepts supported codes and normalises case", () => {
    assert.deepEqual(validateTargetLanguage("tr"), { ok: true, value: "tr" });
    assert.deepEqual(validateTargetLanguage(" pt-BR "), {
      ok: true,
      value: "pt-br",
    });
    assert.deepEqual(validateTargetLanguage("zh-Hant"), {
      ok: true,
      value: "zh-hant",
    });
  });
  it("rejects empty, non-string, malformed and unsupported values", () => {
    const bad = [
      "",
      "  ",
      5,
      null,
      undefined,
      "t",
      "tr_TR",
      "tr-",
      "english",
      "xx",
      "tr; drop",
      "a".repeat(40),
    ];
    for (const b of bad) {
      const r = validateTargetLanguage(b);
      assert.equal(r.ok, false, String(b));
      if (!r.ok) assert.equal(r.status, 400);
    }
  });
});

describe("parseTranslateBody", () => {
  it("accepts the shape real callers send", () => {
    assert.deepEqual(parseTranslateBody('{"targetLanguage":"de"}'), {
      ok: true,
      value: { targetLanguage: "de" },
    });
  });
  it("returns 413 for oversized bodies", () => {
    const r = parseTranslateBody(
      JSON.stringify({ targetLanguage: "de", pad: "x".repeat(MAX_BODY_BYTES) }),
    );
    assert.equal(r.ok === false && r.status, 413);
  });
  it("returns 400 for bad JSON, arrays and too many keys", () => {
    const raws = [
      "",
      "nope",
      "[]",
      "null",
      '{"a":1,"b":2,"c":3,"d":4,"e":5,"targetLanguage":"de"}',
    ];
    for (const raw of raws) {
      const r = parseTranslateBody(raw);
      assert.equal(r.ok === false && r.status, 400, raw);
    }
  });
});

describe("readLimitedText", () => {
  it("rejects streamed bodies over the limit", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      body: "y".repeat(50),
    });
    const r = await readLimitedText(req, 10);
    assert.equal(r.ok === false && r.status, 413);
  });
  it("reads small bodies", async () => {
    const req = new Request("http://x/", { method: "POST", body: "hi" });
    assert.deepEqual(await readLimitedText(req), { ok: true, value: "hi" });
  });
});

describe("SlidingWindowLimiter", () => {
  it("blocks after the limit and recovers when the window slides", () => {
    const l = new SlidingWindowLimiter(2, 1000);
    assert.equal(l.check("a", 0).allowed, true);
    assert.equal(l.check("a", 100).allowed, true);
    const blocked = l.check("a", 200);
    assert.equal(blocked.allowed, false);
    if (!blocked.allowed) assert.equal(blocked.retryAfterSec, 1);
    assert.equal(l.check("b", 200).allowed, true); // other IPs unaffected
    assert.equal(l.check("a", 1001).allowed, true); // first hit expired
  });
  it("bounds memory by key count", () => {
    const l = new SlidingWindowLimiter(1, 10_000, 5);
    for (let i = 0; i < 50; i++) l.check(`ip${i}`, i);
    const size = (l as unknown as { hits: Map<string, number[]> }).hits.size;
    assert.ok(size <= 5);
  });
});

describe("clientIp", () => {
  it("prefers the first x-forwarded-for hop", () => {
    assert.equal(
      clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })),
      "1.2.3.4",
    );
    assert.equal(clientIp(new Headers({ "x-real-ip": "9.9.9.9" })), "9.9.9.9");
    assert.equal(clientIp(new Headers()), "unknown");
  });
});
