import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Check if a file exists asynchronously
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const knownDirectories = new Set<string>();

/**
 * Ensure directory exists, with an in-memory cache to skip redundant syscalls.
 */
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  if (knownDirectories.has(dirPath)) {
    return;
  }
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  knownDirectories.add(dirPath);
}

/**
 * Atomically write data to a file by writing to a temp file first, then renaming.
 * Prevents data corruption if the process crashes mid-write.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string
): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmpPath, data, 'utf-8');
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Read and parse a JSON file, returning null if the file does not exist.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Atomically write a JSON-serializable object to a file.
 */
export async function writeJsonFile(
  filePath: string,
  data: unknown
): Promise<void> {
  await ensureDirectoryExists(path.dirname(filePath));
  const json = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, json);
}
