# apps

One deployable service per platform. Each owns its adapter, its OAuth flow, its
webhook controllers and its own database — they share code, not infrastructure.

Empty in Phase 1 by design: the domain model is being agreed before an adapter
is written against it. `depcruise` and the boundary rules already cover this
directory, so the first adapter lands under enforcement rather than beside it.
