// Predefined security questions (SPEC §2.1 — password reset is captcha +
// security question). Users pick ONE by id during registration; the frontend
// renders the list from GET /api/auth/security-questions. Answers are
// normalized and bcrypt-hashed before storage, never the raw text.
//
// Ids are stable human-readable slugs, NOT runtime-generated (nanoid etc.):
// they are persisted on user documents, so they must never change between
// restarts or deploys. Add new questions freely; never remove or re-id an
// existing one while any user still references it.

export const SECURITY_QUESTIONS = [
  { id: 'mothers-maiden-name', question: "What is your mother's maiden name?" },
  { id: 'first-pet-name', question: 'What was the name of your first pet?' },
  { id: 'birth-town', question: 'What is the name of the town where you were born?' },
  { id: 'primary-school', question: 'What was the name of your primary school?' },
  { id: 'oldest-sibling-middle-name', question: "What is your oldest sibling's middle name?" },
  { id: 'first-car-make', question: 'What was the make of your first car?' },
  { id: 'maternal-grandmother', question: "What is your maternal grandmother's first name?" },
  { id: 'childhood-street', question: 'What was the street you grew up on?' },
  { id: 'childhood-nickname', question: 'What was your childhood nickname?' },
  { id: 'favourite-childhood-friend', question: 'What is the name of your favourite childhood friend?' },
];

export const SECURITY_QUESTION_IDS = SECURITY_QUESTIONS.map((q) => q.id);

export const getQuestionById = (id) => SECURITY_QUESTIONS.find((q) => q.id === id) ?? null;
