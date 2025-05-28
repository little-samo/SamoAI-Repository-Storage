/**
 * Creates a deep copy using JSON serialization/deserialization
 */
export function deepCopy<T>(obj: T): T {
  const jsonStr = JSON.stringify(obj);
  return JSON.parse(jsonStr);
}

/**
 * Converts date strings back to Date objects in a parsed JSON object
 */
export function convertDatesToInstances<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => convertDatesToInstances(item)) as unknown as T;
  }

  if (typeof obj === 'object') {
    for (const key in obj) {
      if (
        typeof obj[key] === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj[key])
      ) {
        (obj as Record<string, unknown>)[key] = new Date(obj[key] as string);
      } else if (typeof obj[key] === 'object') {
        (obj as Record<string, unknown>)[key] = convertDatesToInstances(
          obj[key]
        );
      }
    }
  }

  return obj;
}

/**
 * Creates a deep copy of an object and converts any date strings back to Date objects
 */
export function createDeepCopy<T>(obj: T): T {
  if (!obj) return obj;
  const copy = deepCopy(obj);
  return convertDatesToInstances(copy);
}
