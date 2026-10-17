// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RulesButton } from "@/components/home/rules-dialog";
import { TicketSpiral } from "@/components/home/ticket-spiral";
import { OFFICIAL_RULES } from "@/lib/content/official-public";

import { Game, makeClient, makeEconomy, snapshot } from "./support/game";

/**
 * After a renewal the participant app must show what the Super Admin published: the theme names from the team snapshot (the
 * database) and the rules read from the database, not the text compiled into the build.
 */
const client = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("@/lib/gameplay/client", () => client);
const economy = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock("@/lib/economy/client", () => economy);
const c = makeClient();
const eco = makeEconomy();

let current = snapshot();

beforeEach(() => {
  Object.assign(client, {
    fetchTeamState: c.fetchTeamState,
    sendHeartbeat: c.sendHeartbeat,
    enterCompetition: c.enterCompetition,
    unlockThemeCall: c.unlockThemeCall,
  });
  Object.assign(economy, eco);
  c.fetchTeamState.mockReset();
  c.fetchTeamState.mockImplementation(async () => c.ok(current));
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        matches: q.includes("reduce"),
        addEventListener() {},
        removeEventListener() {},
        media: q,
      }) as unknown as MediaQueryList,
  );
});

describe("theme names come from the database snapshot", () => {
  it("a renamed theme shows on its ticket, as its tooltip and as the dialog heading; the others keep theirs", () => {
    const initial = snapshot();
    current = initial;
    initial.themes[2]!.name = "BRAND NEW THEME C — “renamed”";
    initial.themes[2]!.description = "A renamed description\nwith two lines.";
    render(
      <Game initial={initial}>
        <TicketSpiral />
      </Game>,
    );
    const ticket = screen.getByRole("button", { name: "BRAND NEW THEME C — “renamed”" });
    expect(ticket).toHaveAttribute("title", "BRAND NEW THEME C — “renamed”");
    expect(ticket.querySelector(".ticket-stub")).toHaveTextContent("C"); // the id stays the key
    expect(screen.queryByRole("button", { name: "END SEM FEAR TAKEOVER" })).toBeNull(); // the old name is gone
    fireEvent.click(ticket);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("h2")).toHaveTextContent("BRAND NEW THEME C — “renamed”");
    expect(dialog).toHaveTextContent("A renamed description");
    expect(screen.getByRole("button", { name: initial.themes[0]!.name })).toBeInTheDocument();
  });
});

describe("the rules in force", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Rules and regulations" }));

  it("shows the rules it is given, in order, with their line breaks and punctuation", () => {
    const rules = [
      "First renewed rule.",
      "Second: “quoted”, (with) punctuation!\nand a second line",
      "Third",
    ];
    render(<RulesButton rules={rules} />);
    open();
    const items = screen.getAllByRole("listitem", { hidden: true }).map((li) => li.textContent);
    expect(items).toEqual(rules);
    expect(items).not.toContain(OFFICIAL_RULES[0]);
  });

  it("without rules (never renewed) shows the official ones", () => {
    render(<RulesButton />);
    open();
    expect(screen.getAllByRole("listitem", { hidden: true })).toHaveLength(OFFICIAL_RULES.length);
  });

  it("says so, and shows no possibly outdated text, when the rules could not be read", () => {
    render(<RulesButton rules={null} />);
    open();
    expect(screen.getByText(/The rules could not be loaded/)).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem", { hidden: true })).toHaveLength(0);
  });
});
