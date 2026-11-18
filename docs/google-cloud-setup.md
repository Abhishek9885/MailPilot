# Google Cloud Configuration Guide for Local Development

This guide outlines the step-by-step setup required in Google Cloud Console to run MailPilot's authentication and Gmail integration locally.

---

## 1. Architecture Overview

MailPilot strictly separates **Application Sign-In** from **Gmail Data Access**:

1. **Application Sign-in Client** (`GOOGLE_OIDC_CLIENT_ID`):
   - Scope: `openid email`
   - Purpose: Authenticates the user and establishes an application session.
   - Callback URI: `http://localhost:4000/v1/auth/google/callback`

2. **Gmail OAuth Client** (`GOOGLE_GMAIL_OAUTH_CLIENT_ID`):
   - Scope: `openid email https://www.googleapis.com/auth/gmail.readonly`
   - Purpose: Grants read-only access to messages and threads for synchronization and analysis.
   - Callback URI: `http://localhost:4000/v1/oauth/google/callback`
   - Offline Access: Requests offline refresh tokens stored with AES-256-GCM encryption.

---

## 2. Google Cloud Console Setup

### Step 1: Create or Select a Project
1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project dropdown in the top bar and click **New Project**.
3. Name your project (e.g., `MailPilot-Local-Dev`) and click **Create**.

### Step 2: Enable the Gmail API
1. Navigate to **APIs & Services** > **Library**.
2. Search for **Gmail API**.
3. Select it and click **Enable**.

### Step 3: Configure the OAuth Consent Screen
1. Navigate to **APIs & Services** > **OAuth consent screen**.
2. Select **External** user type and click **Create**.
3. Fill in the App Information:
   - **App name**: `MailPilot Dev`
   - **User support email**: Your Google email address
   - **Developer contact information**: Your Google email address
4. Click **Save and Continue**.
5. In **Scopes**:
   - Click **Add or Remove Scopes**.
   - Select `.../auth/userinfo.email` and `openid`.
   - In "Manually add scopes", enter:
     `https://www.googleapis.com/auth/gmail.readonly`
   - Click **Add to Table** and then **Update**.
6. Click **Save and Continue**.
7. In **Test Users**:
   - In "Testing" mode, only registered test users can authenticate.
   - Click **Add Users** and add your Gmail address (and any test accounts).
8. Click **Save and Continue** and return to the dashboard.

---

## 3. Creating OAuth Credentials

### Client A: App Sign-In (OIDC)
1. Go to **APIs & Services** > **Credentials**.
2. Click **Create Credentials** > **OAuth client ID**.
3. Select Application type: **Web application**.
4. Name: `MailPilot Web Sign-In (Local)`.
5. **Authorized JavaScript origins**:
   - `http://localhost:3000`
   - `http://localhost:4000`
6. **Authorized redirect URIs**:
   - `http://localhost:4000/v1/auth/google/callback`
7. Click **Create** and copy the Client ID and Client Secret.

### Client B: Gmail OAuth (Read-Only Data Access)
1. In **Credentials**, click **Create Credentials** > **OAuth client ID**.
2. Select Application type: **Web application**.
3. Name: `MailPilot Gmail Integration (Local)`.
4. **Authorized JavaScript origins**:
   - `http://localhost:3000`
   - `http://localhost:4000`
5. **Authorized redirect URIs**:
   - `http://localhost:4000/v1/oauth/google/callback`
6. Click **Create** and copy the Client ID and Client Secret.

---

## 4. Local Environment Configuration

Generate a 32-byte encryption key for refresh token encryption:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Update your `.env` file with the real values:

```env
# Google OIDC Sign-in Client
GOOGLE_OIDC_CLIENT_ID=your-oidc-client-id.apps.googleusercontent.com
GOOGLE_OIDC_CLIENT_SECRET=your-oidc-client-secret

# Google Gmail OAuth Client
GOOGLE_GMAIL_OAUTH_CLIENT_ID=your-gmail-oauth-client-id.apps.googleusercontent.com
GOOGLE_GMAIL_OAUTH_CLIENT_SECRET=your-gmail-oauth-client-secret

# 32-byte base64-encoded key for AES-256-GCM token encryption
GMAIL_TOKEN_ENCRYPTION_KEY=<generated-base64-key>
```

---

## 5. Flow Verification

### Connect Gmail:
1. Start the services: `npm run dev:all`.
2. Open `http://localhost:3000/sign-in` and sign in with Google OIDC.
3. Once in the workspace, navigate to `/settings`.
4. Trigger the Gmail connection flow:
   - Client links to `http://localhost:4000/v1/gmail/connect?returnTo=/settings`.
   - Express sets a signed state cookie and redirects to Google.
   - Google displays consent requesting read-only Gmail access.
   - Upon consent, Google redirects to `http://localhost:4000/v1/oauth/google/callback`.
   - Express validates state/PKCE, encrypts the refresh token using AES-256-GCM, stores connection metadata in PostgreSQL, and redirects to `http://localhost:3000/settings?gmail=connected`.

### Check Status:
- `GET http://localhost:4000/v1/gmail/connection` returns:
  ```json
  {
    "connection": {
      "email": "user@gmail.com",
      "status": "active",
      "grantedScopes": ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
      "connectedAt": "2026-10-28T12:00:00.000Z",
      "disconnectedAt": null,
      "lastSuccessfulSyncAt": null,
      "reauthRequired": false
    }
  }
  ```
  *(No token values or ciphertext are ever returned).*

### Disconnect Gmail:
- `DELETE http://localhost:4000/v1/gmail/connection` with CSRF cookie/header:
  - Revokes the refresh token with Google's revocation endpoint.
  - Clears `refreshTokenCiphertext`, `refreshTokenNonce`, `refreshTokenAuthTag` from the database.
  - Updates connection status to `disconnected`.

---

## 6. Security Boundaries

- **Minimal Scope**: Only `gmail.readonly` is requested. No compose, send, delete, or modify permissions exist.
- **Never Persistent in Memory/Logs**: Access tokens are kept short-lived; refresh tokens are encrypted at rest with AES-256-GCM.
- **State Integrity**: OAuth state cookies are HMAC-signed with `SESSION_SECRET` and bound to the authenticated user ID.
- **CSRF & Origin**: Disconnect mutations require both CSRF header/cookie match and verified `Origin`.

