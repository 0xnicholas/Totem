/**
 * Defender tripwire (T15) — the pattern-scan slice of ADR-0009. Tool
 * responses are scanned at the execution boundary's return path, before
 * they reach the agent. This is Tier 1 only, honestly labeled: a curated
 * set of high-precision prompt-injection directive signatures. The ML tier
 * (Tier 2) is T16; `tier: 'pattern'` in the metadata is the contract that
 * keeps the two distinguishable.
 *
 * Observe-first (ADR-0009): scanning is on by default, blocking is opt-in
 * per tenant. Metadata is attached to the action result and the audit row —
 * the operator's observation path (`totemctl query-audit`).
 */
export interface DefenderMetadata {
  /** Tier 1 (pattern scan) until T16 adds the ML classifier. */
  tier: 'pattern';
  riskLevel: 'low' | 'high';
  /** Matched signature names, present when riskLevel is high. */
  detections?: string[];
}

interface Signature {
  name: string;
  pattern: RegExp;
}

/**
 * High-precision prompt-injection directives (classic, well-attested
 * patterns). Precision over recall: benign prose about "ignoring
 * instructions" is common enough that vague patterns would flood the
 * tripwire with noise; these are the imperative directives an injected
 * document actually uses.
 */
const SIGNATURES: Signature[] = [
  { name: 'instruction-override', pattern: /ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i },
  { name: 'disregard-instructions', pattern: /disregard (all |any )?(previous|prior|above)? instructions?/i },
  { name: 'forget-instructions', pattern: /forget (everything|all (previous|prior )?instructions|your instructions)/i },
  { name: 'override-instructions', pattern: /override (all |any )?(previous|prior) (instructions|prompts?)/i },
  { name: 'stop-following', pattern: /stop following (the )?(instructions|them|your instructions)/i },
  { name: 'reveal-system-prompt', pattern: /(reveal|print|show) (me )?(the )?(system prompt|your (system )?instructions)/i },
  { name: 'jailbreak-mode', pattern: /\b(jailbreak|developer mode|unrestricted mode|unfiltered mode|do anything now)\b/i },
  { name: 'repeat-after-me', pattern: /repeat (after me|the following (instructions|text|prompt))/i },
];

/** Size guard (ADR-0009): responses above this are skipped, not claimed. */
export const DEFENDER_MAX_RESPONSE_BYTES = 1_048_576;

/**
 * Scans a unified action output for injection signatures. Returns undefined
 * when the response cannot be scanned or exceeds the size guard — the
 * contract is "no metadata = no claim made". Clean responses return
 * `{ tier: 'pattern', riskLevel: 'low' }`; a signature match returns the
 * matched names.
 */
export function scanDefender(output: unknown): DefenderMetadata | undefined {
  let serialized: string;
  try {
    const value = JSON.stringify(output);
    if (value === undefined) return undefined;
    serialized = value;
  } catch {
    return undefined;
  }
  if (serialized.length > DEFENDER_MAX_RESPONSE_BYTES) return undefined;
  const detections = SIGNATURES.filter((s) => s.pattern.test(serialized)).map((s) => s.name);
  if (detections.length === 0) return { tier: 'pattern', riskLevel: 'low' };
  return { tier: 'pattern', riskLevel: 'high', detections };
}
