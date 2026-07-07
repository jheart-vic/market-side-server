import { describe, it, expect } from 'vitest';
import {
  SECURITY_QUESTIONS,
  SECURITY_QUESTION_IDS,
  getQuestionById,
} from '../src/config/securityQuestions.js';

describe('predefined security questions', () => {
  it('offers exactly 10 questions with id + text', () => {
    expect(SECURITY_QUESTIONS).toHaveLength(10);
    for (const q of SECURITY_QUESTIONS) {
      expect(q.id).toMatch(/^[a-z0-9-]+$/); // stable kebab-case slugs
      expect(q.question.length).toBeGreaterThan(10);
    }
  });

  it('ids are unique (they persist on user documents)', () => {
    expect(new Set(SECURITY_QUESTION_IDS).size).toBe(SECURITY_QUESTIONS.length);
  });

  it('getQuestionById resolves known ids and null for unknown', () => {
    expect(getQuestionById('first-pet-name')).toEqual({
      id: 'first-pet-name',
      question: 'What was the name of your first pet?',
    });
    expect(getQuestionById('my-own-question')).toBeNull();
    expect(getQuestionById(undefined)).toBeNull();
  });
});
