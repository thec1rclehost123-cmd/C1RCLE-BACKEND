# Guest M2 authentication operations

## Google sign-in

Google sign-in is registered by the backend only when all three environment variables are present:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`

The Guest callback must be `https://guest.thec1rcle.com/api/auth/google/callback`. Configure that exact redirect URI in the Google OAuth client and include `https://guest.thec1rcle.com` in the backend's allowed and Better Auth trusted origins. Keep the client secret in the backend secret store; never add it to Vercel or the frontend. The Guest callback and UI use the current Guest origin and send the user to the ordinary onboarding continuation after OAuth.

If the backend provider variables or Google Console callback/origin configuration are absent, Google sign-in remains unavailable and the Guest UI directs the user to email sign-in. No credentials or console configuration are stored in this repository.

## Firebase phone verification

The application does not bypass Firebase phone proof: the Gateway verifies the Firebase ID token and matches its signed phone claim to the number being saved. `FIREBASE_AUTH_EMULATOR_HOST` is accepted only outside production and only when it points to loopback. Production Gateway configuration fails closed if this variable is set.

Firebase Console test phone numbers are configured outside this repository and their ID tokens do not carry a reliable application-visible “test number” marker. Keep synthetic numbers only in the staging/test Firebase Auth project, and ensure the production Auth project has no synthetic phone numbers configured. If staging and production share an Auth project, an owner must separate the Auth projects before staging-only synthetic phone numbers can be guaranteed. Do not commit phone numbers or OTP values.
