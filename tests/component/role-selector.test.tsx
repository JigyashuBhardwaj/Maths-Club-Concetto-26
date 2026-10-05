// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RoleSelector } from "@/components/landing/role-selector";

describe("<RoleSelector />", () => {
  it("renders the three roles as links in order with login routes", () => {
    render(<RoleSelector />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Superadmin", "Admin", "Participant"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/login/superadmin",
      "/login/admin",
      "/login/participant",
    ]);
  });

  it("is a labelled navigation landmark", () => {
    render(<RoleSelector />);
    expect(screen.getByRole("navigation", { name: "Select your role" })).toBeInTheDocument();
  });

  it("marks the clicked role as selected", () => {
    const { container } = render(<RoleSelector />);
    // jsdom cannot navigate; swallow the default action so only our handler is under test.
    container.addEventListener("click", (e) => e.preventDefault());
    const admin = screen.getByRole("link", { name: "Admin" });
    expect(admin).not.toHaveClass("is-selected");
    fireEvent.click(admin);
    expect(admin).toHaveClass("is-selected");
    expect(screen.getByRole("link", { name: "Participant" })).not.toHaveClass("is-selected");
  });
});
