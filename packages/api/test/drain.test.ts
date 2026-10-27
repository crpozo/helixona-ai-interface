import { describe, expect, it } from "vitest";
import { activeTurnCount, drainTurns, registerTurn } from "../src/routes/chat.js";

describe("draining turns on shutdown", () => {
  it("waits for turns that finish within the grace period, and hands the rest back with a restart", async () => {
    let restarted = 0;
    const quick = registerTurn({ restart: () => { restarted++; } });
    setTimeout(quick, 100); // finishes on its own
    const slow = registerTurn({ restart: () => { restarted++; slow(); } }); // only ends when told to restart
    expect(activeTurnCount()).toBe(2);
    const left = await drainTurns(600);
    expect(left).toBe(1);
    expect(restarted).toBe(1);
    expect(activeTurnCount()).toBe(0);
  });
  it("returns at once with nothing running", async () => {
    expect(await drainTurns(5_000)).toBe(0);
  });
});
