# Git commands

The commands, in the order you actually need them. [Team workflow](01-team-workflow.md)
explains why the rules are what they are; this page is for when you know the rule
and just want the line to type.

Everything here is run from the project folder.

---

## The one rule, in one line

Never push to `main`. Branch, push the branch, raise a pull request.

A check on your own machine refuses a direct push to `main` and tells you what to
do instead. It is switched on by `pnpm install`. If it ever seems to be off:

```bash
git config core.hooksPath .githooks
```

---

## 1. Starting a job

Always start from a fresh `main`, or you are building on last week's code:

```bash
git checkout main
git pull
git checkout -b feat/inventory-stock-ledger
```

The name is `<type>/<module>-<short-thing>`, and `type` is one of `feat`, `fix`,
`refactor`, `docs`, `chore`. One branch does one job.

---

## 2. While you work

See what you have changed:

```bash
git status              # which files
git diff                # what changed in them
git diff --stat         # just the sizes, when the diff is long
```

Commit a piece at a time rather than everything at the end:

```bash
git add apps/api/src/routes/purchase.routes.ts
git commit -m "Stop the supplier form rejecting a lower-case GSTIN"
```

For a message with a reason underneath — which most commits deserve — leave off
`-m` and your editor opens:

```bash
git commit
```

First line under 70 characters, blank line, then **why**. The diff already says
what.

Staged the wrong thing, or want to start the commit again:

```bash
git restore --staged <file>     # unstage it, keep the edit
git restore <file>              # throw the edit away — no undo
git commit --amend              # redo the last commit, before it is pushed
```

---

## 3. Keeping the branch fresh

If your branch has been open more than a day or two, or somebody has merged
something, bring `main` into it. Fix any conflict on **your** branch, never on
`main`:

```bash
git fetch origin
git checkout main
git merge --ff-only origin/main
git checkout feat/inventory-stock-ledger
git merge main
```

To see what landed on `main` while you were away:

```bash
git log --oneline main..origin/main
git log --oneline --stat main..origin/main    # and which files it touched
```

That second one is worth running before you merge. If it touched a file your
branch also touches, you want to know now rather than at merge time.

---

## 4. Before you push

Check what you are about to send. This is the cheapest habit on this page:

```bash
git log --oneline main..HEAD        # the commits nobody has seen yet
git diff main...HEAD --stat         # every file they touch
git diff main...HEAD                # all of it, line by line
```

Look for a `.env`, a password, a key, a stray `console.log`, or a file you did
not mean to touch.

---

## 5. Pushing and raising the pull request

```bash
git push -u origin feat/inventory-stock-ledger
```

That puts the branch on GitHub. `main` is untouched. After the first time, plain
`git push` is enough.

Then open the pull request on GitHub, or from the terminal:

```bash
gh pr create --base main --head feat/inventory-stock-ledger --title "Build the stock ledger"
gh pr list
gh pr view --web
```

The description answers three things — what, how to check it, anything to watch.
The format is in [team workflow](01-team-workflow.md).

**One other person approves, and approving means they actually ran it.** To pull
somebody's branch and try it:

```bash
git fetch origin
git checkout feat/their-branch
pnpm install                # in case they added a package
```

---

## 6. Merging

The normal way is the **Squash and merge** button on GitHub. One clean commit
lands on `main`, and GitHub offers to delete the branch. Take it.

Then tidy your own machine:

```bash
git checkout main
git pull
git branch -d feat/inventory-stock-ledger        # delete the local copy
git fetch --prune                                 # forget deleted remote branches
```

### Merging from the terminal instead

If you have agreed to do it yourselves rather than through a pull request:

```bash
git checkout main
git pull
git merge --squash feat/inventory-stock-ledger
git commit                                        # writes one commit for the lot
git push
```

That last line **will be refused** — the check exists exactly for this. To go
through it anyway:

```bash
git push --no-verify
```

Do that only when the team has agreed it. The check stops the accident, not the
decision, and a push that succeeded is not the same as a push that should have
happened.

---

## 7. Getting out of trouble

**Committed to `main` by mistake, not pushed.** Move the work onto a branch
where it belongs:

```bash
git branch feat/whatever-it-was      # bookmark the commits
git reset --hard origin/main         # put main back — throws away uncommitted work
git checkout feat/whatever-it-was
```

**Need to switch branches mid-job.** Put the work down and pick it up later:

```bash
git stash -u          # -u includes files git has never seen
git checkout other-branch
# ...
git checkout -
git stash pop
git stash list        # if you forget what is in there
```

**Undo a commit but keep the edits:**

```bash
git reset --soft HEAD~1
```

**Undo a commit that is already pushed.** Do not rewrite what other people have
pulled — add a commit that reverses it:

```bash
git revert <commit-sha>
```

**Who changed this line, and why:**

```bash
git log --oneline -- path/to/file
git log -p -- path/to/file
git blame path/to/file
```

**You committed a secret.** Say so immediately, in words, to the team. Do not
quietly delete it in the next commit — it stays in the history and the key has to
be cancelled and reissued.

---

## 8. Running it while you work

Not git, but this is the page people have open.

```bash
pnpm install                      # after pulling, if package.json changed
pnpm db:generate                  # after schema.prisma changed — stop the API first
pnpm dev:api                      # API on 5000
pnpm --filter web dev             # website on 3000
```

If something else on the machine already wants port 3000, give the website its
own and there is nothing to argue about:

```bash
pnpm --filter web dev --port 3005
```

Check the API is alive at http://localhost:5000/health. To find out who is
holding a port, and stop it only if it is really ours:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess | Select-Object Id, ProcessName, Path }
```

Two things that bite: never run `pnpm build:web` while `pnpm dev:web` is running,
and stop the API before `pnpm db:generate`. Both are explained in
[running and deploying](05-running-deploying.md).
