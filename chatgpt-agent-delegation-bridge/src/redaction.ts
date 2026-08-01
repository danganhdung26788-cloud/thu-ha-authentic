const PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
  /\bAIza[0-9A-Za-z_-]{20,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
  /(?<=\b(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*)[^\s,;}"]+/giu,
  /(?<=\b(?:postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+:)[^@\s/]+(?=@)/giu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
];

export function redactSecrets(value: unknown, maxBytes = 1_048_576): string {
  let text = value instanceof Error
    ? `${value.name}: ${value.message}`
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
  for (const pattern of PATTERNS) text = text.replace(pattern, '[REDACTED]');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const suffix = '\n[TRUNCATED_BY_BRIDGE_LIMIT]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  return bytes.subarray(0, Math.max(0, maxBytes - suffixBytes)).toString('utf8').replace(/�$/u, '') + suffix;
}
