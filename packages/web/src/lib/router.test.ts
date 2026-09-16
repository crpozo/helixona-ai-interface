import { describe, expect, it } from "vitest";
import { documentSlug, normalizeRoute } from "./router";

describe("router", () => {
  it("maps paths to routes", () => {
    expect(normalizeRoute("/")).toBe("/");
    expect(normalizeRoute("/login")).toBe("/login");
    expect(normalizeRoute("/admin/users")).toBe("/admin");
    expect(normalizeRoute("/documentation")).toBe("/documentation");
    expect(normalizeRoute("/documentation/risk-analysis")).toBe("/documentation");
    expect(normalizeRoute("/documentationx")).toBe("/");
  });

  it("reads the document slug", () => {
    expect(documentSlug("/documentation")).toBeNull();
    expect(documentSlug("/documentation/")).toBeNull();
    expect(documentSlug("/documentation/risk-analysis")).toBe("risk-analysis");
    expect(documentSlug("/documentation/risk-analysis/")).toBe("risk-analysis");
    expect(documentSlug("/documentation/a/b")).toBeNull();
    expect(documentSlug("/documentation/%E2%9C%93")).toBe("✓");
    expect(documentSlug("/documentation/%zz")).toBeNull();
    expect(documentSlug("/admin")).toBeNull();
  });
});
