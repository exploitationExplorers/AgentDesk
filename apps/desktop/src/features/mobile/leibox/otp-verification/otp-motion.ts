/** Motion tokens for OTP pill morph — reconstructed to match LeiBox engine widths/timing. */
export const OTP_MOTION = {
  compactWidth: 202,
  expandedWidth: 374,
  verifiedWidth: 202,
  openDuration: 0.52,
  collapseDuration: 0.4,
  focusDuration: 0.22,
  errorDuration: 0.46,
  verifyDelay: 720,
  ease: "power3.inOut",
} as const;

/** Autoplay typing sequence: [offsetMs, codeSoFar][] — first pass then retry. */
export const OTP_REPLAY: Array<[number, string]> = [
  [0, "1"],
  [140, "12"],
  [280, "123"],
  [420, "1234"],
  [560, "12345"],
  [720, "123456"],
  [0, "1"],
  [160, "12"],
  [300, "129"],
  [440, "1294"],
  [580, "12941"],
  [740, "129419"],
];
