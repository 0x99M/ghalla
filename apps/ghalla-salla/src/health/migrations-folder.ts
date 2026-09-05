/**
 * Where the migrations shipped in this image live.
 *
 * Its own module so the token can be imported by the service without dragging
 * in the module that provides it, which would be a cycle.
 */
export const MIGRATIONS_FOLDER = Symbol('MIGRATIONS_FOLDER');
