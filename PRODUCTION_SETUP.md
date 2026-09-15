# ShakTranslate — Production Setup Guide

For the developer handling the production backend deployment and the Android build. This covers two independent pieces of work:

1. **Backend** → deploy to Google Cloud Run
2. **Android app** → production build via EAS, ready for the Play Store

Read top to bottom once before starting — the order matters (the Android build needs a live backend URL to point at).

---

## 1. Access you need from the app owner

Before you can do anything below, ask for:

- **Google account added to the GCP project** with these IAM roles: `Vertex AI User`, `Cloud Run Admin`, `Service Account User`, `Secret Manager Admin` (or have the owner create the secrets ahead of time and just grant you `Secret Manager Secret Accessor`)
- **The GCP project ID** and confirmation of the region (currently `us-central1`)
- **Repo access** (the zipped source or a Git remote)
- **The real secret values** for `backend/.env` — sent through a secure channel (password manager share, not chat/email): `CLERK_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- **Expo/EAS project access** — you'll need to be added as a collaborator on the `shakfitboy` Expo account (or the project transferred to you), since `app.json` already has a fixed EAS project ID tied to that account
- If submitting to the Play Store yourself: access to the **Google Play Console** listing (or your own account added as a release manager)

> **Why no service account key file:** this GCP org has `iam.disableServiceAccountKeyCreation` enforced — you will not be able to download a JSON key, and you shouldn't need one. Everything below uses either your own Google login or a service account attached directly to Cloud Run, which is the more secure, currently-recommended pattern anyway.

---

## 2. One-time local auth setup

No key files. Run this once on your machine:

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
```

The second command lets anything running locally (like the backend on `npm run dev`) authenticate to Vertex AI as *you*, using your granted IAM role — no credentials file needed.

---

## 3. Run the backend locally (sanity check before deploying)

```bash
cd backend
npm install
cp .env.example .env
# fill in the real values sent to you separately
npm run dev
```

Confirm it starts cleanly and `GET /health` returns `OK` before moving to deployment.

---

## 4. Deploy the backend to Cloud Run

**4.1 — Create the secrets** (skip if the owner already did this):

```bash
echo -n "the-real-clerk-secret" | gcloud secrets create clerk-secret --data-file=-
echo -n "the-real-supabase-url" | gcloud secrets create supabase-url --data-file=-
echo -n "the-real-supabase-key" | gcloud secrets create supabase-key --data-file=-
```

**4.2 — Deploy:**

```bash
gcloud run deploy shaktranslate-backend \
  --source ./backend \
  --project YOUR_PROJECT_ID \
  --region us-central1 \
  --allow-unauthenticated \
  --service-account YOUR_SERVICE_ACCOUNT_EMAIL \
  --set-env-vars GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GOOGLE_CLOUD_LOCATION=us-central1 \
  --set-secrets CLERK_SECRET_KEY=clerk-secret:latest,SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-key:latest \
  --timeout 3600 \
  --session-affinity
```

Two flags are non-negotiable for this app specifically, not boilerplate:
- `--timeout 3600` — calls are long-lived WebSocket sessions, not quick HTTP requests. Cloud Run's default 5-minute timeout would cut calls off mid-conversation.
- `--session-affinity` — keeps a client's WebSocket connection pinned to the same container instance for the call's duration.

If `YOUR_SERVICE_ACCOUNT_EMAIL` doesn't exist yet:

```bash
gcloud iam service-accounts create shaktranslate-runner --display-name="ShakTranslate backend"
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:shaktranslate-runner@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

**4.3 — Note the URL Cloud Run gives you** (looks like `https://shaktranslate-backend-xxxxx.us-central1.run.app`) — you'll need it as `wss://...` in step 6. Free managed TLS is automatic.

**4.4 — (Optional) map a custom domain:**

```bash
gcloud beta run domain-mappings create --service shaktranslate-backend --domain api.yourdomain.com --region us-central1
```
Add the CNAME/A records it outputs at the domain registrar.

---

## 5. Update the app's production config

Open `eas.json` at the repo root. The `preview` and `production` profiles both currently point `EXPO_PUBLIC_WS_URL` at a stale/old backend — update both to the Cloud Run URL (or custom domain) from step 4:

```json
"production": {
  "env": {
    "EXPO_PUBLIC_WS_URL": "wss://shaktranslate-backend-xxxxx.us-central1.run.app",
    "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY": "pk_live_..."
  }
}
```

Two things to check here, not just copy-paste:
- The URL must be `wss://`, not `https://` — it's a WebSocket connection.
- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` is currently a **test** key (`pk_test_...`). For a real production release, get a production Clerk instance and key first (Clerk requires configuring your real domain in their dashboard to issue one).

Also update the CORS line in `backend/server.js` (search for `Access-Control-Allow-Origin`) from `'*'` to your actual frontend domain, once you know it.

---

## 6. Build the Android app

```bash
npm install -g eas-cli
eas login
cd shak-translate-main
eas build --platform android --profile production
```

This runs in Expo's cloud build service — no local Android SDK setup needed. It reads the `EXPO_PUBLIC_*` values straight from the `production` profile in `eas.json` (step 5), and app signing is handled automatically by EAS unless you specifically want to manage your own keystore.

Package name is already set: `com.cis.shaktranslate` (in `app.json`). Don't change this once you've published to the Play Store — Google ties your listing to it permanently.

When the build finishes, EAS gives you a download link for the `.aab` file.

---

## 7. Submit to the Play Store

```bash
eas submit --platform android --profile production
```

Needs a Google Play Console developer account ($25 one-time, if the owner doesn't already have one) and — for the very first submission — a store listing (screenshots, description, privacy policy URL) created manually in the Play Console first. `eas submit` uploads the build to an existing listing; it doesn't create one from scratch.

---

## Order of operations, start to finish

1. Get IAM access + secrets from the owner (§1)
2. `gcloud auth application-default login` (§2)
3. Run backend locally, confirm it works (§3)
4. Deploy backend to Cloud Run, note the URL (§4)
5. Point `eas.json` at that URL, swap in a production Clerk key (§5)
6. `eas build --platform android --profile production` (§6)
7. `eas submit` to the Play Store (§7)
