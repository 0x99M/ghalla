/**
 * Nominal typing at zero runtime cost.
 *
 * A consequence worth knowing before you hit it: because the symbol is
 * module-private, TypeScript cannot *name* it across a package boundary. A
 * dependent package that lets a branded type be inferred into an exported
 * declaration fails with TS4023, and the fix is to annotate that export with the
 * named alias (`Minor`) rather than to weaken the brand. `@ghalla/schemas`
 * annotates its primitive schemas for exactly this reason.
 *
 * The symbol is module-private and never exported, so `Brand`'s tag cannot be
 * spelled — and therefore cannot be forged — outside the module that declares
 * the branded type. That is what turns "money is always integer minor units"
 * from a convention into a compile error: a bare `number` is not assignable to
 * `Minor`, so a platform's decimal cannot reach a canonical type without
 * passing through a checked constructor.
 */
declare const tag: unique symbol;

export type Brand<T, B> = T & { readonly [tag]: B };
