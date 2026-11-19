// Producer framing: 36-byte UUID, 64-byte hash cursors/boundary, six safe integers,
// ten array names/brackets and booleans use < 1024 bytes. 4096 additionally covers
// the pull envelope and every separating comma, even at one record per page.
export const CHECKPOINT_PAGE_OVERHEAD = 4096;
export const checkpointBound = (bytes: number, rows: number) =>
  bytes + Math.max(1, rows) * CHECKPOINT_PAGE_OVERHEAD;

// `reserve_bytes` is already the literal encoded size the forget admission may write
// (MemoryQuotaService caps its records by it), so it is never multiplied by six.
export const futureForgetReserve = (bytes: number, keys: number) => ({
  bytes: bytes + 8 * 8192,
  rows: keys + 8,
});
