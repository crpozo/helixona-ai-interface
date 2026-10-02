import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useVersionWatch } from "./useVersionWatch";
import { UpdateBanner } from "../components/UpdateBanner";

const versions: string[] = [];
vi.mock("./api", () => ({ getHealth: vi.fn(async () => ({ ok: true, version: versions.shift() ?? "same" })) }));

function Page() {
  const newVersion = useVersionWatch(true);
  return newVersion ? <UpdateBanner onReload={() => undefined} /> : <p>up to date</p>;
}

afterEach(cleanup);

describe("Noticing a new version", () => {
  it("says nothing while the server runs the version the page started with, and asks to reload once it changes", async () => {
    versions.push("abc123", "abc123", "def456");
    render(<Page />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("up to date")).toBeTruthy();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(screen.getByText("up to date")).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toContain("A new version of the assistant is ready");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("ignores a development server without a version", async () => {
    versions.push("dev", "dev", "dev");
    render(<Page />);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(screen.getByText("up to date")).toBeTruthy();
  });
});
