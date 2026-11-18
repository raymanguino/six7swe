// Throwaway file for #58: a deliberate lint error (`no-debugger`) so the
// required `Lint, test and build` check goes red. This PR is never merged.
export function lintGateCheck(): void {
  debugger;
}
