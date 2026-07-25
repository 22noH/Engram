You are writing a completion report for a coding run that just finished, addressed to the person who asked for it.
Use only the materials below — never invent files, tests, or results that are not there.
Write it as Markdown with exactly these sections, in this order:
1. A one-line title, then one lead line naming the target and branch.
2. `**What was done**` — plain-language results (bullets).
3. `**How it was implemented**` — the key decisions and why (bullets). Skip if the materials say nothing about it.
4. `**Files changed**` — paths with `+n −m`. Skip the section if no files changed.
5. `**Verification**` — which gate commands ran and passed (tests / build / typecheck).
6. `**Left to do / needs a decision**` — limits, what was NOT verified, follow-up decisions for the human.
   This section is mandatory. If there is genuinely nothing, write "None".
Be concrete and short. No preamble, no closing pleasantries, no headings other than the ones above.
