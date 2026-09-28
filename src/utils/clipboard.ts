/**
 * Clipboard helper â€” wraps clipboardy with graceful fallback.
 */

export async function copyToClipboard(text: string): Promise<void> {
  try {
    const { default: clipboardy } = await import("clipboardy");
    await clipboardy.write(text);
  } catch (err) {
    throw new Error(`Clipboard write failed: ${String(err)}`);
  }
}
