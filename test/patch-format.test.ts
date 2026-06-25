import { describe, expect, it } from "vitest";
import { hashLine, parsePatch } from "../src/api.js";

const row = (prefix: " " | "-" | "+", content: string) => prefix === "+" ? `${prefix}${content}` : `${prefix}${hashLine(content)}`;

describe("patch parser", () => {
  it("accepts Codex-style hash-only hunks", () => {
    const patch = parsePatch(["@@", row(" ", "ctx"), row("-", "old"), row("+", "new")].join("\n"));
    expect(patch.hunks[0].ops.map((op) => op.kind)).toEqual(["context", "delete", "insert"]);
  });

  it("allows separator in operation content", () => {
    const patch = parsePatch(["@@", row("+", "a│b")].join("\n"));
    expect(patch.hunks[0].ops[0].content).toBe("a│b");
  });

  it("rejects line-number hunk headers", () => {
    expect(() => parsePatch(`@@ -1,1 +1,1 @@\n${row(" ", "ctx")}`)).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects bad hashes and pasted hashline rows", () => {
    expect(() => parsePatch("@@\n abcd│ctx")).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch("@@\n a*c!│ctx")).toThrow("[E_INVALID_PATCH]");
    expect(() => parsePatch(`@@\n+${hashLine("actual")}│different`)).toThrow("[E_INVALID_PATCH]");
  });

  it("rejects file headers inside Update File sections", () => {
    const patch = ["--- a", "+++ b", "@@", row(" ", "ctx")].join("\n");
    expect(() => parsePatch(patch)).toThrow("[E_INVALID_PATCH]");
  });
});
