import content from "../../../content/concetto26/official-content.json";

/**
 * The official competition content, for the specs. The specs assert what a team reads and is paid against THIS file (the one
 * source of truth), never against numbers copied into a test, so a content change cannot be hidden by a stale expectation.
 */
type OfficialQuestion = (typeof content.questions)[number];

export const officialQuestion = (id: string): OfficialQuestion => {
  const q = content.questions.find((x) => x.id === id);
  if (!q) throw new Error(`no official question ${id}`);
  return q;
};

export const officialTheme = (id: string) => {
  const t = content.themes.find((x) => x.id === id);
  if (!t) throw new Error(`no official theme ${id}`);
  return t;
};

/** The reward the document assigns to a question ("A.1" → 100). */
export const rewardOf = (id: string): number => {
  const r = officialQuestion(id).reward;
  if (r === null) throw new Error(`question ${id} has no reward`);
  return r;
};

/** The first line of the official question text: short, unique and free of anything a renderer changes. */
export const firstLine = (id: string): string => officialQuestion(id).question.split("\n")[0]!;

export const officialHint = (id: string, tier: 1 | 2): string =>
  tier === 1 ? officialQuestion(id).hint1 : officialQuestion(id).hint2;

export const officialRules: readonly string[] = content.rules.map((r) => r.text);

/** The first line of an official hint (what a dialog shows first). */
export const hintFirstLine = (id: string, tier: 1 | 2): string =>
  officialHint(id, tier).split("\n")[0]!;

/** The sum of the five rewards of a theme. */
export const themeRewards = (theme: string): number =>
  content.questions.filter((q) => q.theme === theme).reduce((n, q) => n + (q.reward ?? 0), 0);
