# Working rules for this repo

## Review before every merge (owner's standing instruction)

Every change gets an independent review by the `code-reviewer` agent (`.claude/agents/code-reviewer.md`)
before it is merged or offered for merging:

1. Finish the change and run `npm test` and `npx playwright test`.
2. Run the `code-reviewer` agent on the diff against `main`.
3. Fix the real findings (or explain why a finding is not real), re-run the tests, push.
4. Only then tell the owner the PR is ready to merge, with a short summary of what the review found.

Never merge or call a PR "ready" without step 2, even for small changes.
