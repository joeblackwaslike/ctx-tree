# ctx-tree

## PR Review Routine

After every `git push` or `gh pr create`, create a beads tracking issue so review feedback doesn't get missed:

```bash
bd create --title="Check PR review feedback: <branch> (#<pr-number>)" --type=task --priority=2 --description="Review and address feedback from reviewers on PR #<number>. Check: gh pr view <number> --comments"
```

The StartSession hook in `.claude/settings.json` surfaces any open PRs with reviews at session start.
