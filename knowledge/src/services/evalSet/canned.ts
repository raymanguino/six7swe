import { EVAL_ACTIVE_SIZE } from '../../contract.js';

/**
 * The questions an owner's eval set starts from (#85), before any visitor has
 * asked anything. Visitor questions asked in enough sessions replace them,
 * least recently asked first.
 *
 * They match the backend's chat eval seeds (`backend/src/domain/chatEval`),
 * minus the follow-up there, which only makes sense after an earlier turn.
 */
export const CANNED_EVAL_QUESTIONS: readonly string[] = [
  'What do you do right now, and what does your role involve?',
  'Which programming languages and frameworks are you strongest in?',
  "Tell me about the most technically challenging project you've worked on.",
  'What experience do you have with distributed systems or scaling backends?',
  'Have you worked with cloud infrastructure, CI/CD or other DevOps tooling?',
  'Which databases have you used, and for what?',
  'Have you led a team or mentored other engineers?',
  "What's your educational background?",
  'What kind of role are you looking for next?',
  'What are you most proud of having shipped?',
].slice(0, EVAL_ACTIVE_SIZE);
