import type { MotionOptions, MotionController } from "./motion-runtime";

export type OtpVerificationOptions = MotionOptions & {
  autoPlay?: boolean;
  onReplayComplete?: () => void;
  /** Return true/false (or Promise) to drive success vs error morph. */
  onVerify?: (code: string) => boolean | Promise<boolean>;
  onSuccess?: (code: string) => void;
  onError?: (code: string) => void;
};

export function mountOtpVerification(
  target: HTMLElement,
  options?: OtpVerificationOptions,
): MotionController;
