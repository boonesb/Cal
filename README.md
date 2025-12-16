# Calorie Tracker

Mobile-first calorie, carbs, and protein tracker using Firebase Authentication, Firestore, and Firebase Hosting.

## Features
- Email/password authentication with 30-minute inactivity timeout
- Daily dashboard with totals and entries per day (past/future navigation)
- Add/edit/delete entries with live totals
- Food picker with favorites-first sorting, local filtering, and inline creation when no results are found
- Foods management with favorites, edit, and delete (entries keep stored snapshots)
- Firebase Hosting deployment workflow (GitHub Actions)

## Getting started

### Prerequisites
- Node.js 18+
- Firebase project with Authentication (Email/Password) and Firestore enabled
- Firebase CLI installed locally for manual deploys

### Install dependencies
```bash
npm install
```

### Firebase configuration
Create a `.env.local` file (Vite-compatible) with your Firebase project credentials:

```
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=sender-id
VITE_FIREBASE_APP_ID=app-id
```

### Run locally
```bash
npm run dev
```
Open the printed URL (defaults to http://localhost:5173).

### Build
```bash
npm run build
```

### Deploy to Firebase Hosting
1. Update `.firebaserc` with your project id or set the `FIREBASE_PROJECT_ID` secret in GitHub Actions.
2. Add a base64-encoded Firebase service account JSON to the `FIREBASE_SERVICE_ACCOUNT` GitHub secret (or use a local `firebase login` + `firebase deploy`).
3. Push to `main` to trigger the GitHub Actions workflow or run `firebase deploy --only hosting,firestore:rules` locally.

### Firestore security rules
Rules in `firestore.rules` restrict all reads/writes to the authenticated user within their own `users/{uid}` subtree.

### Data model
- `users/{uid}/foods/{foodId}`: name, caloriesPerServing, carbsPerServing, proteinPerServing, favorite, createdAt
- `users/{uid}/entries/{date}/items/{entryId}`: foodName, servings, caloriesPerServing, carbsPerServing, proteinPerServing, createdAt

Entries store snapshot values so historical data is preserved even if foods change.

### Session timeout behavior
Any interaction (click, scroll, typing, touch) resets a 30-minute inactivity timer. When the timer elapses, the user is signed out and must log in again.

## CI/CD
A GitHub Actions workflow (`.github/workflows/deploy.yml`) installs dependencies, builds the app, and deploys to Firebase Hosting on pushes to `main`.
