import { describe, expect, it } from "vitest";
import { matchesQuery } from "./search";

describe("search", () => {
  it("ignores case and accents, and needs every word", () => {
    expect(matchesQuery("EOBs de María, marzo", "maria eob")).toBe(true);
    expect(matchesQuery("EOBs de María, marzo", "maria abril")).toBe(false);
    expect(matchesQuery("Anything", "   ")).toBe(true);
  });
});
