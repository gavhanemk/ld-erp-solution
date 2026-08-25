## What

<!-- One or two lines. What can the user do now that they could not before? -->

## How to check it

<!-- Numbered steps someone else can follow on their own machine. -->

1.
2.
3.

## Anything to watch

<!-- Schema changes, new settings, anything that could break something else.
     Write "nothing" if there is nothing. -->

---

### Author checklist

- [ ] Branch is named `type/module-thing` and does one job only
- [ ] No `.env`, password, key or token in this diff
- [ ] No `console.log` left behind (the API uses `logger`)
- [ ] No invented colours, fonts or sizes — [design rules](../docs/02-design-rules.md)
- [ ] Existing components reused, not rewritten
- [ ] Every new API route has `requirePermission(...)`
- [ ] Every create / update / delete calls `writeAuditLog(...)`
- [ ] Loading, empty and error states all handled
- [ ] Messages are in plain English a mill clerk can act on
- [ ] I opened it in light mode and on a narrow window
- [ ] [PROJECT_STATUS.md](../PROJECT_STATUS.md) updated if a module changed state

### Reviewer

One other person must approve, and approving means **you actually ran it** —
not that the code looks fine.
