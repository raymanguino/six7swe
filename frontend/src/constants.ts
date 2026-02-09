// Input validation limits for security and UX
export const INPUT_LIMITS = {
  name: 100,
  email: 254,
  company: 200,
  message: 5000,
  chatMessage: 2000,
  jobDescription: 50000,
} as const;
