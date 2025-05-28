import * as fs from 'fs/promises';

/**
 * Check if a file exists asynchronously
 * @param filePath Path to the file to check
 * @returns Promise<boolean> true if file exists, false otherwise
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
