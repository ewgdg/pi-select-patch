import { describe, expect, it } from "vitest";
import { hashLengthForLine, hashLine, parseHashLine, renderHashLines, toHashLines } from "../src/api.js";

describe("read format", () => {
  it("renders variable HASH│content rows with entropy-sized hashes", () => {
    const lines = ["alpha", "", "const enabled = true;", "function parsePatchOp(line: string): PatchOp {"];
    const entries = toHashLines(lines);
    expect(hashLengthForLine(lines[0])).toBe(2);
    expect(hashLengthForLine(lines[1])).toBe(1);
    expect(hashLengthForLine(lines[2])).toBe(3);
    expect(hashLengthForLine(lines[3])).toBe(4);
    expect(renderHashLines(entries)).toBe([
      `${hashLine(lines[0]).slice(0, 2)}│alpha`,
      `${hashLine(lines[1]).slice(0, 1)}│`,
      `${hashLine(lines[2]).slice(0, 3)}│${lines[2]}`,
      `${hashLine(lines[3])}│${lines[3]}`
    ].join("\n"));
  });

  it("parses content containing separator by splitting once", () => {
    const parsed = parseHashLine(`${hashLine("a│b")}│a│b`);
    expect(parsed).toEqual({ hash: hashLine("a│b"), content: "a│b" });
  });

  it("rejects malformed selectors", () => {
    expect(() => parseHashLine("abcde│bad width")).toThrow("[E_INVALID_PATCH]");
    expect(() => parseHashLine("abcd missing separator")).toThrow("[E_INVALID_PATCH]");
  });
});
