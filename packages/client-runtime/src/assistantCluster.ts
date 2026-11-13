/** A square cell of the cluster, in percent of the frame's side. */
export interface AssistantClusterCell {
  readonly left: number;
  readonly top: number;
  readonly size: number;
}

export interface AssistantClusterLayout {
  /** One cell per face drawn, in the order the faces are given. */
  readonly faces: ReadonlyArray<AssistantClusterCell>;
  /** The "+N" cell when more faces exist than fit. */
  readonly more: { readonly cell: AssistantClusterCell; readonly count: number } | null;
}

const HALF = 48;
const FAR = 100 - HALF;
const cell = (left: number, top: number, size = HALF): AssistantClusterCell => ({
  left,
  top,
  size,
});
const GRID = [cell(0, 0), cell(FAR, 0), cell(0, FAR), cell(FAR, FAR)] as const;
const MIDDLE = (100 - HALF) / 2;

/**
 * Where each face of a group's avatar sits: one fills the frame, two sit side by side, three form a
 * triangle and four a 2×2 grid. Five or more show three faces and a "+N" cell.
 */
export function assistantClusterLayout(count: number): AssistantClusterLayout {
  if (count <= 0) return { faces: [], more: null };
  if (count === 1) return { faces: [cell(0, 0, 100)], more: null };
  if (count === 2) return { faces: [cell(0, MIDDLE), cell(FAR, MIDDLE)], more: null };
  if (count === 3) return { faces: [cell(MIDDLE, 0), cell(0, FAR), cell(FAR, FAR)], more: null };
  if (count === 4) return { faces: [...GRID], more: null };
  return { faces: GRID.slice(0, 3), more: { cell: GRID[3], count: count - 3 } };
}
