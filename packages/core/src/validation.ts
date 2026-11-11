/** A non-negative safe integer (timestamps, counters, revisions, limits). */
export const isNonNegativeInteger=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
