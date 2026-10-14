import { NextResponse } from "next/server";
import {
  assertOnboarded,
  OnboardingRequiredError,
} from "./status";

/** Returns a 403 response if onboarding is incomplete; otherwise null. */
export function requireOnboardedResponse(): NextResponse | null {
  try {
    assertOnboarded();
    return null;
  } catch (err) {
    if (err instanceof OnboardingRequiredError) {
      return NextResponse.json(
        { error: err.message, code: "ONBOARDING_REQUIRED" },
        { status: 403 },
      );
    }
    throw err;
  }
}
