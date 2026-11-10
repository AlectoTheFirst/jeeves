// Classifies short spoken replies. Pure functions, no network.

export type YesNo = "allow" | "deny" | "unclear";

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const ALLOW = /^(yes|yeah|yep|yup|sure|ok|okay|allow( it)?|do it|go( ahead)?|go for it|approve(d)?|fine|please do|affirmative|of course|absolutely)\b/;
const DENY = /^(no|nope|nah|don't|do not|deny|denied|stop|cancel|never|negative|not now|skip( it)?|reject)\b/;

/** Answer to "Allow this?". A reply that starts with a clear word decides. */
export function classifyYesNo(text: string): YesNo {
  const t = normalize(text);
  if (!t) return "unclear";
  const deny = DENY.test(t);
  const allow = ALLOW.test(t);
  if (deny && !allow) return "deny";
  if (allow && !deny) return "allow";
  return "unclear";
}

/** True when the whole reply is a request to stop the current work. */
export function isStopCommand(text: string): boolean {
  return /^(stop|stop it|stop that|cancel|cancel that|abort|halt|enough|be quiet|shut up)( please)?$/.test(normalize(text));
}

const ORDINALS: Record<string, number> = {
  first: 0,
  one: 0,
  "1": 0,
  second: 1,
  two: 1,
  "2": 1,
  third: 2,
  three: 2,
  "3": 2,
  fourth: 3,
  four: 3,
  "4": 3,
  last: -1,
};

/**
 * Pick 1 option from a spoken reply. Matches an option label in the reply,
 * or an ordinal ("the second one", "option 2"). Returns the index or -1.
 */
export function matchOption(text: string, labels: readonly string[]): number {
  const t = normalize(text);
  if (!t || labels.length === 0) return -1;

  // The longest label that is in the reply wins, so "Liam Pro" beats "Liam".
  let best = -1;
  let bestLength = 0;
  labels.forEach((label, i) => {
    const l = normalize(label);
    if (l && (` ${t} `.includes(` ${l} `) || t === l) && l.length > bestLength) {
      best = i;
      bestLength = l.length;
    }
  });
  if (best >= 0) return best;

  for (const word of t.split(" ")) {
    if (word in ORDINALS) {
      const index = ORDINALS[word] < 0 ? labels.length - 1 : ORDINALS[word];
      if (index < labels.length) return index;
    }
  }
  return -1;
}
