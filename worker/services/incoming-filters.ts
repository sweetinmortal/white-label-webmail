import type { IncomingFilterRule } from '../types';

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Returns the first configured rule that matches the incoming message.
 *
 * Gmail's `from:` and `subject:` criteria are case-insensitive. Rules with
 * both criteria require both to match, just like a combined Gmail filter.
 */
export function matchIncomingFilter(
  fromEmail: string,
  subject: string,
  filters: IncomingFilterRule[] | undefined,
): IncomingFilterRule | undefined {
  if (!filters?.length) return undefined;
  const from = normalized(fromEmail);
  const normalizedSubject = normalized(subject);

  for (const rule of filters) {
    const addresses = rule.from ?? [];
    const subjectParts = rule.subjectContains ?? [];
    if (!addresses.length && !subjectParts.length) continue;
    if (addresses.length && !addresses.some((address) => normalized(address) === from)) continue;
    if (subjectParts.length && !subjectParts.some((part) => normalizedSubject.includes(normalized(part)))) continue;
    return rule;
  }

  return undefined;
}
