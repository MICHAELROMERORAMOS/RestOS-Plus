# Supabase setup for RestOS+

The database schema is already present in the current RestOS+ Supabase project. The user has **not yet completed the manual Supabase Auth dashboard configuration**. Until that is done, use RestOS+ design mode.

## 1. Email provider

In the Supabase Dashboard open the **RestOS+** project, then:

`Authentication -> Sign In / Providers -> Email`

Configure:

- Email provider: enabled
- New user signups: enabled
- Confirm email: enabled
- Secure email change: enabled
- OTP expiry: 180 seconds if you want the UI's three-minute expiry to match the server

Save the provider settings.

> The frontend currently renders six OTP boxes. Keep the dashboard OTP length consistent with the UI if the project exposes an OTP-length setting. If the dashboard uses a different fixed length, update `AuthGateway.jsx` before production instead of weakening validation.

## 2. Confirm-signup email template

Open:

`Authentication -> Emails -> Templates -> Confirm signup`

The email must expose the OTP token to the user with the Supabase template variable:

```html
<h2>Verifica tu cuenta de RestOS+</h2>
<p>Introduce este código en RestOS+:</p>
<h1>{{ .Token }}</h1>
<p>Este código caduca pronto.</p>
```

Suggested subject: `Código de verificación de RestOS+`.

RestOS+ calls `verifyOtp({ email, token, type: 'email' })` after registration.

## 3. Password-recovery email template

Open:

`Authentication -> Emails -> Templates -> Reset password`

Use a manual OTP rather than relying only on a clickable recovery link:

```html
<h2>Restablecer contraseña de RestOS+</h2>
<p>Introduce este código en RestOS+:</p>
<h1>{{ .Token }}</h1>
<p>Si no solicitaste el cambio, ignora este correo.</p>
```

Suggested subject: `Restablecer contraseña de RestOS+`.

The frontend requests recovery with `resetPasswordForEmail`, verifies the token using type `recovery`, then calls `updateUser({ password })`.

## 4. Local redirect URLs

Open:

`Authentication -> URL Configuration`

During Vite development use:

```text
Site URL: http://localhost:5173
Redirect URL: http://localhost:5173/**
```

If Vite chooses another port, add that origin as an allowed redirect too.

For production, replace wildcards with the actual HTTPS application URL.

## 5. Google OAuth

Open:

`Authentication -> Sign In / Providers -> Google`

Copy the Supabase callback URL. For the current RestOS+ project it follows this form:

```text
https://qynvduumazthcxkxipkc.supabase.co/auth/v1/callback
```

In Google Auth Platform:

1. Create/select a Google Cloud project for RestOS+.
2. Configure Branding and Audience.
3. During testing, add the intended Google accounts as test users if Google requires it.
4. Keep data access to the identity scopes required for sign-in: `openid`, email and profile.
5. Create a **Web application** OAuth client.
6. Add `http://localhost:5173` under Authorized JavaScript origins.
7. Add the Supabase callback URL under Authorized redirect URIs.
8. Copy the Google Client ID and Client Secret.

Back in Supabase Google provider settings:

- Enable Google.
- Paste Client ID.
- Paste Client Secret.
- Keep nonce verification enabled unless a platform-specific implementation explicitly requires otherwise.
- Save.

## 6. Frontend `.env`

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Only the project URL and publishable key belong in the browser application. Never add a `service_role` or `sb_secret_*` key to a Vite environment variable.

## 7. Expected registration state

After a successful registration/verification, check:

`Authentication -> Users`

and:

`Table Editor -> profiles`

The profile must remain:

```text
access_status = pending
```

Email verification proves the identity; it does not authorize restaurant access.

## 8. Approval flow still to implement

The next backend workflow is the Staff/Access Requests screen. Approval will need to atomically:

1. change `profiles.access_status` from `pending` to `active`,
2. create/activate a `memberships` row,
3. assign a restaurant role,
4. assign all locations or explicit `membership_locations`,
5. record approver/time/audit event.

Until that workflow is implemented, do not treat manual profile changes as the permanent production process.

## 9. RLS status

RLS is enabled across the public schema. Bootstrap read policies already allow an authenticated user to load their own profile, membership, assigned role/permissions and restaurant/location information.

Most operational tables intentionally remain inaccessible to browser clients until module-specific RLS policies are implemented. Do not add blanket `using (true)` policies to make development easier; use design mode instead.

## 10. Password security before production

Supabase Security Advisor currently reports **Leaked Password Protection disabled**. When you can access the dashboard, open the Auth password-security settings and enable leaked-password protection before production. This prevents known compromised passwords from being accepted.

The advisor also reports operational tables with RLS enabled but no policy. That is intentional at this stage: those tables are closed to browser clients until we implement each module's real authorization rules. Do not silence that warning by adding permissive policies.
