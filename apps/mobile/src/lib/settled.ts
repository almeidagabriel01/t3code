// React Compiler cannot lower try/finally inside components; keep them here.
export async function settled(
  work: () => Promise<unknown>,
  cleanup: () => void,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!onError) throw error;
    onError(error);
  } finally {
    cleanup();
  }
}
