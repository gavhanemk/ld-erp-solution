# LD ERP — Team Handbook

Four people are building this. These files are the rules everyone follows so the
work of four people looks like the work of one.

Read them in this order. The first two are compulsory before you write any code.

| # | File | Read it when |
|---|------|--------------|
| 1 | [Team workflow](01-team-workflow.md) | Before your first commit. Branches, reviews, what never goes into `main`. |
| 2 | [Design rules](02-design-rules.md) | Before you touch any screen. Colours, fonts, buttons, spacing. |
| 3 | [Build rules](03-build-rules.md) | Before you add a module. Folder layout, naming, the patterns to copy. |
| 4 | [Business rules](04-business-rules.md) | Before you touch numbering, tax, stock or money. The things that must never break. |
| 5 | [Running and deploying](05-running-deploying.md) | To start it, fix it, back it up, put it live. |
| 6 | [Git commands](06-git-commands.md) | When you know the rule and want the line to type. Branching, pushing, merging, undoing. |

## The short version

Six rules. If you remember nothing else, remember these.

1. **Never push to `main`.** Branch, then raise a pull request.
2. **Never invent a colour, font or size.** Everything you need already exists in
   [globals.css](../apps/web/src/app/globals.css). If it does not exist, ask before adding it.
3. **Never write a screen from scratch.** `MasterTable`, `MasterFormDialog`,
   `SettingsCard`, `PrintSheet` already exist. Use them.
4. **Never build a document number yourself.** Call `nextDocumentNumber()`.
5. **Never delete a master record.** Deactivate it. Old orders point at it forever.
6. **Never commit a `.env` file, a password or an API key.**

## What this ERP is

A garment manufacturing ERP for LD Cotton Mills, Bhiwandi. It replaces a bought
product called Absolute ERP.

It is also meant to be sold to other companies later. So nothing is hard-wired to
LD Cotton Mills — no company name in code, no LD-specific rule that a different
mill could not switch off.

## Where the work stands

[PROJECT_STATUS.md](../PROJECT_STATUS.md) in the repository root is the live
picture: what is finished, what is a stub, what is next. Update it when you
finish something.
