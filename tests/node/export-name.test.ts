import { describe, expect, it } from "vitest";
import { friendlyGlbName } from "../../src/io/exportFlow";

describe("friendlyGlbName", () => {
  it("makes a plain file name from a scene name", () => {
    expect(friendlyGlbName("arthalune crate")).toBe("arthalune-crate.glb");
    expect(friendlyGlbName("  My Crate!! ")).toBe("My-Crate.glb");
  });
  it("drops accents the same way the gateway does", () => {
    expect(friendlyGlbName("Café au lait")).toBe("Cafe-au-lait.glb");
  });
  it("keeps non-latin letters and falls back when nothing is left", () => {
    expect(friendlyGlbName("日本語")).toBe("日本語.glb");
    expect(friendlyGlbName("???")).toBeUndefined();
    expect(friendlyGlbName(undefined)).toBeUndefined();
  });
});
