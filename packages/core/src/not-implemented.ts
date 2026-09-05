/**
 * A single, greppable marker for everything awaiting sign-off on the domain
 * model. When the engine is implemented this file is deleted, and the compiler
 * finds every remaining call site.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(
      `${what} is not implemented yet. The domain model is under review — see docs/0001-domain-model.md. ` +
        `Nothing may depend on this until the golden-fixture suite exists.`,
    );
    this.name = 'NotImplementedError';
  }
}
