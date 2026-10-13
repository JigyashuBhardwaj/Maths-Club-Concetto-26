// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DeletionScreen } from "@/components/deletion/deletion-screen";

// The real limit is 100 (asserted in tests/unit/deletion-contract.test.ts). A small stand-in keeps this test fast
// (a hundred clicks re-render a hundred rows in jsdom) while exercising the same code path.
vi.mock("@/lib/contracts/deletion", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MAX_DELETE_SELECTION: 3,
}));

const rows = Array.from({ length: 5 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  username: `admin_${i + 1}`,
  is_active: true,
  team_count: 0,
  created_at: 1,
}));

describe("selection limit", () => {
  it("never lets more than the limit be selected and offers no 'select all' for a longer list", () => {
    render(<DeletionScreen kind="admins" initialAdmins={rows} />);
    expect(screen.queryByRole("checkbox", { name: "Select all" })).not.toBeInTheDocument();
    for (let i = 1; i <= 3; i++)
      fireEvent.click(screen.getByRole("checkbox", { name: `Select admin_${i}` }));
    expect(screen.getByTestId("selected-count")).toHaveTextContent("3 selected");
    expect(screen.getByRole("checkbox", { name: "Select admin_4" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select admin_4" }));
    expect(screen.getByTestId("selected-count")).toHaveTextContent("3 selected");
    // unticking one frees a place
    fireEvent.click(screen.getByRole("checkbox", { name: "Select admin_1" }));
    expect(screen.getByRole("checkbox", { name: "Select admin_4" })).toBeEnabled();
  });
});
