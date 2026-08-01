export function extractJsonObject(text: string): unknown {
  const trimmed = text
    .replace(/<think>[\s\S]*?<\/think>/giu, '')
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('Local model did not return a JSON object.');
  }
  const jsonText = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new Error(`Local model returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
