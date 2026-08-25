# Team workflow

Four people, one codebase. This is how we keep out of each other's way.

Repository: `https://github.com/gavhanemk/ld-erp-solution` (private)

---

## 1. Branches

There is one permanent branch.

**`main`** — always works. Vercel deploys it automatically. Never commit to it
directly. Never push to it directly.

Everything else is a short branch that lives a few days and then disappears.

### Naming

```
<type>/<module>-<short-thing>
```

`type` is one of five words:

| Type | For |
|------|-----|
| `feat` | A new feature |
| `fix` | Something broken |
| `refactor` | Tidying code, no change the user can see |
| `docs` | Only documentation |
| `chore` | Packages, config, tooling |

Examples that are right:

```
feat/purchase-grn
feat/inventory-stock-ledger
fix/sales-igst-split
refactor/masters-form-dialog
docs/build-rules
```

Examples that are wrong:

```
mahesh              (who, not what)
new-feature         (which feature?)
test123             (means nothing in three weeks)
purchase            (too broad — one branch per job)
```

### One branch, one job

A branch does one thing. If you are adding GRN and you notice the supplier form
is broken, that is a second branch. Do not mix them. Mixed branches are
impossible to review and impossible to undo.

### Starting a branch

Always start from a fresh `main`:

```bash
git checkout main
git pull
git checkout -b feat/purchase-grn
```

### Keeping it fresh

If your branch runs more than two days, pull `main` into it so you are not
building on old code:

```bash
git checkout main
git pull
git checkout feat/purchase-grn
git merge main
```

Fix any conflicts on your branch, not on `main`.

---

## 2. Commits

Small commits. One idea each. A commit that says "changes" helps nobody.

Format:

```
<verb in plain English, under 70 characters>

<blank line>
<why, if it is not obvious. Not what — the diff already says what.>
```

Good:

```
Stop the supplier form rejecting a lower-case GSTIN

The field was validated exactly as typed, so "27abcde1234f1z5" failed
with only "Invalid GSTIN" and no hint. Identifiers are now cleaned —
spaces removed, upper-cased — before the rule runs.
```

Bad:

```
fix
update files
wip
asdf
```

Do not commit commented-out code. Delete it. Git remembers it.

---

## 3. Pull requests

When the job is done:

```bash
git push -u origin feat/purchase-grn
```

Then open a pull request on GitHub into `main`.

### The description must answer three things

```markdown
## What
One or two lines. What can the user do now that they could not before?

## How to check it
Numbered steps someone else can follow on their machine.
1. Sign in as admin
2. Go to Purchase -> Goods Receipt
3. Pick PO/2627/0001, receive 40 of 50 pieces, save
4. Reopen the PO — it should show "Partly received"

## Anything to watch
Database changes, new settings, anything that could break something else.
Write "nothing" if there is nothing.
```

### Rules

- **One other person must approve** before it merges. Any of the four.
- **The author never approves their own.**
- **Approve means you actually ran it.** Not "the code looks fine". Pull the
  branch, start it, click the thing.
- **Merge with "Squash and merge".** One clean commit lands on `main`.
- **Delete the branch after merging.** GitHub offers a button.

### Reviewer checklist

Do not approve until every line is yes.

- [ ] I pulled the branch and it starts without errors
- [ ] I did the steps in "How to check it" and they worked
- [ ] No invented colours, fonts or sizes — see [Design rules](02-design-rules.md)
- [ ] Existing components reused, not rewritten
- [ ] Every new API route has `requirePermission(...)`
- [ ] Every create, update and delete calls `writeAuditLog(...)`
- [ ] No `.env`, password, key or token in the diff
- [ ] No `console.log` left behind (use `logger` on the API)
- [ ] Error messages are in plain English a mill clerk can act on
- [ ] [PROJECT_STATUS.md](../PROJECT_STATUS.md) updated if a module changed state

---

## 4. Splitting the work

Split by module, not by layer. One person owns purchase end to end — database,
API and screens. Do not have one person doing "all the backend" and another
doing "all the frontend"; every feature then needs both of them and both get
blocked.

Modules that do not touch each other can run in parallel safely:

| Safe together | Because |
|---|---|
| Purchase + HR | Nothing shared |
| Sales + Production | Different tables |
| Masters + anything | Masters are read-only to other modules |

Modules that fight each other — one person at a time:

| Careful | Because |
|---|---|
| Inventory + Purchase GRN | Both write stock |
| Inventory + Production | Both write stock |
| Anything + `schema.prisma` | Two migrations at once will clash |

### The schema rule

`packages/database/prisma/schema.prisma` is the one file everybody touches.

Before you change it, tell the team. Change it, migrate it, merge it the same
day. Do not sit on a schema change for a week — everyone else's branch goes
stale behind it.

---

## 5. What never enters the repository

- `.env` files of any kind. They are in `.gitignore`. Keep it that way.
- Passwords, API keys, tokens, connection strings.
- `node_modules`, `.next`, `dist` — all ignored already.
- Real customer or supplier data in test fixtures. Use made-up names.
- Anything downloaded from the old Absolute ERP.

If you commit a secret by accident, say so immediately. Do not quietly delete it
in the next commit — it stays in the history. The key has to be cancelled and a
new one issued.
