import * as fs from 'fs/promises';
import * as path from 'path';

import { sleep } from './sleep';

const IS_WINDOWS = process.platform === 'win32';
const WINDOWS_TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_RETRIES = IS_WINDOWS ? 3 : 1;
const RENAME_RETRY_MS = 100;

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
 * On Windows, retries rename on transient EPERM/EBUSY/EACCES from antivirus
 * or delayed handle release.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string
): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;

  await fs.writeFile(tmpPath, data, 'utf-8');

  for (let attempt = 0; attempt < RENAME_MAX_RETRIES; attempt++) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable =
        IS_WINDOWS && code != null && WINDOWS_TRANSIENT_CODES.has(code);

      if (retryable && attempt < RENAME_MAX_RETRIES - 1) {
        await sleep(RENAME_RETRY_MS);
        continue;
      }

      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
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
