import "server-only";

import { authDeps } from "@/lib/auth/routes";

import {
  createApproveSubmissionHandler,
  createDisapproveSubmissionHandler,
  createEnterQuestionHandler,
  createGetQuestionHandler,
  createSaveDraftHandler,
  createSubmitAnswerHandler,
  createUnlockThemeHandler,
} from "./handlers";

/** Production wiring: the same lazily created service-role client and validated environment as the auth routes. */
export const getQuestion = createGetQuestionHandler(authDeps);
export const enterQuestion = createEnterQuestionHandler(authDeps);
export const unlockTheme = createUnlockThemeHandler(authDeps);
export const saveDraft = createSaveDraftHandler(authDeps);
export const submitAnswer = createSubmitAnswerHandler(authDeps);
export const approveSubmission = createApproveSubmissionHandler(authDeps);
export const disapproveSubmission = createDisapproveSubmissionHandler(authDeps);
