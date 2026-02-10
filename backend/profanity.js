/**
 * Simple profanity filter for usernames. Rejects names containing blocklisted words.
 * Words are matched as whole-word (boundaries) in lowercase.
 */

const BLOCKLIST = new Set([
  "ass", "asses", "asshole", "bastard", "bitch", "bitches", "bullshit", "crap", "cunt", "cunts",
  "damn", "dick", "dicks", "fag", "faggot", "fuck", "fucked", "fucker", "fucking", "fucks",
  "hell", "nigger", "nigga", "niggas", "penis", "piss", "pussy", "shit", "shitty", "slut",
  "whore", "wtf", "wtff",
]);

/**
 * Check if text contains any blocklisted word (whole-word match, case-insensitive).
 * @param {string} text
 * @returns {boolean}
 */
export function isProfane(text) {
  if (typeof text !== "string") return true;
  const lower = text.toLowerCase().trim();
  const len = lower.length;
  let i = 0;
  while (i < len) {
    let wordEnd = i;
    while (wordEnd < len && /\w/.test(lower[wordEnd])) wordEnd++;
    const word = lower.slice(i, wordEnd);
    if (word.length > 0 && BLOCKLIST.has(word)) return true;
    i = wordEnd + 1;
  }
  return false;
}
