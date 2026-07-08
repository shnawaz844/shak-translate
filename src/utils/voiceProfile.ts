/**
 * voiceProfile.ts
 *
 * Maps (gender, age) to a natural-language voice description that is injected
 * into the Gemini Live system instruction.  Because we use Gemini Native Audio
 * (not Google Cloud TTS), there are no pitch/rate knobs — the model itself
 * generates speech, so we describe the target voice in plain English.
 */

export type Gender = 'male' | 'female' | 'neutral';

export interface VoiceProfile {
  /** Short human-readable label shown in the onboarding UI */
  label: string;
  /**
   * Natural-language suffix appended to the Gemini system instruction so the
   * model mimics the speaker's demographic voice characteristics.
   */
  voiceInstruction: string;
}

/**
 * Derive an age-bracket description (used inside the voice instruction).
 */
function ageBracket(age: number): string {
  if (age < 13) return 'young child';
  if (age < 18) return 'teenager';
  if (age < 30) return 'young adult in their twenties';
  if (age < 45) return 'adult in their thirties or early forties';
  if (age < 60) return 'middle-aged adult in their forties or fifties';
  return 'senior adult over sixty';
}

/**
 * Build a VoiceProfile from the user's gender and age.
 *
 * The returned `voiceInstruction` is designed to be appended to the Gemini
 * system prompt so the synthesised translation sounds like it comes from a
 * speaker matching the original user's demographics.
 */
export function getVoiceProfile(gender: Gender, age: number): VoiceProfile {
  const bracket = ageBracket(age);

  const genderDesc: Record<Gender, string> = {
    female: 'female',
    male: 'male',
    neutral: 'gender-neutral',
  };

  const genderLabel: Record<Gender, string> = {
    female: 'Female',
    male: 'Male',
    neutral: 'Prefer not to say',
  };

  const voiceInstruction =
    `Your spoken output MUST sound like a ${genderDesc[gender]} ${bracket}. ` +
    `Match the natural pitch, cadence, and energy that would be typical for ` +
    `a ${genderDesc[gender]} ${bracket} native speaker of the target language. ` +
    `Do NOT change the translation content — only adapt how it sounds.`;

  return {
    label: genderLabel[gender],
    voiceInstruction,
  };
}
