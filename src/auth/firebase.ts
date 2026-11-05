import { createRemoteJWKSet, jwtVerify } from "jose"
import { HttpError } from "../http.js"

/** Who Firebase says signed in. */
export type FirebaseIdentity = { uid: string; email: string; emailVerified: boolean; name: string | null }

export type VerifyIdToken = (idToken: string) => Promise<FirebaseIdentity>

// Google's public keys for Firebase Auth ID tokens (cached and rotated by jose).
const JWKS = new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")

/**
 * Verifies Firebase Auth ID tokens the way the Admin SDK does: RS256 signed by Google,
 * issued for this project, unexpired, with a subject and an email. Needs only the project id.
 */
export function firebaseVerifier(projectId: string | undefined): VerifyIdToken {
  const keys = createRemoteJWKSet(JWKS)
  return async (idToken) => {
    if (!projectId) throw new HttpError(503, "Sign-in isn't set up on this server yet")
    let payload
    try {
      ;({ payload } = await jwtVerify(idToken, keys, {
        algorithms: ["RS256"],
        issuer: `https://securetoken.google.com/${projectId}`,
        audience: projectId,
      }))
    } catch {
      throw new HttpError(401, "Your sign-in has expired. Please try again.")
    }
    const authTime = typeof payload.auth_time === "number" ? payload.auth_time : Infinity
    if (!payload.sub || authTime > Date.now() / 1000 + 60) throw new HttpError(401, "Your sign-in has expired. Please try again.")
    if (typeof payload.email !== "string" || !payload.email) throw new HttpError(400, "This account has no email address")
    return {
      uid: payload.sub,
      email: payload.email.trim().toLowerCase(),
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 40) : null,
    }
  }
}
