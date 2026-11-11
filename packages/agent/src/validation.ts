/** An identifier supplied by a host or a client (tenant, agent, run, principal, action, memory ID ...): 1 to 128 characters, starting with a letter or digit. */
export const isIdentifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
/** A non-negative safe integer (timestamps, counters, revisions, limits). */
export const isNonNegativeInteger=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
