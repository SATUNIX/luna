// Errors the engine treats specially. Kept apart so templates can throw them without importing the engine.

/** The boundary cannot be verified or has been tampered with. Ends the run as failed / boundary_violation. */
export class BoundaryError extends Error {
  readonly code = "boundary_violation";
}

/** Another supervisor now owns the run. The displaced one stops without touching state or containers. */
export class LockLost extends Error {
  readonly code = "lock_lost";
  constructor() { super("the run lock is no longer held by this supervisor"); }
}
