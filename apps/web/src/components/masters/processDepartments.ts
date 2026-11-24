/*
 * The departments the floor works in: the ones with a process under Routing
 * Masters → Processes (Cutting, Stitching, Kaj Button, Packing…). Every
 * "Process" box offers only these; Accounts, HR & Admin and Store are
 * departments, not processes. The server marks each department it sends with
 * `isProcess`, so the rule lives in one place.
 *
 * A box that picks a department in its own right — who asks on a
 * requisition, the department a process belongs to — still offers them all.
 */

/** Whether a department, as the departments list sends it, is a process. */
export const isProcessDepartment = (row: Record<string, unknown>) => row.isProcess === true

/**
 * For a form's box: the processes, and the department already chosen even when
 * it is not one, so an older record shows what it holds rather than a blank.
 */
export const processOrChosen =
  (field: string) => (row: Record<string, unknown>, values: Record<string, unknown>) =>
    isProcessDepartment(row) || (Boolean(values[field]) && row.id === values[field])
