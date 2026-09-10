/**
 * Policy layer: shared plumbing between training rollouts, the evaluation
 * harness, and overlay inference. Nothing here depends on the overlay UI.
 */
export {
  NO_LEGAL_ACTION,
  MaskShapeError,
  applyMask,
  argmaxMasked,
  countLegal,
  isTerminalMask,
  legalActions,
  maskedActions,
  maskedSoftmax,
  randomLegalAction,
  sampleMasked,
  type ActionMasker,
} from "./masking.js";
export { maskerFor, maskedGameIds } from "./maskers/index.js";
