import { BFI44_QUESTIONS, Bfi44Question } from "../src/data/bfi44";

export interface BfiResponseItem {
  question_id: number;
  score: number;
}

export interface BfiQuestionnaireSubmission {
  user_id: string;
  questionnaire_type: "BFI-44";
  responses: BfiResponseItem[];
  completed_at: string;
  consent_version?: string;
  status: "completed";
}

export { BFI44_QUESTIONS };
export type { Bfi44Question };

/**
 * Validates BFI-44 response array.
 * Must contain exactly 44 items, with question_id 1..44 and score 1..5.
 */
export function validateBfi44Responses(responses: any): { isValid: boolean; error?: string } {
  if (!Array.isArray(responses)) {
    return { isValid: false, error: "responses field must be an array" };
  }

  if (responses.length !== 44) {
    return { isValid: false, error: `responses array must contain exactly 44 items (received ${responses.length})` };
  }

  const seenIds = new Set<number>();

  for (let i = 0; i < responses.length; i++) {
    const item = responses[i];
    if (!item || typeof item !== "object") {
      return { isValid: false, error: `Invalid response format at index ${i}` };
    }

    const qId = Number(item.question_id);
    const score = Number(item.score);

    if (isNaN(qId) || qId < 1 || qId > 44 || !Number.isInteger(qId)) {
      return { isValid: false, error: `Invalid question_id '${item.question_id}' at index ${i}. Must be an integer between 1 and 44.` };
    }

    if (seenIds.has(qId)) {
      return { isValid: false, error: `Duplicate question_id ${qId} found in responses.` };
    }
    seenIds.add(qId);

    if (isNaN(score) || score < 1 || score > 5 || !Number.isInteger(score)) {
      return { isValid: false, error: `Invalid score '${item.score}' for question_id ${qId}. Must be an integer between 1 and 5.` };
    }
  }

  if (seenIds.size !== 44) {
    return { isValid: false, error: "All 44 question_ids (1 to 44) must be present in the responses." };
  }

  return { isValid: true };
}

/**
 * Calculates BFI-44 OCEAN scores based on standard PhenX Toolkit key.
 * Reverse items (R = 6 - score):
 *  Extraversion: 6, 21, 31
 *  Agreeableness: 2, 12, 27, 37
 *  Conscientiousness: 8, 18, 23, 43
 *  Neuroticism: 9, 24, 34
 *  Openness: 35, 41
 */
export function calculateBfi44Scores(responses: BfiResponseItem[]) {
  const scoreMap = new Map<number, number>();
  responses.forEach(r => scoreMap.set(Number(r.question_id), Number(r.score)));

  const getScore = (id: number, isReverse: boolean): number => {
    const raw = scoreMap.get(id) ?? 3;
    return isReverse ? (6 - raw) : raw;
  };

  // Groupings
  const extraversionItems = [
    getScore(1, false), getScore(6, true), getScore(11, false), getScore(16, false),
    getScore(21, true), getScore(26, false), getScore(31, true), getScore(36, false)
  ];

  const agreeablenessItems = [
    getScore(2, true), getScore(7, false), getScore(12, true), getScore(17, false),
    getScore(22, false), getScore(27, true), getScore(32, false), getScore(37, true), getScore(42, false)
  ];

  const conscientiousnessItems = [
    getScore(3, false), getScore(8, true), getScore(13, false), getScore(18, true),
    getScore(23, true), getScore(28, false), getScore(33, false), getScore(38, false), getScore(43, true)
  ];

  const neuroticismItems = [
    getScore(4, false), getScore(9, true), getScore(14, false), getScore(19, false),
    getScore(24, true), getScore(29, false), getScore(34, true), getScore(39, false)
  ];

  const opennessItems = [
    getScore(5, false), getScore(10, false), getScore(15, false), getScore(20, false),
    getScore(25, false), getScore(30, false), getScore(35, true), getScore(40, false),
    getScore(41, true), getScore(44, false)
  ];

  const avg = (arr: number[]) => Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100;

  const extraversion = avg(extraversionItems);
  const agreeableness = avg(agreeablenessItems);
  const conscientiousness = avg(conscientiousnessItems);
  const neuroticism = avg(neuroticismItems);
  const openness = avg(opennessItems);

  return {
    extraversion, // 1.0 - 5.0
    agreeableness,
    conscientiousness,
    neuroticism,
    openness,
    normalized: {
      extraversion: Math.round(((extraversion - 1) / 4) * 100) / 100, // 0.0 - 1.0
      agreeableness: Math.round(((agreeableness - 1) / 4) * 100) / 100,
      conscientiousness: Math.round(((conscientiousness - 1) / 4) * 100) / 100,
      neuroticism: Math.round(((neuroticism - 1) / 4) * 100) / 100,
      openness: Math.round(((openness - 1) / 4) * 100) / 100
    }
  };
}
