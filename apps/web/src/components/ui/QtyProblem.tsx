/**
 * The line under a quantity box that says what is wrong with it: "Decimal
 * quantities are not allowed for this item…" for 2.5 cartons. Nothing when the
 * quantity is fine. The words come from qtyProblem in @ld-erp/shared, the same
 * rule the API refuses the save with.
 */
export function QtyProblem({ text, className = '' }: { text: string | null | undefined; className?: string }) {
  if (!text) return null
  return (
    <p role="alert" className={`mt-1 text-[11px] font-medium leading-snug text-red-500 ${className}`}>
      {text}
    </p>
  )
}
