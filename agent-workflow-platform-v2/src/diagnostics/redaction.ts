const SECRET_NAME = '(?:api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|private[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret)';

const PATTERNS: ReadonlyArray<Readonly<{ pattern: RegExp; replacement: string }>> = [
  {
    pattern: new RegExp(`(^|[\\s,{;])(${SECRET_NAME})(\\s*[:=]\\s*)([^\\s,;}]+)`, 'gimu'),
    replacement: '$1$2$3[REDACTED]',
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
    replacement: 'Bearer [REDACTED]',
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
    replacement: 'sk-[REDACTED]',
  },
  {
    pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/gu,
    replacement: 'AIza[REDACTED]',
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
    replacement: '[JWT_REDACTED]',
  },
  {
    pattern: /(postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/([^:\s/@]+):([^@\s/]+)@/giu,
    replacement: '$1://$2:[REDACTED]@',
  },
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
    replacement: '[PRIVATE_KEY_REDACTED]',
  },
  {
    pattern: /(Authorization|Cookie|Set-Cookie)(\s*:\s*)[^\r\n]+/giu,
    replacement: '$1$2[REDACTED]',
  },
];

export type RedactionResult = Readonly<{
  text: string;
  redactionCount: number;
}>;

export function redactSecrets(input: string, maxBytes = 20_480): RedactionResult {
  let text = input;
  let redactionCount = 0;
  for (const rule of PATTERNS) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      redactionCount += 1;
      const match = String(args[0]);
      return match.replace(rule.pattern, rule.replacement);
    });
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    const buffer = Buffer.from(text, 'utf8');
    text = `${buffer.subarray(0, maxBytes).toString('utf8')}\n[TRUNCATED_BY_DIAGNOSTIC_LIMIT]`;
  }
  return { text, redactionCount };
}
