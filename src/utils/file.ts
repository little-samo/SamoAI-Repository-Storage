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

/**
 * Ensure directory exists by creating it if it doesn't exist
 * @param dirPath Path to the directory to ensure exists
 * @returns Promise<void>
 */
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    // If the error is not about the directory already existing, re-throw it
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}
