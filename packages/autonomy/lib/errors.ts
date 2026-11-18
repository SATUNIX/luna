// Errors the engine treats specially. Kept apart so templates can throw them without importing the engine.

/** The boundary cannot be verified or has been tampered with. Ends the run as failed / boundary_violation. */
export class BoundaryError extends Error {
  readonly code = "boundary_violation";
}

/**
 * A stop arrived (STOP, a signal, a pause or a cancel) while the run waited for a host-wide gate
 * slot. The acceptance it waited for is interrupted, never run; the engine ends the step as a stop,
 * not as a supervisor error, and the run stays resumable.
 */
export class GateWaitInterrupted extends Error {
  readonly code = "gate_wait_interrupted";
  constructor() { super("stop requested while waiting for a gate slot"); }
}

/** Another supervisor now owns the run. The displaced one stops without touching state or containers. */
export class LockLost extends Error {
  readonly code = "lock_lost";
  constructor() { super("the run lock is no longer held by this supervisor"); }
}
