export type LegacyCronProfile = 'plan-reminder-v1' | 'automation-v1';

interface FieldSpec {
  readonly min: number;
  readonly max: number;
  readonly aliases?: Readonly<Record<string, number>>;
  readonly normalizeSunday?: boolean;
}

interface Policy {
  readonly separator: 'space' | 'whitespace';
  readonly aliases: boolean;
  readonly coercion: boolean;
  readonly singleStepRange: boolean;
  readonly boundedStep: boolean;
  readonly wildcard: 'any-star' | 'literal-star';
  readonly ignoreListedStar: boolean;
  readonly allowEmpty: boolean;
}

interface CanonicalField {
  readonly text: string | null;
  readonly wildcard: boolean;
}

const MONTHS = Object.freeze({
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
});

const DAYS = Object.freeze({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 });

const SPECS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, aliases: MONTHS },
  { min: 0, max: 7, aliases: DAYS, normalizeSunday: true },
] as const satisfies readonly FieldSpec[];

const POLICIES: Readonly<Record<LegacyCronProfile, Policy>> = Object.freeze({
  'plan-reminder-v1': {
    separator: 'space',
    aliases: false,
    coercion: false,
    singleStepRange: false,
    boundedStep: true,
    wildcard: 'any-star',
    ignoreListedStar: false,
    allowEmpty: false,
  },
  'automation-v1': {
    separator: 'whitespace',
    aliases: true,
    coercion: true,
    singleStepRange: true,
    boundedStep: false,
    wildcard: 'literal-star',
    ignoreListedStar: true,
    allowEmpty: true,
  },
});

/** Converts a released cron grammar into the current grammar without changing its match set. */
export function canonicalizeLegacyCronExpression(
  expression: string,
  profile: LegacyCronProfile,
): string {
  const policy = POLICIES[profile];
  const parts =
    policy.separator === 'space' ? expression.split(' ') : expression.trim().split(/\s+/);
  if (parts.length !== SPECS.length)
    throw new Error(`Invalid legacy cron expression: ${expression}`);
  const fields = parts.map((part, index) =>
    canonicalizeField(part ?? '', SPECS[index] as FieldSpec, policy),
  );
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    CanonicalField,
    CanonicalField,
    CanonicalField,
    CanonicalField,
    CanonicalField,
  ];
  if (minute.text === null || hour.text === null || month.text === null) {
    throw new Error(`Legacy cron expression has no canonical equivalent: ${expression}`);
  }
  if (dayOfMonth.text === null) {
    if (dayOfWeek.text === null || dayOfWeek.wildcard) {
      throw new Error(`Legacy cron expression has no canonical equivalent: ${expression}`);
    }
    fields[2] = { text: '*', wildcard: true };
  }
  if (dayOfWeek.text === null) {
    if (dayOfMonth.text === null || dayOfMonth.wildcard) {
      throw new Error(`Legacy cron expression has no canonical equivalent: ${expression}`);
    }
    fields[4] = { text: '*', wildcard: true };
  }
  return fields.map(({ text }) => text).join(' ');
}

function canonicalizeField(input: string, spec: FieldSpec, policy: Policy): CanonicalField {
  if (!policy.aliases && !/^[\d*,/\-]+$/.test(input)) throw invalidCron(input);
  const normalized = policy.aliases && spec.aliases ? translateAliases(input, spec.aliases) : input;
  const parts = normalized.split(',');
  const values = new Set<number>();
  const wildcardValues = new Set<number>();
  const wildcardTokens = new Set<string>();
  let hasWildcardBase = false;

  for (const part of parts) {
    if (part.length === 0) throw invalidCron(input);
    const stepParts = part.split('/');
    if (stepParts.length > 2 && !policy.coercion) throw invalidCron(input);
    const base = stepParts[0] ?? '';
    const hasStep = stepParts[1] !== undefined;
    const step = hasStep
      ? parseInteger(
          stepParts[1] ?? '',
          1,
          policy.boundedStep ? spec.max - spec.min + 1 : Infinity,
          policy,
        )
      : 1;
    const ignore = base === '*' && !hasStep && parts.length > 1 && policy.ignoreListedStar;
    let start: number;
    let end: number;

    if (base === '*') {
      hasWildcardBase = true;
      if (policy.wildcard === 'any-star') {
        wildcardTokens.add(hasStep ? `*/${step}` : '*');
      }
      start = spec.min;
      end = spec.max;
    } else if (base.includes('-')) {
      const range = base.split('-');
      if (range.length !== 2 && !policy.coercion) throw invalidCron(input);
      const validatedStart = parseInteger(range[0] ?? '', spec.min, spec.max, policy);
      const validatedEnd = parseInteger(range[1] ?? '', spec.min, spec.max, policy);
      if (validatedStart > validatedEnd) throw invalidCron(input);
      start = policy.coercion ? Number(range[0] ?? '') : validatedStart;
      end = policy.coercion ? Number(range[1] ?? '') : validatedEnd;
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
    } else {
      start = parseInteger(base, spec.min, spec.max, policy);
      end = hasStep && policy.singleStepRange ? spec.max : start;
    }

    if (ignore) continue;
    for (let candidate = spec.min; candidate <= spec.max; candidate += 1) {
      if (candidate < start || candidate > end || (hasStep && (candidate - start) % step !== 0))
        continue;
      const normalizedCandidate = spec.normalizeSunday === true && candidate === 7 ? 0 : candidate;
      values.add(normalizedCandidate);
      if (base === '*' && policy.wildcard === 'any-star') {
        wildcardValues.add(normalizedCandidate);
      }
    }
  }

  if (values.size === 0) {
    if (!policy.allowEmpty)
      throw new Error(`Legacy cron expression has no canonical equivalent: ${input}`);
    return { text: null, wildcard: false };
  }
  const wildcard = policy.wildcard === 'any-star' ? hasWildcardBase : normalized === '*';
  if (!wildcard) {
    return { text: [...values].sort((left, right) => left - right).join(','), wildcard };
  }
  if (policy.wildcard === 'literal-star' || wildcardTokens.has('*')) {
    return { text: '*', wildcard };
  }
  const remainder = [...values]
    .filter((value) => !wildcardValues.has(value))
    .sort((left, right) => left - right);
  return { text: [...wildcardTokens, ...remainder.map(String)].join(','), wildcard };
}

function parseInteger(input: string, min: number, max: number, policy: Policy): number {
  const value = policy.coercion ? Number.parseInt(input, 10) : Number(input);
  if ((!policy.coercion && !/^\d+$/.test(input)) || !Number.isInteger(value)) {
    throw invalidCron(input);
  }
  if (value < min || value > max) throw invalidCron(input);
  return value;
}

function translateAliases(input: string, aliases: Readonly<Record<string, number>>): string {
  return input.replace(/[a-zA-Z]+/g, (token) => {
    const value = aliases[token.toLowerCase()];
    return value === undefined ? token : String(value);
  });
}

function invalidCron(input: string): Error {
  return new Error(`Invalid legacy cron expression: ${input}`);
}
