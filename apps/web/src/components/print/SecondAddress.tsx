/** Words a second address may already start with, saying what it is: then it prints as typed. */
const SAYS_WHAT = /^(h\.?\s*o\.?|head\s*office|regd\.?|registered|corporate|unit|works|branch|factory|office)\b/i

/**
 * The company's second address (Settings → Company → Address 2 / HO) as a
 * letterhead prints it, under the address: "HO: …", or as typed when it
 * already says what it is ("Unit 2: …", "Regd. office: …").
 */
export function SecondAddress({ text }: { text: string | null | undefined }) {
  const t = (text ?? '').trim()
  if (!t) return null
  if (SAYS_WHAT.test(t)) return <>{t}</>
  return (
    <>
      <span style={{ fontWeight: 700 }}>HO:</span> {t}
    </>
  )
}
