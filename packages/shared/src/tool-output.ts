type OutputValue =
  | null
  | boolean
  | number
  | string
  | OutputValue[]
  | { [key: string]: OutputValue };
type OutputObject = { [key: string]: OutputValue };

/** Keep whole records and identifiers; never turn a clipped path into a usable result. */
export function boundStructuredContent(data: object): OutputObject {
  const output: OutputObject = JSON.parse(JSON.stringify(data));
  output.truncated = output.truncated === true;
  function compactRecord(value: OutputValue): OutputValue {
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      typeof value.id !== 'string' ||
      Buffer.byteLength(JSON.stringify(value)) <= 11 * 1024
    )
      return value;
    output.truncated = true;
    // Reserve room for the envelope; omit large fields, never clip writable content or IDs.
    return {
      ...Object.fromEntries(
        Object.entries(value).filter(
          ([key, field]) =>
            key === 'id' ||
            ((!field || typeof field !== 'object') &&
              Buffer.byteLength(JSON.stringify(field)) <= 256),
        ),
      ),
      truncated: true,
    };
  }
  for (const [key, value] of Object.entries(output)) {
    if (key === 'truncated') continue;
    if (Array.isArray(value) && value.length > 100) {
      value.length = 100;
      output.truncated = true;
    }
    output[key] = Array.isArray(value) ? value.map(compactRecord) : compactRecord(value);
  }
  while (Buffer.byteLength(JSON.stringify(output)) > 12 * 1024) {
    const largest = Object.values(output)
      .filter((value) => Array.isArray(value) && value.length > 0)
      .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!Array.isArray(largest)) {
      return {
        error:
          'Result exceeds the output limit. The operation may have completed; inspect saved state before retrying.',
        truncated: true,
      };
    }
    largest.pop();
    output.truncated = true;
  }
  return output;
}
