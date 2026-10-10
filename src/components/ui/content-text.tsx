import "./content-text.css";

/**
 * A line that was laid out with spaces (a table, an aligned matrix, an indented formula): kept in a monospace block so the
 * columns stay where the author put them. Ordinary prose never has a run of three spaces.
 */
export function isPreformattedLine(line: string): boolean {
  return /^ {3,}\S/.test(line) || /\S {3,}\S/.test(line);
}

type Block = { pre: boolean; lines: string[] };

/** Splits text into alternating prose blocks and monospace blocks (one block per run of the same kind). */
export function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    const pre = isPreformattedLine(line);
    const last = blocks.at(-1);
    if (last && last.pre === pre) last.lines.push(line);
    else blocks.push({ pre, lines: [line] });
  }
  return blocks;
}

/**
 * Competition text (a question, a hint, a rule) exactly as written. It is rendered as React text nodes only (never parsed
 * as HTML or Markdown), so nothing in it can inject markup, and every character — Greek letters, sub/superscripts, ₹, roots,
 * integrals, matrices written as [[a, b], [c, d]] — is shown as it was typed. Line breaks and indentation are kept; lines laid
 * out with spaces (payoff tables, indented formulas) are shown in a monospace block that scrolls sideways on a narrow screen.
 */
export function ContentText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `content-text ${className}` : "content-text"}>
      {splitBlocks(text).map((block, i) =>
        block.pre ? (
          <pre key={i} className="content-pre" tabIndex={0} aria-label="Formatted lines">
            {block.lines.join("\n")}
          </pre>
        ) : (
          <p key={i} className="content-p">
            {block.lines.join("\n")}
          </p>
        ),
      )}
    </div>
  );
}
