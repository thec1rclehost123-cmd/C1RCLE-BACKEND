# Pass 6 auth email visual acceptance

These four previews were rendered by the actual ResendEmailSender methods with synthetic-only data and a request interceptor. The interceptor replaced fetch before any network request. The configured recipient is synthetic, the API key is a nonfunctional placeholder, and no provider request or application mutation occurred.

Review both mobile-width and desktop-width rendering in your mail client or HTML viewer. The source uses a fluid outer table and a 520px maximum-width content frame. OTP, password-reset, invitation URL, and temporary-password values are synthetic placeholders only.

- **OTP / email verification** — Your Access Key ([HTML](./previews/auth-otp.html), [text](./previews/auth-otp.txt))
- **Password reset** — Reset your password ([HTML](./previews/auth-password-reset.html), [text](./previews/auth-password-reset.txt))
- **Staff invitation** — Join Neon Nights Synthetic Venue on THE C1RCLE ([HTML](./previews/auth-staff-invitation.html), [text](./previews/auth-staff-invitation.txt))
- **Partner application changes requested** — Action needed on your C1RCLE partner application ([HTML](./previews/auth-onboarding-changes.html), [text](./previews/auth-onboarding-changes.txt))
