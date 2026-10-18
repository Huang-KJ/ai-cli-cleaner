import { describe, expect, it } from "vitest";
import { asIso, asString, cleanTitle, firstDate, firstString, isRecord, toError } from "../src/conversations/metadata-values.js";

describe("conversation metadata values", () => {
  it("skips blank and non-text values while retaining the original selected text", () => {
    expect(asString(" \t\n ")).toBeUndefined();
    expect(asString(42)).toBeUndefined();
    expect(asString("  selected  ")).toBe("  selected  ");
    expect(firstString({ first: " ", second: 42, third: "  selected  ", fourth: "later" },
      ["first", "second", "third", "fourth"])).toBe("  selected  ");
  });

  it("keeps seconds, milliseconds and ISO text date interpretation consistent", () => {
    expect(asIso(1_791_158_400)).toBe("2026-10-05T00:00:00.000Z");
    expect(asIso(1_791_158_400_000)).toBe("2026-10-05T00:00:00.000Z");
    expect(asIso("2026-10-05T08:00:00+08:00")).toBe("2026-10-05T00:00:00.000Z");
    expect(asIso(10_000_000_000)).toBe("1970-04-26T17:46:40.000Z");
    expect(asIso(-1)).toBe("1969-12-31T23:59:59.000Z");
    expect(asIso(Infinity)).toBeUndefined();
    expect(firstDate({ first: "invalid", second: [], third: 0 }, ["first", "second", "third"]))
      .toBe("1970-01-01T00:00:00.000Z");
  });

  it("normalizes title spacing, preserves the 64-character boundary and handles absent titles", () => {
    expect(cleanTitle(undefined, "fallback")).toBe("fallback");
    expect(cleanTitle(" \n\t ", "fallback")).toBe("fallback");
    expect(cleanTitle("  first\n\tsecond  ", "fallback")).toBe("first second");
    expect(cleanTitle("x".repeat(64), "fallback")).toBe("x".repeat(64));
    expect(cleanTitle("x".repeat(65), "fallback")).toBe(`${"x".repeat(61)}...`);
  });

  it("distinguishes records from arrays, null and primitive values", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("record")).toBe(false);
  });

  it("retains Error identity and wraps non-Error failures", () => {
    const error = new Error("original");
    expect(toError(error)).toBe(error);
    expect(toError("failure").message).toBe("failure");
  });
});
