// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameProvider, HEARTBEAT_MS } from "@/components/game/game-provider";

import { snapshot } from "./support/game";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          data: String(url).includes("heartbeat") ? { server_now: 1 } : snapshot(),
          server_now: 1,
        }),
        { status: 200 },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const beats = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/p/heartbeat");

describe("presence heartbeat of the participant pages", () => {
  it("beats on load and every 25 s, POST with no body, and stops when the page is left", async () => {
    expect(HEARTBEAT_MS).toBe(25_000); // well inside the 75 s the Admin matrix waits before showing OUT
    const { unmount } = render(
      <GameProvider initial={snapshot()}>
        <p>page</p>
      </GameProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(beats()).toHaveLength(1);
    expect((beats()[0]![1] as RequestInit).method).toBe("POST");
    expect((beats()[0]![1] as RequestInit).body).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    });
    expect(beats()).toHaveLength(4);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    });
    expect(beats()).toHaveLength(4);
  });

  it("a failed heartbeat is silent and the next one still goes out", async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("heartbeat")
        ? Promise.reject(new TypeError("offline"))
        : Promise.resolve(
            new Response(JSON.stringify({ ok: true, data: snapshot(), server_now: 1 })),
          ),
    );
    render(
      <GameProvider initial={snapshot()}>
        <p>page</p>
      </GameProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    });
    expect(beats()).toHaveLength(3);
  });
});
