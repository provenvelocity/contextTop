---
applyTo: '**'
---

# How to Work With Me — Task Tracking & Detail Discipline

Two things matter on every single request, no matter how small: (1) I capture
**every** detail you gave, and (2) I track it in [TASKS.md](../../TASKS.md) at the
repo root. No reminders needed.
Keep all diagrams in mermaid form compatible with github markdown.

---

## 1. Capture EVERY detail (do this before writing any code)

You often pack several requirements into one sentence. I must not collapse them
into a single "big picture" task and lose the specifics. Before I start:

1. **Decompose** the request into a numbered checklist of *atomic* sub-requirements
   — one line per distinct thing you asked for.
2. **Watch for qualifiers** and make each its own checklist item. Common ones I
   have missed before:
   - **Role scope** — "for leads **and above**", "app admins only", "company admin can…"
   - **Placement** — "on the root page", "right after Truck", "in the Users screen not just the popup"
   - **Multiple locations** — "the items **and** needs-reorder should have a button" = TWO places
   - **Move vs add** — "moved **out of** Sheets" means REMOVE it there, not duplicate it
   - **Targets** — "sent to the vendor rep email **or** order email"
   - **Conditions** — "if they don't have a domain…", "only if I override…"
3. **Echo the checklist back to you** at the start of my reply, so you can catch a
   miss before I build. Format:
   > Here's what I captured: (1)… (2)… (3)… — building now.
4. If a detail is ambiguous, ask ONE focused question rather than guessing.

## 2. Verify against the original words before marking done

- Before checking any item off, **re-read your original message** and confirm each
  sub-requirement is actually satisfied — including every qualifier above.
- If I did the "main" thing but skipped a qualifier (wrong role scope, wrong
  placement, didn't remove the old one), it is **NOT done** — keep it In Progress.
- A parent task is only complete when **every** sub-item under it is verified.

## 3. Track it in TASKS.md

- **On request** — add each sub-requirement to `## In Progress` as its own line.
- **On completion** — move each verified item to the top of `## Completed`, check
  it `[x]`, and stamp the date.

### Format (one line each)

```markdown
- [ ] YYYY-MM-DD — **Short title** — the specific thing asked, incl. role/placement qualifiers
```

- In Progress date = date requested. Completed date = date finished.
- Newest completed items at the **top** of `## Completed`.

## 4. Rules

- ONE `## In Progress` section and ONE `## Completed` section — never duplicate headers.
- Never bundle several distinct asks into one vague line — split them.
- Always use today's real date (from context).
- Never delete history — completed tasks stay forever.
- Finish the whole request. Don't leave "TODO / next up" stubs — if I wrote it down,
  I do it in the same pass.
- at the end of a session please confirm that all tasks are either completed or properly tracked in `## In Progress`. if not completed please ask to complete them if they are not clear or complete them if clear deliverable is stated. 

## 5. Commits carry their TODO update

Every commit and its TASKS.md update land together as **one unit** — never split the
code change from its task record into separate commits.

- **Attach the TODO to the commit.** The commit message states what was done, and the
  **same commit** updates TASKS.md: move the finished `## In Progress` items to the top
  of `## Completed` (check `[x]`, stamp today's date), and add any newly-completed work
  as a Completed line.
- **Include uncommitted TODO edits.** Any TASKS.md changes not yet committed are staged
  and committed with the code they describe.
- **Use `push.sh`.** `./push.sh "Short title — what changed"` does this automatically: it
  records the message as a dated `## Completed` entry in TASKS.md, stages the code plus
  that task update, commits them as one unit, and pushes. Run `./push.sh` with **no
  argument** to build the commit message from the current `## In Progress` TODO statements
  instead. See also `scripts/release.sh` for a version-bumping, CI-validating release.
